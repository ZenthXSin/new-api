import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, validateCloneUrl } from './workspace-files.mjs';
import { assertOwnerId, assertWorkspaceId, workspaceError } from './user-layout.mjs';
import { githubGitEnvironment } from './github-credentials.mjs';
import { openFileDownload } from './file-download.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT = `import json,os,platform,shutil,sys
print(json.dumps({'home':os.path.expanduser('~'),'platform':platform.system(),'architecture':platform.machine(),'python':sys.version_info[:2],'codex':shutil.which('codex'),'git':bool(shutil.which('git'))}))`;
// stdin is the checked bundle, never a shell command or a pathname from a project.
const INSTALL = `import hashlib,io,json,os,pathlib,stat,sys,tarfile,tempfile,shutil
expected=sys.argv[1]
if len(expected)!=64 or any(c not in '0123456789abcdef' for c in expected): raise ValueError('Invalid bundle')
data=sys.stdin.buffer.read(180*1024*1024+1)
if len(data)>180*1024*1024 or hashlib.sha256(data).hexdigest()!=expected: raise ValueError('Bundle verification failed')
home=pathlib.Path.home()
if pathlib.Path(sys.argv[2])==home:
 parent=pathlib.Path('/var/tmp')
 current=pathlib.Path('/')
 for part in parent.parts[1:]:
  current=current/part
  info=current.lstat()
  if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode): raise ValueError('Unsafe runtime parent')
 control=parent/('new-api-codex-'+str(os.geteuid())+'-'+hashlib.sha256(str(home).encode()).hexdigest()[:16])
 folders=[control,control/'bundles']
else:
 control=home/'.local/share/new-api-codex'
 folders=[home/'.local',home/'.local/share',control,control/'bundles']
base=control/'bundles'
for current in folders:
 try: current.mkdir(mode=0o700)
 except FileExistsError: pass
 info=current.lstat()
 if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o022: raise ValueError('Unsafe runtime directory')
 if current==control or current==base: current.chmod(0o700)
target=base/expected
allowed={'remote-workspace.py','safe-files.py','bin/codex','bin/codex-code-mode-host','bin/gh'}
with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
 members=archive.getmembers()
 if len(members)>5 or any(m.name not in allowed or not m.isfile() or m.size>400*1024*1024 for m in members) or len({m.name for m in members})!=len(members): raise ValueError('Invalid bundle members')
 if not {'remote-workspace.py','safe-files.py'}<={m.name for m in members}: raise ValueError('Incomplete bundle')
 if target.exists() or target.is_symlink():
  if target.is_symlink() or not target.is_dir() or target.stat().st_uid!=os.geteuid(): raise ValueError('Unsafe runtime bundle')
  for member in members:
   location=target/member.name
   if location.is_symlink() or not location.is_file() or hashlib.sha256(location.read_bytes()).digest()!=hashlib.sha256(archive.extractfile(member).read()).digest(): raise ValueError('Runtime bundle changed')
 else:
  temporary=pathlib.Path(tempfile.mkdtemp(prefix='.install-',dir=base))
  try:
   for member in members:
    location=temporary/member.name
    location.parent.mkdir(mode=0o700,exist_ok=True)
    with location.open('xb') as stream: shutil.copyfileobj(archive.extractfile(member),stream)
    location.chmod(0o700 if member.name.startswith('bin/') else 0o600)
   temporary.rename(target)
  finally:
   if temporary.exists(): shutil.rmtree(temporary)
print(json.dumps({'bundle':str(target)}))`;

export class RemoteRuntime {
  constructor({ dataDir, connections, command = runCommand, vendorDir = path.join(directory, 'runtime-vendor') }) {
    this.dataDir = dataDir;
    this.connections = connections;
    this.command = command;
    this.vendorDir = vendorDir;
    this.workspaces = new Map();
    this.prepared = new Map();
    this.preparing = new Map();
    this.bundles = new Map();
    this.githubCredentials = new Map();
    this.operations = new Map();
  }
  registerWorkspace(id, ownerId, remote) {
    assertWorkspaceId(id); assertOwnerId(ownerId);
    if (this.workspaces.has(id) && this.workspaces.get(id).ownerId !== ownerId) throw workspaceError('Workspace owner cannot be changed', 'owner_conflict', 409);
    if (!remote || typeof remote.connectionId !== 'string' || typeof remote.path !== 'string' || !remote.path.startsWith('/') || remote.path === '/' || remote.path.length > 1024 || /[\x00-\x1f\x7f\\]/.test(remote.path) || remote.path.split('/').some((part) => ['.', '..'].includes(part))) throw workspaceError('Specify an absolute remote project directory', 'invalid_remote_path');
    this.workspaces.set(id, { id, ownerId, remote });
  }
  unregisterWorkspace(id) { this.workspaces.delete(id); this.prepared.delete(id); }
  initialize(workspaces) { for (const workspace of workspaces) this.registerWorkspace(workspace.id, workspace.ownerId, workspace.remote); }
  entry(id) { const entry = this.workspaces.get(assertWorkspaceId(id)); if (!entry) throw workspaceError('Workspace not found', 'workspace_not_found', 404); return entry; }
  owner(id) { return this.entry(id).ownerId; }
  cwd(id) { return this.entry(id).remote.path; }
  setGitHubCredential(ownerId, credential) { if (credential) this.githubCredentials.set(ownerId, credential); else this.githubCredentials.delete(ownerId); }
  async bundle(includeBinary) {
    const key = includeBinary ? 'linux-x64' : 'helpers';
    if (!this.bundles.has(key)) this.bundles.set(key, this.buildBundle(includeBinary).catch((error) => { this.bundles.delete(key); throw error; }));
    return this.bundles.get(key);
  }
  async buildBundle(includeBinary) {
    const cache = path.join(this.dataDir, 'remote-bundles');
    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    const sources = [['remote-workspace.py', path.join(directory, 'remote-workspace.py')], ['safe-files.py', path.join(directory, 'safe-files.py')]];
    if (includeBinary) for (const name of ['codex', 'codex-code-mode-host', 'gh']) sources.push([`bin/${name}`, path.join(this.vendorDir, name)]);
    const output = path.join(cache, `${includeBinary ? 'linux-x64' : 'helpers'}.tar.gz`);
    const script = `import gzip,json,os,sys,tarfile\nr=json.load(sys.stdin)\nwith open(r['output']+'.tmp','wb') as f:\n with gzip.GzipFile(fileobj=f,mode='wb',compresslevel=1,mtime=0) as z:\n  with tarfile.open(fileobj=z,mode='w|') as t:\n   for name,source in r['sources']:\n    info=t.gettarinfo(source,arcname=name);info.uid=0;info.gid=0;info.uname='';info.gname='';info.mtime=0\n    with open(source,'rb') as s:t.addfile(info,s)\nos.chmod(r['output']+'.tmp',0o600)\nos.replace(r['output']+'.tmp',r['output'])`;
    const result = await this.command('python3', ['-I', '-c', script], { input: JSON.stringify({ output, sources }), timeoutMs: 120_000 });
    if (result.code) throw workspaceError('Remote Codex runtime package is unavailable; ask the administrator to install the pinned runtime binaries', 'remote_runtime_missing', 503);
    const bytes = await fs.readFile(output);
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
  }
  async prepare(id) {
    if (this.prepared.has(id)) return this.prepared.get(id);
    if (this.preparing.has(id)) return this.preparing.get(id);
    const pending = this.prepareRemote(id).finally(() => this.preparing.delete(id));
    this.preparing.set(id, pending);
    return pending;
  }
  async prepareRemote(id) {
    const entry = this.entry(id), { ownerId, remote } = entry;
    await this.connections.get(ownerId, remote.connectionId);
    const result = await this.connections.exec(ownerId, remote.connectionId, ['python3', '-I', '-c', PREFLIGHT], { timeoutMs: 20_000 });
    let platform;
    try { platform = JSON.parse(result.stdout); } catch { throw workspaceError('Remote development requires Python 3, Git, and a writable user home directory', 'remote_dependencies_missing', 409); }
    if (result.code || !platform.git || platform.python[0] !== 3 || platform.python[1] < 8) throw workspaceError('Remote development requires Python 3.8 or later and Git. Install these on the remote server and reconnect.', 'remote_dependencies_missing', 409);
    const includeBinary = platform.platform === 'Linux' && ['x86_64', 'amd64'].includes(platform.architecture);
    if (!includeBinary && !platform.codex) throw workspaceError('This remote architecture requires Codex CLI 0.160.0 installed in PATH; automatic installation currently supports Linux x86_64', 'remote_architecture_unsupported', 409);
    const bundle = await this.bundle(includeBinary);
    const installed = await this.connections.exec(ownerId, remote.connectionId, ['python3', '-I', '-c', INSTALL, bundle.hash, remote.path], { input: bundle.bytes, timeoutMs: 120_000, maxBytes: 256 * 1024 });
    let location;
    try { location = JSON.parse(installed.stdout).bundle; } catch { throw workspaceError('Remote runtime installation failed. Check free space and permissions in the remote user home directory.', 'remote_install_failed', 409); }
    if (installed.code || typeof location !== 'string' || !location.startsWith('/') || !location.endsWith('/' + bundle.hash) || /[\r\n\x00]/.test(location)) throw workspaceError('Remote runtime installation did not pass verification', 'remote_install_failed', 409);
    const prepared = { helper: `${location}/remote-workspace.py`, home: platform.home };
    const checked = await this.connections.exec(ownerId, remote.connectionId, ['python3', '-I', prepared.helper, 'prepare', remote.path, id], { input: '{}', timeoutMs: 20_000 });
    this.response(checked);
    this.prepared.set(id, prepared);
    return prepared;
  }
  response(result) {
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw workspaceError('Remote workspace operation failed; check the SSH connection and project permissions', 'remote_operation_failed', 502); }
    if (!value.ok) throw workspaceError(value.error || 'Remote workspace operation failed', value.code || 'remote_operation_failed', value.statusCode || 409);
    return value.result;
  }
  async operation(id, operation, request = {}, options = {}) {
    const { ownerId, remote } = this.entry(id), prepared = await this.prepare(id);
    const result = await this.connections.exec(ownerId, remote.connectionId, ['python3', '-I', prepared.helper, operation, remote.path, id], { input: JSON.stringify(request), timeoutMs: 60_000, maxBytes: 5 * 1024 * 1024, ...options });
    return this.response(result);
  }
  async create(id) { await this.prepare(id); return { id, remote: this.entry(id).remote }; }
  list(id, relativePath = '') { return this.operation(id, 'file', { operation: 'list', path: relativePath }); }
  read(id, relativePath) { return this.operation(id, 'file', { operation: 'read', path: relativePath }); }
  async download(id, relativePath, options) {
    const { ownerId, remote } = this.entry(id), prepared = await this.prepare(id);
    const child = await this.connections.spawn(ownerId, remote.connectionId, ['python3', '-I', prepared.helper, 'file', remote.path, id]);
    return openFileDownload(child, JSON.stringify({ operation: 'download', path: relativePath }), options);
  }
  write(id, relativePath, content, expectedHash) { return this.operation(id, 'file', { operation: 'write', path: relativePath, content, ...(expectedHash !== undefined ? { expectedHash } : {}) }); }
  upload(id, relativePath, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 25 * 1024 * 1024) throw workspaceError('The file exceeds the upload limit.', 'file_too_large', 413);
    return this.operation(id, 'file', { operation: 'upload', path: relativePath, data: bytes.toString('base64') });
  }
  importZip(id, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 25 * 1024 * 1024) throw workspaceError('ZIP upload exceeds 25 MiB', 'archive_too_large', 413);
    return this.operation(id, 'file', { operation: 'import', data: bytes.toString('base64') }, { timeoutMs: 100_000 });
  }
  async exportZip(id) { return Buffer.from((await this.operation(id, 'file', { operation: 'export' }, { maxBytes: 140 * 1024 * 1024, timeoutMs: 100_000 })).data, 'base64'); }
  baseline(id) { return this.operation(id, 'git', { operation: 'baseline' }, { timeoutMs: 110_000 }); }
  diff(id) { return this.operation(id, 'git', { operation: 'diff' }, { timeoutMs: 110_000 }); }
  async clone(id, value, branch) {
    const repository = typeof value === 'string' ? await validateCloneUrl(value) : value;
    if (branch && (typeof branch !== 'string' || branch.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock'))) throw workspaceError('Invalid repository branch', 'invalid_branch');
    return this.operation(id, 'git', { operation: 'clone', ...repository, ...(branch ? { branch } : {}), env: githubGitEnvironment(this.githubCredentials.get(this.owner(id))) }, { timeoutMs: 110_000 });
  }
  async remove(id) {
    // A remote project is a connection to an existing directory. Its files belong
    // to the remote user and must survive deleting the workbench project.
    await this.stopAppServer(id);
    return { deleted: true, remoteFilesPreserved: true };
  }
  async spawnAppServer(id, { env = {}, mode = 'code', processId = id } = {}) {
    const entry = this.entry(id), prepared = await this.prepare(id);
    const child = await this.connections.spawn(entry.ownerId, entry.remote.connectionId, ['python3', '-I', prepared.helper, 'app-server', entry.remote.path, id]);
    child.stdin.write(JSON.stringify({ mode, env, processId }) + '\n');
    return child;
  }
  async stopAppServer(id, { processId } = {}) {
    // Do not install software on a remote host merely to clean an unstarted task.
    if (!this.prepared.has(id)) return { stopped: true };
    return this.operation(id, 'stop', { ...(processId ? { processId } : {}) }, { timeoutMs: 20_000, maxBytes: 256 * 1024 });
  }
}

export class HybridRuntime {
  constructor(local, remote, host) { this.local = local; this.remote = remote; this.host = host; this.workspaceBytes = local.workspaceBytes; }
  async initialize(workspaces) { await this.remote.connections.initialize(); this.remote.initialize(workspaces.filter((workspace) => workspace.remote)); await this.host?.initialize(workspaces.filter((workspace) => workspace.host)); await this.local.initialize(workspaces.filter((workspace) => !workspace.remote && !workspace.host)); }
  registerWorkspace(id, ownerId, remote, host) { return host ? this.host.registerWorkspace(id, ownerId, host) : remote ? this.remote.registerWorkspace(id, ownerId, remote) : this.local.registerWorkspace(id, ownerId); }
  unregisterWorkspace(id) { return this.backend(id).unregisterWorkspace(id); }
  backend(id) { return this.host?.workspaces.has(id) ? this.host : this.remote.workspaces.has(id) ? this.remote : this.local; }
  isRemote(id) { return this.remote.workspaces.has(id); }
  isHost(id) { return Boolean(this.host?.workspaces.has(id)); }
  cwd(id) { return this.backend(id).cwd(id); }
  owner(id) { return this.backend(id).owner(id); }
  availability() { return this.local.availability(); }
  environment(ownerId) { return this.local.environment(ownerId); }
  startUser(ownerId, options) { return this.local.startUser(ownerId, options); }
  stopUser(ownerId) { return this.local.stopUser(ownerId); }
  baseline(id) { return this.backend(id).baseline(id); }
  diff(id) { return this.backend(id).diff(id); }
  clone(id, repository) { return this.backend(id).clone(id, repository); }
  spawnAppServer(id, options) { return this.backend(id).spawnAppServer(id, options); }
  stopAppServer(id, options) { return this.backend(id).stopAppServer(id, options); }
  enforceUserDiskLimit(ownerId) { return this.local.enforceUserDiskLimit(ownerId); }
  setGitHubCredential(ownerId, credential) { this.local.setGitHubCredential?.(ownerId, credential); this.remote.setGitHubCredential(ownerId, credential); this.host?.setGitHubCredential(ownerId, credential); }
}

export class HybridFiles {
  constructor(local, runtime) { this.local = local; this.runtime = runtime; }
  initialize(workspaces) { return this.local.initialize(workspaces.filter((workspace) => !workspace.remote && !workspace.host)); }
  backend(id) { return this.runtime.isHost(id) ? this.runtime.host : this.runtime.isRemote(id) ? this.runtime.remote : this.local; }
  create(id, ownerId) { return this.backend(id).create(id, ownerId); }
  list(id, relativePath) { return this.backend(id).list(id, relativePath); }
  read(id, relativePath) { return this.backend(id).read(id, relativePath); }
  download(id, relativePath, options) { return this.backend(id).download(id, relativePath, options); }
  write(id, relativePath, content, expectedHash) { return this.backend(id).write(id, relativePath, content, expectedHash); }
  upload(id, relativePath, bytes) { return this.backend(id).upload(id, relativePath, bytes); }
  importZip(id, bytes) { return this.backend(id).importZip(id, bytes); }
  exportZip(id) { return this.backend(id).exportZip(id); }
  clone(id, value, branch) { return this.backend(id).clone(id, value, branch); }
  diff(id) { return this.backend(id).diff(id); }
  remove(id) { return this.backend(id).remove(id); }
}
