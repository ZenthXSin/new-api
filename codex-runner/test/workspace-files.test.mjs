import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { WorkspaceFiles, runCommand, validateCloneUrl } from '../workspace-files.mjs';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'new-api-codex-files-'));
  directories.push(dataDir);
  const files = new WorkspaceFiles({ dataDir });
  const id = randomUUID();
  const paths = await files.create(id, 1);
  return { files, id, ...paths };
}
async function zip(entries) {
  const result = await runCommand('python3', ['-I', '-c', 'import base64,io,json,stat,sys,zipfile\nb=io.BytesIO()\nz=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED)\nfor e in json.load(sys.stdin):\n i=zipfile.ZipInfo(e["name"]);i.external_attr=((stat.S_IFLNK|0o777) if e.get("symlink") else (stat.S_IFREG|0o644))<<16;z.writestr(i,e.get("content",""))\nz.close();print(base64.b64encode(b.getvalue()).decode())'], { input: JSON.stringify(entries) });
  assert.equal(result.code, 0);
  return Buffer.from(result.stdout.trim(), 'base64');
}

test('editable UTF-8 files require the current hash and preserve directory ownership', async () => {
  const { files, id, homePath, projectPath } = await fixture();
  assert.equal((await fs.stat(path.join(homePath, 'workspaces', id, '.codex'))).isDirectory(), true);
  const created = await files.write(id, 'src/你好.ts', 'export const value = 0;\n', null);
  assert.equal(created.content, 'export const value = 0;\n');
  assert.deepEqual(await files.read(id, 'src/你好.ts'), created);
  await assert.rejects(files.write(id, 'src/你好.ts', 'overwrite', null), { statusCode: 409 });
  await assert.rejects(files.write(id, 'src/你好.ts', 'overwrite'), { code: 'hash_required' });
  await files.write(id, 'src/你好.ts', 'updated', created.hash);
  assert.equal((await files.read(id, 'src/你好.ts')).content, 'updated');
  if (process.getuid?.() === 0) assert.equal((await fs.stat(path.join(projectPath, 'src'))).uid, 1000);
});

test('parallel editors cannot both commit using the same original hash', async () => {
  const { files, id } = await fixture();
  const original = await files.write(id, 'test.txt', 'old', null);
  const outcomes = await Promise.allSettled([files.write(id, 'test.txt', 'first', original.hash), files.write(id, 'test.txt', 'second', original.hash)]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'file_conflict');
});

test('traversal, .git, symlinks and non-regular files never expose host contents', async () => {
  const { files, id, projectPath, root } = await fixture();
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, 'host secret');
  await fs.symlink(secret, path.join(projectPath, 'link'));
  await fs.symlink(root, path.join(projectPath, 'folder'));
  for (const unsafe of ['../secret', '/etc/passwd', '.git/config', 'folder/secret', 'link', 'x/../../secret', 'a\\b']) {
    await assert.rejects(files.read(id, unsafe));
    await assert.rejects(files.write(id, unsafe, 'changed', null));
  }
  assert.equal(await fs.readFile(secret, 'utf8'), 'host secret');
  assert.equal((await files.list(id)).entries.length, 0);
});

test('binary and oversized files return explicit errors without rewriting content', async () => {
  const { files, id, projectPath } = await fixture();
  await fs.writeFile(path.join(projectPath, 'binary'), Buffer.from([0xff, 0x00]));
  await assert.rejects(files.read(id, 'binary'), { statusCode: 415 });
  await assert.rejects(files.write(id, 'too-big', 'x'.repeat(1024 * 1024 + 1), null), { statusCode: 413 });
  assert.equal((await files.list(id)).entries.length, 1);
});

test('ZIP import preserves Unicode, blocks collisions, and never partially imports invalid archives', async () => {
  const { files, id } = await fixture();
  const good = await zip([{ name: '项目/main.ts', content: 'console.log("你好")' }]);
  assert.deepEqual(await files.importZip(id, good), { files: 1, bytes: Buffer.byteLength('console.log("你好")') });
  assert.equal((await files.read(id, '项目/main.ts')).content, 'console.log("你好")');
  for (const invalid of [
    [{ name: 'new.txt', content: 'new' }, { name: '../escape', content: 'bad' }],
    [{ name: 'new.txt', content: 'new' }, { name: '.git/config', content: 'bad' }],
    [{ name: 'new.txt', content: 'new' }, { name: 'link', content: '/etc/passwd', symlink: true }],
    [{ name: 'new.txt', content: 'new' }, { name: 'new.txt', content: 'duplicate' }],
    [{ name: 'new.txt', content: 'new' }, { name: '项目/main.ts', content: 'overwrite' }],
    [{ name: 'new.txt', content: 'new' }, { name: 'conflict', content: 'file' }, { name: 'conflict/a', content: 'file' }],
  ]) {
    await assert.rejects(files.importZip(id, await zip(invalid)));
    await assert.rejects(files.read(id, 'new.txt'), { statusCode: 404 });
  }
  assert.equal((await files.read(id, '项目/main.ts')).content, 'console.log("你好")');
});

test('ZIP export omits configured secret files, dependencies, Git state and symlinks', async () => {
  const { files, id, projectPath } = await fixture();
  await files.write(id, 'src/index.js', 'ok', null);
  for (const name of ['.env', 'cert.pem', 'auth.json', '.npmrc']) await fs.writeFile(path.join(projectPath, name), 'private');
  for (const name of ['.git', 'node_modules', '.ssh']) { await fs.mkdir(path.join(projectPath, name)); await fs.writeFile(path.join(projectPath, name, 'data'), 'private'); }
  await fs.symlink('/etc/passwd', path.join(projectPath, 'link'));
  const output = await files.exportZip(id);
  const other = await fixture();
  await other.files.importZip(other.id, output);
  assert.deepEqual((await other.files.list(other.id)).entries.map((entry) => entry.name), ['src']);
  assert.equal((await other.files.read(other.id, 'src/index.js')).content, 'ok');
});

test('public HTTPS clone URLs are DNS validated and return pinned addresses', async () => {
  const publicLookup = async () => [{ address: '140.82.114.3' }];
  const accepted = await validateCloneUrl('https://github.com/example/repo.git', publicLookup);
  assert.equal(accepted.hostname, 'github.com');
  assert.deepEqual(accepted.addresses, ['140.82.114.3']);
  for (const url of ['file:///etc/passwd', 'ssh://git@github.com/test/repo', 'https://user:pass@github.com/repo', 'https://127.0.0.1/repo', 'https://169.254.169.254/repo', 'https://10.0.0.1/repo', 'https://[::1]/repo', 'https://github.com:8080/repo', 'https://github.com/repo?token=secret']) await assert.rejects(validateCloneUrl(url, publicLookup));
  await assert.rejects(validateCloneUrl('https://mixed.example/repo', async () => [{ address: '140.82.114.3' }, { address: '192.168.0.2' }]));
});

test('invalid UUID and replaced workspace roots are rejected', async () => {
  const { files, id, projectPath } = await fixture();
  await assert.rejects(files.list('../../etc'));
  await fs.rmdir(projectPath);
  await fs.symlink('/etc', projectPath);
  await assert.rejects(files.list(id), { code: 'unsafe_path' });
});
