import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HostRuntime} from '../host-runtime.mjs';
import {runCommand} from '../workspace-files.mjs';

test('host file operations modify the chosen host directory and keep files on project deletion',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'codex-host-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project');await mkdir(project);await writeFile(join(project,'README.md'),'Host original');
 const runtime=new HostRuntime({dataDir:join(root,'control'),home:root});
 const id=randomUUID();runtime.registerWorkspace(id,1,{path:project});
 // The transport and real file helpers are exercised; binary installation is
 // covered by the remote runtime package tests and needs no model request here.
 runtime.prepared.set(id,{helper:fileURLToPath(new URL('../remote-workspace.py',import.meta.url))});
 const created=await runtime.create(id);assert.deepEqual(created.host,{path:project});
 await runtime.baseline(id);
 const original=await runtime.read(id,'README.md');assert.equal(original.content,'Host original');
 await runtime.write(id,'README.md','Host changed',original.hash);
 assert.equal(await readFile(join(project,'README.md'),'utf8'),'Host changed');
 const diff=await runtime.diff(id);assert.match(diff.diff,/Host changed/);
 await runtime.remove(id);assert.equal(await readFile(join(project,'README.md'),'utf8'),'Host changed');
 assert.throws(()=>runtime.registerWorkspace(randomUUID(),1,{path:'/'}));
});

test('host home projects start without snapshotting server files and nested uninitialized repositories',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'codex-host-home-test-'));
 const controlParent=join(root,'control-parent');await mkdir(controlParent);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home');await mkdir(home);
 await writeFile(join(home,'server.txt'),'Host original');
 const nested=join(home,'empty-repository');await mkdir(nested);
 const initialized=await runCommand('git',['init',nested]);assert.equal(initialized.code,0);
 const runtime=new HostRuntime({dataDir:join(root,'control'),home,command:(cmd,args,settings)=>runCommand(cmd,args,{...settings,env:{...settings.env,NEW_API_CODEX_REMOTE_CONTROL_PARENT:controlParent}})});
 const id=randomUUID();runtime.registerWorkspace(id,1,{path:home+'/'});
 runtime.prepared.set(id,{home,helper:fileURLToPath(new URL('../remote-workspace.py',import.meta.url))});
 await runtime.create(id);
 const baseline=await runtime.baseline(id);assert.equal(baseline.ready,true);assert.equal(baseline.tracked,false);
 const original=await runtime.read(id,'server.txt');await runtime.write(id,'server.txt','Host changed',original.hash);
 assert.equal(await readFile(join(home,'server.txt'),'utf8'),'Host changed');
 await assert.rejects(runtime.diff(id),{code:'host_home_diff_unavailable'});
 await assert.rejects(stat(join(nested,'.git/index')),{code:'ENOENT'});
});
