import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { CloudSnapshots } from '../cloud-snapshots.mjs';
import { UserWorkspaceLayout } from '../user-layout.mjs';
import { runCommand } from '../workspace-files.mjs';

const directories = [];
const runtimeUid = process.getuid?.() === 0 ? 1000 : process.getuid();
const runtimeGid = process.getuid?.() === 0 ? 1000 : process.getgid();

async function makeWritable(folder) {
  const info = await fs.lstat(folder);
  if (!info.isDirectory()) return;
  await fs.chmod(folder, 0o700);
  for (const name of await fs.readdir(folder)) await makeWritable(path.join(folder, name));
}

afterEach(async () => {
  for (const folder of directories.splice(0)) {
    await makeWritable(folder);
    await fs.rm(folder, { recursive: true, force: true });
  }
});

async function fixture({ maxSnapshotBytes } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'new-api-cloud-snapshots-'));
  directories.push(dataDir);
  const layout = new UserWorkspaceLayout(dataDir);
  const snapshots = new CloudSnapshots({ dataDir, maxSnapshotBytes });
  await snapshots.initialize();
  const environmentId = randomUUID();
  const createWorkspace = async (ownerId = 1) => {
    const paths = await layout.create(randomUUID(), ownerId);
    const toolsPath = path.join(paths.workspaceHomePath, 'environment-home');
    await fs.mkdir(toolsPath, { mode: 0o755 });
    await fs.chown(toolsPath, runtimeUid, runtimeGid);
    return { ...paths, toolsPath, ownerId, environmentId, version: 1 };
  };
  return { dataDir, snapshots, createWorkspace, source: await createWorkspace() };
}

async function ownedFile(root, relative, contents, mode = 0o644) {
  let parent = root;
  for (const part of path.dirname(relative).split('/')) {
    if (part === '.') continue;
    parent = path.join(parent, part);
    await fs.mkdir(parent, { recursive: true });
    await fs.chown(parent, runtimeUid, runtimeGid);
  }
  const location = path.join(root, relative);
  await fs.writeFile(location, contents, { mode });
  await fs.chown(location, runtimeUid, runtimeGid);
  return location;
}

async function ownedLink(root, relative, target) {
  await ownedFile(root, relative, 'placeholder');
  await fs.unlink(path.join(root, relative));
  await fs.symlink(target, path.join(root, relative));
  await fs.lchown(path.join(root, relative), runtimeUid, runtimeGid);
}

function versionPath(dataDir, source, version = source.version) {
  return path.join(dataDir, 'cloud-environment-snapshots', String(source.ownerId), source.environmentId, 'versions', String(version));
}

test('published project and tools bytes survive draft edits and restore into independent writable workspaces', async () => {
  const { snapshots, source, createWorkspace, dataDir } = await fixture();
  await ownedFile(source.projectPath, 'src/你好.js', 'export const answer = 42;\n');
  await ownedFile(source.projectPath, '.git/config', '[core]\nrepositoryformatversion = 0\n');
  await ownedFile(source.projectPath, '.env.local', 'PORT=3000\n');
  await ownedFile(source.projectPath, 'node_modules/tool/bin.js', '#!/usr/bin/env node\n', 0o755);
  await ownedLink(source.projectPath, 'node_modules/.bin/tool', '../tool/bin.js');
  await ownedFile(source.toolsPath, 'lib/my-tool', '#!/bin/sh\necho ready\n', 0o751);
  await ownedLink(source.toolsPath, 'bin/my-tool', '../lib/my-tool');
  const manifest = await snapshots.capture(source);
  assert.equal(manifest.files, 7);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
  assert.deepEqual(await snapshots.inspect(source), manifest);

  await fs.writeFile(path.join(source.projectPath, 'src/你好.js'), 'draft changed');
  await fs.rm(path.join(source.projectPath, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(source.toolsPath, 'lib/my-tool'), 'draft tool');
  const first = await createWorkspace();
  const second = await createWorkspace();
  await ownedFile(first.projectPath, 'stale', 'remove this');
  await ownedFile(first.codexHomePath, 'auth.json', 'task credential stays outside snapshot');
  assert.deepEqual(await snapshots.restore(first), manifest);
  assert.deepEqual(await snapshots.restore(second), manifest);
  assert.equal(await fs.readFile(path.join(first.projectPath, 'src/你好.js'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(await fs.readFile(path.join(first.projectPath, '.env.local'), 'utf8'), 'PORT=3000\n');
  assert.equal(await fs.readFile(path.join(first.projectPath, '.git/config'), 'utf8'), '[core]\nrepositoryformatversion = 0\n');
  assert.equal(await fs.readFile(path.join(first.toolsPath, 'bin/my-tool'), 'utf8'), '#!/bin/sh\necho ready\n');
  assert.equal(await fs.readlink(path.join(first.projectPath, 'node_modules/.bin/tool')), '../tool/bin.js');
  assert.equal(await fs.readFile(path.join(first.codexHomePath, 'auth.json'), 'utf8'), 'task credential stays outside snapshot');
  await assert.rejects(fs.stat(path.join(first.projectPath, 'stale')), { code: 'ENOENT' });
  const copied = await fs.stat(path.join(first.toolsPath, 'lib/my-tool'));
  const saved = await fs.stat(path.join(versionPath(dataDir, source), 'snapshot/tools/lib/my-tool'));
  assert.equal(copied.uid, runtimeUid);
  assert.equal(copied.gid, runtimeGid);
  assert.equal(copied.mode & 0o751, 0o751);
  assert.equal(saved.uid, process.getuid());
  assert.equal(saved.mode & 0o222, 0);
  assert.notEqual(copied.ino, saved.ino);
  assert.notEqual(copied.ino, (await fs.stat(path.join(second.toolsPath, 'lib/my-tool'))).ino);
  await fs.writeFile(path.join(first.toolsPath, 'lib/my-tool'), 'first task only');
  assert.equal(await fs.readFile(path.join(second.toolsPath, 'lib/my-tool'), 'utf8'), '#!/bin/sh\necho ready\n');
  assert.equal(await fs.readFile(path.join(versionPath(dataDir, source), 'snapshot/tools/lib/my-tool'), 'utf8'), '#!/bin/sh\necho ready\n');
});

test('republish creates immutable versions and does not change an already restored task', async () => {
  const { snapshots, source, createWorkspace } = await fixture();
  await ownedFile(source.projectPath, 'version.txt', 'one');
  const firstManifest = await snapshots.capture(source);
  const existingTask = await createWorkspace();
  await snapshots.restore(existingTask);
  await fs.writeFile(path.join(source.projectPath, 'version.txt'), 'two');
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_exists', statusCode: 409 });
  const secondManifest = await snapshots.capture({ ...source, version: 2 });
  assert.notEqual(secondManifest.digest, firstManifest.digest);
  const newTask = await createWorkspace();
  await snapshots.restore({ ...newTask, version: 2 });
  assert.equal(await fs.readFile(path.join(existingTask.projectPath, 'version.txt'), 'utf8'), 'one');
  assert.equal(await fs.readFile(path.join(newTask.projectPath, 'version.txt'), 'utf8'), 'two');
  assert.deepEqual(await snapshots.inspect(source), firstManifest);
});

test('capture excludes runtime credential locations while retaining unrelated project configuration', async () => {
  const { snapshots, source, createWorkspace } = await fixture();
  for (const root of [source.projectPath, source.toolsPath]) {
    for (const privatePath of ['.codex/auth.json', '.ssh/id_ed25519', '.aws/credentials', '.azure/accessTokens.json']) {
      await ownedFile(root, privatePath, 'must never copy');
    }
  }
  for (const privatePath of ['.config/gh/hosts.yml', '.config/gcloud/access_tokens.db', '.docker/config.json', '.npmrc', '.netrc', 'auth.json']) await ownedFile(source.toolsPath, privatePath, 'must never copy');
  await ownedFile(source.toolsPath, '.config/my-tool/settings.json', '{"theme":"dark"}');
  await ownedFile(source.projectPath, '.env', 'DEBUG=true');
  const manifest = await snapshots.capture({ ...source, forbiddenSecrets: ['must never copy'] });
  assert.equal(manifest.files, 2);
  const target = await createWorkspace();
  await snapshots.restore(target);
  assert.equal(await fs.readFile(path.join(target.toolsPath, '.config/my-tool/settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.equal(await fs.readFile(path.join(target.projectPath, '.env'), 'utf8'), 'DEBUG=true');
  for (const root of [target.projectPath, target.toolsPath]) for (const name of ['.codex', '.ssh', '.aws', '.azure']) await assert.rejects(fs.lstat(path.join(root, name)), { code: 'ENOENT' });
  for (const name of ['.config/gh', '.config/gcloud', '.docker/config.json', '.npmrc', '.netrc', 'auth.json']) await assert.rejects(fs.lstat(path.join(target.toolsPath, name)), { code: 'ENOENT' });
});

test('capture refuses known injected secrets, including a match across streaming chunks, and leaves no partial version', async () => {
  const { snapshots, source, dataDir } = await fixture();
  const secret = 'ghp_FORBIDDEN_EXACT_TOKEN';
  await ownedFile(source.projectPath, 'dependency.bin', Buffer.concat([Buffer.alloc(1024 * 1024 - 7, 0x78), Buffer.from(secret), Buffer.alloc(30)]));
  await assert.rejects(snapshots.capture({ ...source, forbiddenSecrets: [secret] }), (error) => {
    assert.equal(error.code, 'snapshot_contains_secret');
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('dependency.bin'), false);
    return true;
  });
  assert.deepEqual(await fs.readdir(path.dirname(versionPath(dataDir, source))), []);
  await fs.writeFile(path.join(source.projectPath, 'dependency.bin'), 'now safe');
  assert.equal((await snapshots.capture({ ...source, forbiddenSecrets: [secret] })).bytes, 8);
});

test('identity and root checks prevent cross-owner snapshots and reading shared homes or service data', async () => {
  const { snapshots, source, createWorkspace } = await fixture();
  const other = await createWorkspace(2);
  for (const replacement of [
    { ownerId: 0 }, { ownerId: '1' }, { environmentId: '../escape' }, { version: 0 }, { version: 1.5 }, { version: '1' },
    { toolsPath: source.workspaceHomePath }, { toolsPath: source.codexHomePath }, { toolsPath: source.userHomePath },
    { toolsPath: other.toolsPath }, { projectPath: other.projectPath }, { projectPath: '/etc' },
  ]) await assert.rejects(snapshots.capture({ ...source, ...replacement }));
  await fs.rmdir(source.projectPath);
  await fs.symlink(other.projectPath, source.projectPath);
  await assert.rejects(snapshots.capture(source), { code: 'unsafe_snapshot_path' });
});

test('symbolic links cannot escape either captured root, directly or through another relative link', async () => {
  const { snapshots, source, dataDir } = await fixture();
  await ownedFile(source.projectPath, 'safe/file', 'safe');
  for (const target of ['/etc/passwd', '../outside', 'safe/../../outside']) {
    await ownedLink(source.projectPath, 'link', target);
    await assert.rejects(snapshots.capture(source), { code: 'snapshot_unsafe_symlink' });
    await fs.unlink(path.join(source.projectPath, 'link'));
  }
  await ownedLink(source.projectPath, 'safe/back', '..');
  // Lexically stays inside, but safe/back first resolves to the root.
  await ownedLink(source.projectPath, 'chain', 'safe/back/../host-file');
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_unsafe_symlink' });
  assert.deepEqual(await fs.readdir(path.dirname(versionPath(dataDir, source))), []);
  await fs.unlink(path.join(source.projectPath, 'chain'));
  await ownedLink(source.projectPath, 'cycle', 'cycle');
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_unsafe_symlink' });
});

test('hardlinks and special files are rejected without exposing host file contents', async () => {
  const { snapshots, source, dataDir } = await fixture();
  const secret = await ownedFile(source.toolsPath, 'host-link-target', 'private file');
  await fs.link(secret, path.join(source.projectPath, 'linked'));
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_unsafe_hardlink' });
  await fs.unlink(path.join(source.projectPath, 'linked'));
  const result = await runCommand('python3', ['-I', '-c', 'import os,sys;os.mkfifo(sys.argv[1]);os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))', path.join(source.projectPath, 'pipe'), String(runtimeUid), String(runtimeGid)]);
  assert.equal(result.code, 0);
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_unsafe_file' });
  assert.equal(await fs.readFile(secret, 'utf8'), 'private file');
  assert.deepEqual(await fs.readdir(path.dirname(versionPath(dataDir, source))), []);
});

test('root-owned service files inside a runtime workspace cannot enter a snapshot', { skip: process.getuid?.() !== 0 }, async () => {
  const { snapshots, source } = await fixture();
  await fs.writeFile(path.join(source.projectPath, 'service-state.json'), 'not runtime owned');
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_unsafe_owner' });
});

test('the snapshot size bound applies across both roots and an oversized capture is fully cleaned', async () => {
  const { snapshots, source, dataDir } = await fixture({ maxSnapshotBytes: 10 });
  await ownedFile(source.projectPath, 'project', '123456');
  await ownedFile(source.toolsPath, 'tool', '12345');
  await assert.rejects(snapshots.capture(source), { code: 'snapshot_too_large', statusCode: 413 });
  assert.deepEqual(await fs.readdir(path.dirname(versionPath(dataDir, source))), []);
  await fs.writeFile(path.join(source.toolsPath, 'tool'), '1234');
  const manifest = await snapshots.capture(source);
  assert.equal(manifest.bytes, 10);
});

test('corrupt snapshots cannot partially replace either target root', async () => {
  const { snapshots, source, dataDir, createWorkspace } = await fixture();
  await ownedFile(source.projectPath, 'project', 'published');
  await ownedFile(source.toolsPath, 'tool', 'tool data');
  await snapshots.capture(source);
  const target = await createWorkspace();
  await ownedFile(target.projectPath, 'existing', 'untouched project');
  await ownedFile(target.toolsPath, 'existing', 'untouched tools');
  const corrupted = path.join(versionPath(dataDir, source), 'snapshot/tools/tool');
  await fs.chmod(corrupted, 0o600);
  await fs.writeFile(corrupted, 'bad bytes');
  await assert.rejects(snapshots.restore(target), { code: 'snapshot_corrupt' });
  assert.equal(await fs.readFile(path.join(target.projectPath, 'existing'), 'utf8'), 'untouched project');
  assert.equal(await fs.readFile(path.join(target.toolsPath, 'existing'), 'utf8'), 'untouched tools');
  await assert.rejects(fs.stat(path.join(target.projectPath, 'project')), { code: 'ENOENT' });
});

test('restore refuses a replaced destination root and a replaced storage directory', async () => {
  const { snapshots, source, createWorkspace, dataDir } = await fixture();
  await ownedFile(source.projectPath, 'snapshot', 'published');
  await snapshots.capture(source);
  const target = await createWorkspace();
  await fs.rmdir(target.toolsPath);
  await fs.symlink(source.toolsPath, target.toolsPath);
  await assert.rejects(snapshots.restore(target), { code: 'unsafe_snapshot_path' });
  assert.deepEqual(await fs.readdir(target.projectPath), []);
  const storage = path.join(dataDir, 'cloud-environment-snapshots');
  await fs.rename(storage, `${storage}-original`);
  await fs.symlink(`${storage}-original`, storage);
  await assert.rejects(snapshots.inspect(source), { code: 'unsafe_snapshot_path' });
  await assert.rejects(snapshots.remove(source.ownerId, source.environmentId), { code: 'unsafe_snapshot_path' });
});

test('independent snapshot instances serialize publication and cannot replace the winning version', async () => {
  const { snapshots, source, dataDir } = await fixture();
  await ownedFile(source.projectPath, 'file', 'published once');
  const other = new CloudSnapshots({ dataDir });
  const results = await Promise.allSettled([snapshots.capture(source), other.capture(source)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'snapshot_exists');
  assert.deepEqual(await snapshots.inspect(source), results.find((result) => result.status === 'fulfilled').value);
});

test('removal deletes only that owner environment and missing removal is idempotent', async () => {
  const { snapshots, source, createWorkspace } = await fixture();
  await ownedFile(source.projectPath, 'owner', 'one');
  await snapshots.capture(source);
  const other = await createWorkspace(2);
  await ownedFile(other.projectPath, 'owner', 'two');
  const otherManifest = await snapshots.capture(other);
  assert.deepEqual(await snapshots.remove(1, source.environmentId), { deleted: true });
  await assert.rejects(snapshots.inspect(source), { code: 'snapshot_not_found', statusCode: 404 });
  assert.deepEqual(await snapshots.inspect(other), otherManifest);
  assert.deepEqual(await snapshots.remove(1, source.environmentId), { deleted: true });
});
