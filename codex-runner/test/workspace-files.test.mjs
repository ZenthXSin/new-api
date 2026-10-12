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

test('binary files expose read-only metadata without rewriting content', async () => {
  const { files, id, projectPath } = await fixture();
  await fs.writeFile(path.join(projectPath, 'binary'), Buffer.from([0xff, 0x00]));
  assert.deepEqual(await files.read(id, 'binary'), { path: 'binary', content: '', hash: null, size: 2, binary: true });
  await assert.rejects(files.write(id, 'too-big', 'x'.repeat(1024 * 1024 + 1), null), { statusCode: 413 });
  assert.equal((await files.list(id)).entries.length, 1);
});

test('large artifacts remain downloadable beyond the text and project export limits', async () => {
  const { files, id, projectPath } = await fixture();
  const location = path.join(projectPath, 'Phira.ipa');
  const handle = await fs.open(location, 'w');
  const size = 129 * 1024 * 1024 + 7;
  await handle.truncate(size);
  await handle.write(Buffer.from([0x50, 0x4b, 0, 0xff]), 0, 4, 0);
  await handle.close();
  const preview = await files.read(id, 'Phira.ipa');
  assert.equal(preview.size, size);
  assert.equal(preview.truncated, true);
  assert.equal(preview.hash, null);
  const download = await files.download(id, 'Phira.ipa');
  assert.equal(download.size, size);
  let count = 0, first;
  for await (const chunk of download.stream) { first ||= chunk.subarray(0, 4); count += chunk.length; }
  assert.equal(count, size);
  assert.deepEqual(first, Buffer.from([0x50, 0x4b, 0, 0xff]));
});

test('artifact downloads reject traversal, symlinks, special files and files beyond the download limit', async () => {
  const { files, id, projectPath, root } = await fixture();
  await fs.writeFile(path.join(root, 'secret'), 'private');
  await fs.symlink(path.join(root, 'secret'), path.join(projectPath, 'link'));
  await fs.symlink(root, path.join(projectPath, 'outside'));
  await fs.mkdir(path.join(projectPath, 'folder'));
  await runCommand('mkfifo', [path.join(projectPath, 'pipe')]);
  for (const unsafe of ['../secret', '/etc/passwd', '.git/config', 'link', 'outside/secret', 'folder', 'pipe', 'missing']) {
    await assert.rejects(files.download(id, unsafe));
  }
  const handle = await fs.open(path.join(projectPath, 'oversized'), 'w');
  await handle.truncate(1024 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(files.download(id, 'oversized'), { code: 'file_too_large', statusCode: 413 });
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

test('ordinary uploads preserve binary bytes and Unicode paths without overwriting files', async () => {
  const { files, id, projectPath } = await fixture();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xc0, 0x80]);
  assert.deepEqual(await files.upload(id, '素材/截图.png', bytes), { path: '素材/截图.png', size: bytes.length });
  assert.deepEqual(await fs.readFile(path.join(projectPath, '素材/截图.png')), bytes);
  await assert.rejects(files.upload(id, '素材/截图.png', Buffer.from('replacement')), { code: 'file_conflict', statusCode: 409 });
  assert.deepEqual(await fs.readFile(path.join(projectPath, '素材/截图.png')), bytes);
  assert.deepEqual(await files.upload(id, 'empty.txt', Buffer.alloc(0)), { path: 'empty.txt', size: 0 });
  assert.equal((await fs.stat(path.join(projectPath, 'empty.txt'))).size, 0);
});

test('ordinary uploads reject traversal symlinks directories and oversized payloads', async () => {
  const { files, id, projectPath, root } = await fixture();
  const secret = path.join(root, 'secret');
  await fs.writeFile(secret, 'private');
  await fs.symlink(secret, path.join(projectPath, 'link'));
  await fs.symlink(root, path.join(projectPath, 'outside'));
  await fs.mkdir(path.join(projectPath, 'existing-directory'));
  for (const unsafe of ['../secret', '/etc/passwd', '.git/config', 'outside/secret', 'link', 'existing-directory', 'a\\b', '']) {
    await assert.rejects(files.upload(id, unsafe, Buffer.from('overwrite')));
  }
  await assert.rejects(async () => files.upload(id, 'too-large.bin', Buffer.alloc(25 * 1024 * 1024 + 1)), {statusCode: 413});
  assert.equal(await fs.readFile(secret, 'utf8'), 'private');
  await assert.rejects(fs.stat(path.join(projectPath, 'too-large.bin')), {code: 'ENOENT'});
});

test('independent upload helpers cannot replace the winning file at the same path', async () => {
  const { files, id, projectPath } = await fixture();
  const results = await Promise.allSettled([
    files.fileOperation(id, 'upload', {path: 'same.bin', data: Buffer.from('first').toString('base64')}),
    files.fileOperation(id, 'upload', {path: 'same.bin', data: Buffer.from('second').toString('base64')}),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'file_conflict');
  const accepted = results[0].status === 'fulfilled' ? 'first' : 'second';
  assert.equal(await fs.readFile(path.join(projectPath, 'same.bin'), 'utf8'), accepted);
});
