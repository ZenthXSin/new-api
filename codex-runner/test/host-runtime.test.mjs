import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HostRuntime} from '../host-runtime.mjs';

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
 const original=await runtime.read(id,'README.md');assert.equal(original.content,'Host original');
 await runtime.write(id,'README.md','Host changed',original.hash);
 assert.equal(await readFile(join(project,'README.md'),'utf8'),'Host changed');
 await runtime.remove(id);assert.equal(await readFile(join(project,'README.md'),'utf8'),'Host changed');
 assert.throws(()=>runtime.registerWorkspace(randomUUID(),1,{path:'/'}));
});
