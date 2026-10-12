import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runCommand } from './workspace-files.mjs';
import { assertOwnerId, assertWorkspaceId, workspaceError, workspacePaths } from './user-layout.mjs';

// The helper never executes project code. All traversal is relative to open,
// no-follow directory descriptors, including source roots and private storage.
const SNAPSHOT_HELPER = String.raw`
import datetime,fcntl,hashlib,json,os,re,stat,sys

class SnapshotError(Exception):
 def __init__(self,message,code='unsafe_snapshot_path',status=400):
  super().__init__(message);self.code=code;self.status=status

FLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
HOST_UID=os.geteuid()
RUNTIME_UID=1000 if HOST_UID==0 else HOST_UID
RUNTIME_GID=1000 if HOST_UID==0 else os.getegid()
MAX_ENTRIES=200000
MAX_DEPTH=64
UUID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
PRIVATE_NAMES={'.codex','.ssh','.aws','.azure'}
TOOLS_PRIVATE={'.git-credentials','.netrc','.npmrc','.pypirc','auth.json','.kube'}

def fail(message,code='unsafe_snapshot_path',status=400):
 raise SnapshotError(message,code,status)

def identity(info):
 return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)

def check_directory(fd,uid,private=False):
 info=os.fstat(fd)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or (private and info.st_mode&0o022):
  fail('Snapshot directory ownership or permissions are unsafe')
 return info

def open_absolute(location):
 if not isinstance(location,str) or not location.startswith('/') or location=='/' or '\x00' in location or any(part in ('.','..') for part in location.split('/')):
  fail('Invalid snapshot storage path')
 fd=os.open('/',FLAGS)
 try:
  for part in location.split('/'):
   if not part:continue
   child=os.open(part,FLAGS,dir_fd=fd);os.close(fd);fd=child
  return fd
 except:
  os.close(fd);raise

def child_directory(parent,name,create=False,uid=HOST_UID,private=True):
 if create:
  try:os.mkdir(name,0o700,dir_fd=parent)
  except FileExistsError:pass
 fd=os.open(name,FLAGS,dir_fd=parent)
 try:check_directory(fd,uid,private)
 except:os.close(fd);raise
 return fd

def stat_optional(parent,name):
 try:return os.stat(name,dir_fd=parent,follow_symlinks=False)
 except FileNotFoundError:return None

def delete_tree(parent,name):
 info=stat_optional(parent,name)
 if info is None:return
 if not stat.S_ISDIR(info.st_mode):
  os.unlink(name,dir_fd=parent);return
 fd=os.open(name,FLAGS,dir_fd=parent)
 try:
  if (os.fstat(fd).st_dev,os.fstat(fd).st_ino)!=(info.st_dev,info.st_ino):fail('Snapshot directory changed during removal')
  os.fchmod(fd,0o700)
  for entry in os.listdir(fd):delete_tree(fd,entry)
 finally:os.close(fd)
 os.rmdir(name,dir_fd=parent)

def workspace_root(data,owner,workspace,kind,allow_missing=False):
 # Only the project and this task's dedicated tools home may cross the host
 # boundary. The shared home and Codex auth/history are never opened.
 parts=[('users',HOST_UID), (str(owner),HOST_UID)]
 if kind=='project':parts += [('projects',HOST_UID),(workspace,HOST_UID)]
 else:parts += [('home',HOST_UID),('workspaces',HOST_UID),(workspace,RUNTIME_UID)]
 fd=os.dup(data)
 try:
  for name,uid in parts:
   child=child_directory(fd,name,uid=uid,private=uid==HOST_UID);os.close(fd);fd=child
  name='project' if kind=='project' else 'environment-home'
  current=stat_optional(fd,name)
  if current is None and allow_missing:return fd,name,None
  if current is None:fail('Environment filesystem is not ready','snapshot_source_missing',409)
  if not stat.S_ISDIR(current.st_mode) or current.st_uid!=RUNTIME_UID:fail('Environment filesystem root is unsafe')
  root=os.open(name,FLAGS,dir_fd=fd)
  try:
   if identity(os.fstat(root))!=identity(current):fail('Environment filesystem changed during validation','snapshot_source_changed',409)
   check_directory(root,RUNTIME_UID)
  finally:os.close(root)
  return fd,name,current
 except:
  os.close(fd);raise

def excluded(kind,parts):
 if any(part in PRIVATE_NAMES for part in parts):return True
 if kind!='tools':return False
 if parts[-1] in TOOLS_PRIVATE:return True
 return len(parts)>=2 and tuple(parts[:2]) in {('.config','gh'),('.config','gcloud'),('.docker','config.json')}

def safe_link(parts,target):
 if not target or target.startswith('/') or '\x00' in target or len(os.fsencode(target))>4096:
  fail('Snapshot contains an unsafe symbolic link','snapshot_unsafe_symlink')
 stack=list(parts[:-1])
 for part in target.split('/'):
  if part in ('','.'):continue
  if part=='..':
   if not stack:fail('Snapshot contains an escaping symbolic link','snapshot_unsafe_symlink')
   stack.pop()
  else:stack.append(part)

def validate_links(nodes):
 # Resolve against the captured tree, so individually relative links cannot
 # combine into an escape through another link (a/../outside).
 for name,node in nodes.items():
  if node[0]!='link':continue
  stack=name.split('/')[:-1];pending=node[1].split('/');followed=0
  while pending:
   part=pending.pop(0)
   if part in ('','.'):continue
   if part=='..':
    if not stack:fail('Snapshot contains an escaping symbolic link','snapshot_unsafe_symlink')
    stack.pop();continue
   candidate='/'.join(stack+[part]);target=nodes.get(candidate)
   if target and target[0]=='link':
    followed+=1
    if followed>40:fail('Snapshot contains a symbolic link cycle','snapshot_unsafe_symlink')
    pending=target[1].split('/')+pending
   else:stack.append(part)

class TreeCopy:
 def __init__(self,request,capturing):
  self.limit=request['maxSnapshotBytes'];self.capturing=capturing
  self.bytes=0;self.files=0;self.entries=0;self.digest=hashlib.sha256()
  self.secrets=[value.encode('utf-8') for value in request.get('forbiddenSecrets',[]) if value]
  self.overlap=max((len(value)-1 for value in self.secrets),default=0)

 def record(self,value):
  self.digest.update(json.dumps(value,ensure_ascii=True,separators=(',',':')).encode('ascii')+b'\n')

 def check_secrets(self,value):
  if any(secret in value for secret in self.secrets):fail('Environment contains an injected secret; remove it before publishing','snapshot_contains_secret',409)

 def tree(self,source,destination,kind,parts=(),nodes=None):
  if nodes is None:nodes={}
  before=check_directory(source,RUNTIME_UID if self.capturing else HOST_UID)
  if len(parts)>MAX_DEPTH:fail('Environment exceeds the snapshot depth limit','snapshot_too_large',413)
  for name in sorted(os.listdir(source)):
   next_parts=parts+(name,)
   if self.capturing and excluded(kind,next_parts):continue
   self.check_secrets(os.fsencode('/'.join(next_parts)))
   self.entries+=1
   if self.entries>MAX_ENTRIES or len(os.fsencode('/'.join(next_parts)))>4096:
    fail('Environment exceeds the snapshot file limit','snapshot_too_large',413)
   current=os.stat(name,dir_fd=source,follow_symlinks=False)
   if current.st_uid!=(RUNTIME_UID if self.capturing else HOST_UID):
    fail('Snapshot source contains a file owned outside the workspace','snapshot_unsafe_owner')
   relative='/'.join(next_parts);label=kind+'/'+relative
   if stat.S_ISDIR(current.st_mode):
    src=os.open(name,FLAGS,dir_fd=source)
    try:
     if identity(os.fstat(src))!=identity(current):fail('Snapshot source changed during capture','snapshot_source_changed',409)
     os.mkdir(name,0o700,dir_fd=destination);dst=os.open(name,FLAGS,dir_fd=destination)
     try:
      nodes[relative]=('directory',None);self.record([label,'directory'])
      self.tree(src,dst,kind,next_parts,nodes)
      os.fsync(dst)
     finally:os.close(dst)
    finally:os.close(src)
   elif stat.S_ISREG(current.st_mode):
    if current.st_nlink!=1:fail('Snapshot contains a hard-linked file','snapshot_unsafe_hardlink')
    if current.st_size>self.limit-self.bytes:fail('Environment exceeds the snapshot size limit','snapshot_too_large',413)
    src=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=source)
    try:
     if identity(os.fstat(src))!=identity(current):fail('Snapshot source changed during capture','snapshot_source_changed',409)
     dst=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=destination)
     try:
      digest=hashlib.sha256();copied=0;tail=b''
      while True:
       chunk=os.read(src,1024*1024)
       if not chunk:break
       self.bytes+=len(chunk);copied+=len(chunk)
       if self.bytes>self.limit:fail('Environment exceeds the snapshot size limit','snapshot_too_large',413)
       if self.secrets:
        window=tail+chunk
        self.check_secrets(window)
        tail=window[-self.overlap:] if self.overlap else b''
       digest.update(chunk)
       pending=memoryview(chunk)
       while pending:pending=pending[os.write(dst,pending):]
      if copied!=current.st_size or identity(os.fstat(src))!=identity(current):fail('Snapshot source changed during capture','snapshot_source_changed',409)
      executable=current.st_mode&0o111
      os.fchmod(dst,0o400|executable if self.capturing else 0o644|executable)
      os.fsync(dst)
      self.record([label,'file',executable,copied,digest.hexdigest()]);nodes[relative]=('file',None);self.files+=1
     finally:os.close(dst)
    finally:os.close(src)
   elif stat.S_ISLNK(current.st_mode):
    target=os.readlink(name,dir_fd=source)
    self.check_secrets(os.fsencode(target))
    if identity(os.stat(name,dir_fd=source,follow_symlinks=False))!=identity(current):fail('Snapshot source changed during capture','snapshot_source_changed',409)
    safe_link(next_parts,target);os.symlink(target,name,dir_fd=destination)
    nodes[relative]=('link',target);self.record([label,'link',target]);self.files+=1
   else:fail('Snapshot contains a special file','snapshot_unsafe_file')
  if identity(os.fstat(source))!=identity(before):fail('Snapshot source changed during capture','snapshot_source_changed',409)
  if not parts:validate_links(nodes)

 def manifest(self):return {'bytes':self.bytes,'files':self.files,'digest':self.digest.hexdigest()}

def runtime_ownership(root):
 for name in os.listdir(root):
  info=os.stat(name,dir_fd=root,follow_symlinks=False)
  if stat.S_ISDIR(info.st_mode):
   child=os.open(name,FLAGS,dir_fd=root)
   try:runtime_ownership(child)
   finally:os.close(child)
  else:os.chown(name,RUNTIME_UID,RUNTIME_GID,dir_fd=root,follow_symlinks=False)
 os.fchmod(root,0o755);os.fchown(root,RUNTIME_UID,RUNTIME_GID)

def immutable_directories(root):
 for name in os.listdir(root):
  if stat.S_ISDIR(os.stat(name,dir_fd=root,follow_symlinks=False).st_mode):
   child=os.open(name,FLAGS,dir_fd=root)
   try:immutable_directories(child)
   finally:os.close(child)
 os.fchmod(root,0o500)

def read_manifest(version,request):
 fd=os.open('manifest.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=version)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=HOST_UID or info.st_nlink!=1 or info.st_size>65536:fail('Snapshot manifest is unsafe','snapshot_corrupt',409)
  with os.fdopen(os.dup(fd),'r',encoding='utf-8') as stream:value=json.load(stream)
 finally:os.close(fd)
 if not isinstance(value,dict) or value.get('schema')!=1 or any(value.get(key)!=request[key] for key in ('ownerId','environmentId','version')):
  fail('Snapshot manifest does not match this environment','snapshot_corrupt',409)
 if type(value.get('bytes')) is not int or value['bytes']<0 or type(value.get('files')) is not int or value['files']<0 or not re.fullmatch(r'[0-9a-f]{64}',str(value.get('digest',''))) or not isinstance(value.get('createdAt'),str):
  fail('Snapshot manifest is invalid','snapshot_corrupt',409)
 return {key:value[key] for key in ('bytes','files','digest','createdAt')}

def capture(data,versions,request):
 name=str(request['version']);staged='.capture-'+request['operationId']
 if stat_optional(versions,name) is not None:fail('This environment version is already published','snapshot_exists',409)
 os.mkdir(staged,0o700,dir_fd=versions);stage=os.open(staged,FLAGS,dir_fd=versions)
 try:
  os.mkdir('snapshot',0o700,dir_fd=stage);snapshot=os.open('snapshot',FLAGS,dir_fd=stage)
  copier=TreeCopy(request,True)
  try:
   for kind in ('project','tools'):
    parent,leaf,before=workspace_root(data,request['ownerId'],request['workspaceId'],kind)
    try:
     source=os.open(leaf,FLAGS,dir_fd=parent)
     try:
      if identity(os.fstat(source))!=identity(before):fail('Snapshot source changed during capture','snapshot_source_changed',409)
      os.mkdir(kind,0o700,dir_fd=snapshot);destination=os.open(kind,FLAGS,dir_fd=snapshot)
      try:copier.tree(source,destination,kind)
      finally:os.close(destination)
     finally:os.close(source)
     if identity(os.stat(leaf,dir_fd=parent,follow_symlinks=False))!=identity(before):fail('Snapshot source changed during capture','snapshot_source_changed',409)
    finally:os.close(parent)
   immutable_directories(snapshot);os.fsync(snapshot)
  finally:os.close(snapshot)
  result={**copier.manifest(),'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')}
  manifest={**result,'schema':1,'ownerId':request['ownerId'],'environmentId':request['environmentId'],'version':request['version']}
  fd=os.open('manifest.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400,dir_fd=stage)
  with os.fdopen(fd,'w',encoding='utf-8') as stream:json.dump(manifest,stream,separators=(',',':'));stream.flush();os.fsync(stream.fileno())
  os.fchmod(stage,0o500);os.fsync(stage)
  os.rename(staged,name,src_dir_fd=versions,dst_dir_fd=versions);os.fsync(versions)
  return result
 finally:
  os.close(stage);delete_tree(versions,staged)

def restore(data,store,version,request):
 manifest=read_manifest(version,request)
 if manifest['bytes']>request['maxSnapshotBytes']:fail('Environment exceeds the snapshot size limit','snapshot_too_large',413)
 parent_roots=[];restores=child_directory(store,'.restores',create=True)
 name=request['operationId'];os.mkdir(name,0o700,dir_fd=restores);stage=os.open(name,FLAGS,dir_fd=restores)
 moved=[];installed=[];keep_backup=False
 try:
  for kind in ('project','tools'):
   parent,leaf,current=workspace_root(data,request['ownerId'],request['workspaceId'],kind,allow_missing=True)
   parent_roots.append((kind,parent,leaf,current))
  snapshot=child_directory(version,'snapshot')
  try:
   if sorted(os.listdir(snapshot))!=['project','tools']:fail('Snapshot filesystem is incomplete','snapshot_corrupt',409)
   copier=TreeCopy(request,False)
   for kind,parent,leaf,current in parent_roots:
    source=child_directory(snapshot,kind);os.mkdir(kind,0o700,dir_fd=stage);destination=os.open(kind,FLAGS,dir_fd=stage)
    try:copier.tree(source,destination,kind);os.fsync(destination)
    finally:os.close(source);os.close(destination)
   if copier.manifest()!={key:manifest[key] for key in ('bytes','files','digest')}:fail('Snapshot filesystem verification failed','snapshot_corrupt',409)
  finally:os.close(snapshot)
  for kind,parent,leaf,current in parent_roots:
   destination=os.open(kind,FLAGS,dir_fd=stage)
   try:runtime_ownership(destination)
   finally:os.close(destination)
  # Copy and verify both trees before touching either existing destination.
  # Roots are renamed, never merged through a task-controlled symlink.
  for kind,parent,leaf,current in parent_roots:
   latest=stat_optional(parent,leaf)
   if (latest is None)!=(current is None) or latest is not None and identity(latest)!=identity(current):fail('Restore destination changed','snapshot_destination_changed',409)
   if current is not None:
    os.rename(leaf,kind+'-previous',src_dir_fd=parent,dst_dir_fd=stage);moved.append((kind,parent,leaf))
   os.rename(kind,leaf,src_dir_fd=stage,dst_dir_fd=parent);installed.append((kind,parent,leaf));os.fsync(parent)
  return manifest
 except:
  try:
   for kind,parent,leaf in reversed(installed):os.rename(leaf,kind,src_dir_fd=parent,dst_dir_fd=stage)
   for kind,parent,leaf in reversed(moved):os.rename(kind+'-previous',leaf,src_dir_fd=stage,dst_dir_fd=parent)
  except:
   keep_backup=True
   fail('Restore could not be rolled back; recovery files were retained privately','snapshot_restore_recovery_required',500)
  raise
 finally:
  for kind,parent,leaf,current in parent_roots:os.close(parent)
  os.close(stage)
  try:
   if not keep_backup:delete_tree(restores,name)
  finally:os.close(restores)

def execute(request):
 data=open_absolute(request['dataDir']);store=None;lock=None;owner=None;environment=None;versions=None
 try:
  check_directory(data,HOST_UID,True)
  store=child_directory(data,'cloud-environment-snapshots',create=True)
  if request['operation']=='initialize':return {'initialized':True}
  if type(request.get('ownerId')) is not int or request['ownerId']<=0 or not UUID.fullmatch(request.get('environmentId','')) or not UUID.fullmatch(request.get('operationId','')):
   fail('Invalid snapshot identity','invalid_snapshot')
  locks=child_directory(store,'.locks',create=True)
  try:
   lock=os.open(str(request['ownerId'])+'-'+request['environmentId'],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=locks)
   info=os.fstat(lock)
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=HOST_UID or info.st_nlink!=1 or info.st_mode&0o077:fail('Snapshot lock is unsafe')
   fcntl.flock(lock,fcntl.LOCK_EX)
  finally:os.close(locks)
  operation=request['operation'];creating=operation=='capture'
  if not creating and stat_optional(store,str(request['ownerId'])) is None:
   if operation in ('remove','removeVersion','cleanup'):return {'deleted':True}
   fail('Published environment filesystem not found','snapshot_not_found',404)
  owner=child_directory(store,str(request['ownerId']),create=creating)
  if not creating and stat_optional(owner,request['environmentId']) is None:
   if operation in ('remove','removeVersion','cleanup'):return {'deleted':True}
   fail('Published environment filesystem not found','snapshot_not_found',404)
  if operation=='remove':delete_tree(owner,request['environmentId']);os.fsync(owner);return {'deleted':True}
  environment=child_directory(owner,request['environmentId'],create=creating)
  versions=child_directory(environment,'versions',create=creating)
  if operation=='cleanup':delete_tree(versions,'.capture-'+request['operationId']);return {'cleaned':True}
  if type(request.get('version')) is not int or request['version']<=0:fail('Invalid snapshot version','invalid_snapshot')
  if operation=='removeVersion':delete_tree(versions,str(request['version']));os.fsync(versions);return {'deleted':True}
  if operation=='capture':return capture(data,versions,request)
  if stat_optional(versions,str(request['version'])) is None:fail('Published environment filesystem not found','snapshot_not_found',404)
  version=child_directory(versions,str(request['version']))
  try:
   if operation=='inspect':return read_manifest(version,request)
   if operation=='restore':return restore(data,store,version,request)
   fail('Invalid snapshot operation','invalid_snapshot')
  finally:os.close(version)
 finally:
  for fd in (versions,environment,owner,lock,store,data):
   if fd is not None:os.close(fd)

try:
 request=json.load(sys.stdin)
 print(json.dumps({'ok':True,'result':execute(request)},separators=(',',':')))
except SnapshotError as error:
 print(json.dumps({'ok':False,'error':str(error),'code':error.code,'statusCode':error.status},separators=(',',':')))
except (OSError,ValueError,TypeError,KeyError):
 # Never return filesystem names or exception details: a malicious filename
 # can itself contain a credential, and host paths are not public API data.
 print(json.dumps({'ok':False,'error':'Snapshot filesystem validation failed','code':'unsafe_snapshot_path','statusCode':409},separators=(',',':')))
`;

export class CloudSnapshots {
  constructor({ dataDir, maxSnapshotBytes = 4 * 1024 ** 3 }) {
    if (typeof dataDir !== 'string' || !dataDir || !Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > 64 * 1024 ** 3) throw workspaceError('Invalid snapshot storage configuration', 'invalid_snapshot');
    this.dataDir = path.resolve(dataDir);
    this.maxSnapshotBytes = maxSnapshotBytes;
  }

  async operation(operation, request = {}) {
    const result = await runCommand('python3', ['-I', '-c', SNAPSHOT_HELPER], {
      input: JSON.stringify({ ...request, operation, dataDir: this.dataDir, maxSnapshotBytes: this.maxSnapshotBytes }),
      timeoutMs: 300_000,
      maxBytes: 64 * 1024,
    });
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw workspaceError('Snapshot operation failed', 'snapshot_operation_failed', 500); }
    if (result.code || !response.ok) throw workspaceError(response.error || 'Snapshot operation failed', response.code || 'snapshot_operation_failed', response.statusCode || 500);
    return response.result;
  }

  identity(ownerId, environmentId, version) {
    assertOwnerId(ownerId);
    assertWorkspaceId(environmentId);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw workspaceError('Invalid snapshot version', 'invalid_snapshot');
    return { ownerId, environmentId, ...(version !== undefined ? { version } : {}), operationId: randomUUID() };
  }

  workspace(ownerId, projectPath, toolsPath) {
    if (typeof projectPath !== 'string' || typeof toolsPath !== 'string') throw workspaceError('Snapshot requires an environment project and tools home', 'invalid_snapshot');
    const workspaceId = path.basename(path.dirname(projectPath));
    assertWorkspaceId(workspaceId);
    const expected = workspacePaths(this.dataDir, workspaceId, ownerId);
    if (projectPath !== expected.projectPath || toolsPath !== path.join(expected.workspaceHomePath, 'environment-home')) throw workspaceError('Snapshot paths must belong to the same environment workspace', 'unsafe_snapshot_path');
    return { workspaceId };
  }

  initialize() { return this.operation('initialize'); }

  async capture({ ownerId, environmentId, version, projectPath, toolsPath, forbiddenSecrets = [] }) {
    const request = { ...this.identity(ownerId, environmentId, version), ...this.workspace(ownerId, projectPath, toolsPath) };
    if (!Number.isSafeInteger(version) || version < 1) throw workspaceError('Invalid snapshot version', 'invalid_snapshot');
    if (!Array.isArray(forbiddenSecrets) || forbiddenSecrets.length > 256 || forbiddenSecrets.some((secret) => typeof secret !== 'string' || Buffer.byteLength(secret) > 65536) || forbiddenSecrets.reduce((size, secret) => size + Buffer.byteLength(secret), 0) > 1024 * 1024) throw workspaceError('Invalid snapshot secret checks', 'invalid_snapshot');
    try { return await this.operation('capture', { ...request, forbiddenSecrets: [...new Set(forbiddenSecrets.filter(Boolean))] }); }
    catch (error) {
      // This also removes a private unfinished tree after the helper was killed
      // by a timeout. The per-environment filesystem lock waits for it to exit.
      await this.operation('cleanup', request).catch(() => {});
      throw error;
    }
  }

  restore({ ownerId, environmentId, version, projectPath, toolsPath }) {
    if (!Number.isSafeInteger(version) || version < 1) throw workspaceError('Invalid snapshot version', 'invalid_snapshot');
    return this.operation('restore', { ...this.identity(ownerId, environmentId, version), ...this.workspace(ownerId, projectPath, toolsPath) });
  }

  inspect({ ownerId, environmentId, version }) {
    if (!Number.isSafeInteger(version) || version < 1) throw workspaceError('Invalid snapshot version', 'invalid_snapshot');
    return this.operation('inspect', this.identity(ownerId, environmentId, version));
  }

  removeVersion({ ownerId, environmentId, version }) {
    if (!Number.isSafeInteger(version) || version < 1) throw workspaceError('Invalid snapshot version', 'invalid_snapshot');
    return this.operation('removeVersion', this.identity(ownerId, environmentId, version));
  }

  remove(ownerId, environmentId) { return this.operation('remove', this.identity(ownerId, environmentId)); }
}
