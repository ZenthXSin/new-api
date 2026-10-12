import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRunnerServer } from '../server.mjs';
import { WorkspaceStore } from '../store.mjs';
import { WorkspaceFiles } from '../workspace-files.mjs';
import { openFileDownload } from '../file-download.mjs';

test('HTTP artifact downloads preserve original binary data, filenames and ownership', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-download-http-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new WorkspaceStore({ dataDir });
  const project = store.create(1, { name: 'Artifact', model: 'fixture', effort: 'medium', mode: 'code' });
  const files = new WorkspaceFiles({ dataDir });
  const { projectPath } = await files.create(project.workspace.id, 1);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 0xff);
  bytes[0] = 0x50; bytes[1] = 0x4b; bytes[2] = 0;
  await fs.writeFile(path.join(projectPath, '构建.ipa'), bytes);
  const key = 'artifact-route-fixture-service-key-over-32-characters';
  const server = createRunnerServer({ manager: { store, files, sanitize: value => value }, key });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/workspaces/${project.workspace.id}/download?path=${encodeURIComponent('构建.ipa')}`;
  const headers = { 'X-Codex-Runner-Key': key, 'X-Codex-Admin-Id': '1' };
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert(response.headers.get('content-disposition').includes("filename*=UTF-8''" + encodeURIComponent('构建.ipa')));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const hidden = await fetch(url, { headers: { ...headers, 'X-Codex-Admin-Id': '2' } });
  assert.equal(hidden.status, 404);
  const missing = await fetch(url.replace(encodeURIComponent('构建.ipa'), 'missing'), { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'not_found');
  const unauthorized = await fetch(url);
  assert.equal(unauthorized.status, 401);
});

test('canceling a stalled artifact stream terminates the file process', async () => {
  const child = spawn('python3', ['-I', '-c', 'import json,time;print(json.dumps({"ok":True,"result":{"size":100}}),flush=True);time.sleep(300)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const download = await openFileDownload(child, '{}');
  download.stream.destroy();
  await closed;
  assert.equal(child.signalCode, 'SIGKILL');
});

test('a failed file process cannot complete a download even if it emitted the declared byte count', async () => {
  const child = spawn('python3', ['-I', '-c', 'import json,sys;print(json.dumps({"ok":True,"result":{"size":4}}),flush=True);sys.stdout.buffer.write(b"data");sys.stdout.buffer.flush();sys.exit(1)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const download = await openFileDownload(child, '{}');
  await assert.rejects(async () => { for await (const chunk of download.stream) assert.fail('An unchecked final chunk must not be delivered'); }, { code: 'download_interrupted' });
});
