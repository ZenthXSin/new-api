import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { WorkspaceFiles, runCommand } from '../workspace-files.mjs';
import { legacyWorkspacePaths, workspacePaths } from '../user-layout.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });
async function legacyFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-migrate-test-')); temporary.push(dataDir);
  const workspaces = [{ id: randomUUID(), ownerId: 1 }, { id: randomUUID(), ownerId: 1 }, { id: randomUUID(), ownerId: 2 }];
  for (const workspace of workspaces) {
    const old = legacyWorkspacePaths(dataDir, workspace.id);
    await fs.mkdir(path.join(old.homePath, '.codex', 'sessions'), { recursive: true });
    await fs.mkdir(path.join(old.homePath, '.workbench', 'baseline.git'), { recursive: true });
    await fs.mkdir(old.projectPath);
    await fs.writeFile(path.join(old.projectPath, 'code.txt'), workspace.id);
    await fs.writeFile(path.join(old.homePath, '.codex', 'sessions', 'history.jsonl'), JSON.stringify({ cwd: '/workspace', text: 'literal /workspace content remains unchanged', threadId: workspace.id }));
    await fs.writeFile(path.join(old.homePath, '.codex', 'config.toml'), 'private_setting = true\n');
    await fs.writeFile(path.join(old.homePath, '.workbench', 'baseline.git', 'HEAD'), 'ref: refs/heads/main');
  }
  return { dataDir, workspaces };
}

test('legacy projects and native home directories migrate independently without rewriting data', async () => {
  const f = await legacyFixture(), files = new WorkspaceFiles({ dataDir: f.dataDir });
  const result = await files.initialize(f.workspaces); assert.equal(result.migrated.length, 3);
  for (const workspace of f.workspaces) {
    const next = workspacePaths(f.dataDir, workspace.id, workspace.ownerId);
    assert.equal((await files.read(workspace.id, 'code.txt')).content, workspace.id);
    assert.equal(await fs.readFile(path.join(next.codexHomePath, 'config.toml'), 'utf8'), 'private_setting = true\n');
    assert.equal(await fs.readFile(path.join(next.workspaceHomePath, '.workbench', 'baseline.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main');
    assert.equal(JSON.parse(await fs.readFile(path.join(next.codexHomePath, 'sessions', 'history.jsonl'), 'utf8')).cwd, '/workspace');
    await assert.rejects(fs.lstat(legacyWorkspacePaths(f.dataDir, workspace.id).root), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(next.containerCodexHomePath), []);
  }
  assert.deepEqual((await files.initialize(f.workspaces)).migrated, []);
});

test('interrupted migration resumes moved project without copying over files', async () => {
  const f = await legacyFixture(), workspace = f.workspaces[0], files = new WorkspaceFiles({ dataDir: f.dataDir });
  files.layout.register(workspace.id, workspace.ownerId); await files.layout.ensureUser(workspace.ownerId);
  const old = legacyWorkspacePaths(f.dataDir, workspace.id), next = workspacePaths(f.dataDir, workspace.id, workspace.ownerId);
  await fs.mkdir(next.root); await fs.rename(old.projectPath, next.projectPath);
  await files.initialize(f.workspaces);
  assert.equal((await files.read(workspace.id, 'code.txt')).content, workspace.id);
});

test('migration rejects duplicate destination, symlinks, and owner rebinding', async () => {
  const f = await legacyFixture(), workspace = f.workspaces[0], files = new WorkspaceFiles({ dataDir: f.dataDir });
  files.layout.register(workspace.id, workspace.ownerId); await files.layout.ensureUser(workspace.ownerId);
  const next = workspacePaths(f.dataDir, workspace.id, workspace.ownerId);
  await fs.mkdir(next.root); await fs.mkdir(next.projectPath);
  await assert.rejects(files.initialize(f.workspaces), { code: 'migration_conflict' });
  await fs.rmdir(next.projectPath); await fs.rmdir(next.root);
  const old = legacyWorkspacePaths(f.dataDir, workspace.id); await fs.rename(old.homePath, path.join(f.dataDir, 'saved-home')); await fs.symlink(path.join(f.dataDir, 'saved-home'), old.homePath);
  await assert.rejects(files.initialize(f.workspaces), { code: 'unsafe_path' });
  assert.throws(() => files.layout.register(workspace.id, 2), { code: 'owner_conflict' });
});

test('root-controlled parent directories cannot be replaced by container uid and cross-project symlinks are rejected', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-parent-test-')); temporary.push(dataDir);
  const files = new WorkspaceFiles({ dataDir }), first = randomUUID(), second = randomUUID();
  const one = await files.create(first, 1), two = await files.create(second, 2);
  await files.write(second, 'secret.txt', 'owner-two', null);
  await fs.symlink(two.projectPath, path.join(one.projectPath, 'foreign'));
  await assert.rejects(files.read(first, 'foreign/secret.txt'), { code: 'unsafe_path' });
  if (process.getuid?.() === 0) {
    for (const dir of [one.root, one.projectsPath, one.homePath, one.workspaceHomesPath]) { const stat = await fs.stat(dir); assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0); }
  }
});

test('native SQLite path migration is idempotent and leaves history text untouched', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sqlite-test-')); temporary.push(dataDir);
  const id = randomUUID(), home = path.join(dataDir, 'home'), database = path.join(home, 'state_5.sqlite'); await fs.mkdir(home);
  await runCommand('python3', ['-I', '-c', 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT)");c.execute("INSERT INTO threads VALUES(?,?,?,?)",("native-thread","/home/codex/.codex/sessions/rollout.jsonl","/workspace","keep /workspace literal"));c.commit()', database]);
  // This unit fixture replaces only the constant mount root; production helper
  // remains container-only with trusted, fixed workspace paths.
  const source = await fs.readFile(new URL('../migrate-codex-home.py', import.meta.url), 'utf8');
  const script = path.join(dataDir, 'migrate.py');
  await fs.writeFile(script, source.replace("home = pathlib.Path('/home/codex/workspaces') / workspace / '.codex'", `home = pathlib.Path(${JSON.stringify(home)})`));
  for (let i = 0; i < 2; i++) { const result = await runCommand('python3', ['-I', script, id]); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).migratedPaths, i ? 0 : 2); }
  const result = await runCommand('python3', ['-I', '-c', 'import sqlite3,json,sys\nprint(json.dumps(sqlite3.connect(sys.argv[1]).execute("SELECT * FROM threads").fetchone()))', database]);
  assert.deepEqual(JSON.parse(result.stdout), ['native-thread', `${home}/sessions/rollout.jsonl`, `/workspace/projects/${id}/project`, 'keep /workspace literal']);
});

test('strict service umask permits container traversal while keeping host parents and private Codex data restricted', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-umask-test-')); temporary.push(dataDir);
  const files = new WorkspaceFiles({ dataDir }), id = randomUUID();
  const previous = process.umask(0o077);
  let paths;
  try { paths = await files.create(id, 910081); }
  finally { process.umask(previous); }
  for (const location of [paths.projectsPath, paths.root, paths.homePath, paths.workspaceHomesPath]) {
    const stat = await fs.stat(location);
    assert.equal(stat.mode & 0o777, 0o755, `Container must traverse ${location}`);
    if (process.getuid?.() === 0) assert.equal(stat.uid, 0);
  }
  for (const location of [dataDir, path.join(dataDir, 'users'), paths.userRoot, paths.projectPath, paths.workspaceHomePath, paths.codexHomePath]) assert.equal((await fs.stat(location)).mode & 0o777, 0o700, `Private mode changed for ${location}`);
});

test('existing inaccessible managed directories are repaired without changing data modes or accepting unsafe parents', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-permission-repair-')); temporary.push(dataDir);
  const files = new WorkspaceFiles({ dataDir }), id = randomUUID(), paths = await files.create(id, 910082);
  const managed = [paths.projectsPath, paths.root, paths.homePath, paths.workspaceHomesPath];
  for (const location of managed) await fs.chmod(location, 0o700);
  const sentinel = path.join(paths.projectPath, 'private.txt');
  await fs.writeFile(sentinel, 'unchanged', { mode: 0o600 });
  await files.check(id);
  for (const location of managed) assert.equal((await fs.stat(location)).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal((await fs.stat(sentinel)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(paths.codexHomePath)).mode & 0o777, 0o700);
  if (process.getuid?.() === 0) {
    await fs.chmod(paths.root, 0o777);
    await assert.rejects(files.check(id), { code: 'unsafe_path' });
    assert.equal((await fs.stat(paths.root)).mode & 0o777, 0o777);
    await fs.chmod(paths.root, 0o755);
  }
  const original = paths.root + '.saved';
  await fs.rename(paths.root, original); await fs.symlink(original, paths.root);
  await assert.rejects(files.check(id), { code: 'unsafe_path' });
});
