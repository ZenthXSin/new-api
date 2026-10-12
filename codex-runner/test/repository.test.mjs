import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRepository } from '../repository.mjs';
import { runCommand } from '../workspace-files.mjs';
import { WorkspaceStore } from '../store.mjs';
import { WorkspaceManager } from '../manager.mjs';

const gitEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

async function fixture(t, initialize = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-repository-test-'));
  const cwd = join(dataDir, 'project');
  await mkdir(cwd);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const git = async (...args) => {
    const result = await runCommand('git', args, { cwd, env: gitEnv });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  if (initialize) {
    await git('init', '--initial-branch=main');
    await writeFile(join(cwd, 'file.txt'), 'main content\n');
    await git('add', 'file.txt');
    await git('commit', '-m', 'Main fixture');
    await git('switch', '-c', 'feature');
    await writeFile(join(cwd, 'file.txt'), 'feature content\n');
    await git('commit', '-am', 'Feature fixture');
    await git('switch', 'main');
    await git('remote', 'add', 'origin', 'https://fixture-user:fixture-secret@example.invalid/owner/repo.git?token=fixture-query#private');
    await git('update-ref', 'refs/remotes/origin/remote-feature', await git('rev-parse', 'feature'));
  }
  const calls = [];
  const runtime = {
    cwd: () => cwd,
    exec: async (id, argv, options) => {
      calls.push({ id, argv, options });
      return runCommand(argv[0], argv.slice(1), { ...options, cwd, env: gitEnv });
    },
  };
  return { dataDir, cwd, git, runtime, calls };
}

test('repository metadata reflects actual HEAD, local and remote refs and removes URL credentials', async (t) => {
  const f = await fixture(t);
  const metadata = await workspaceRepository(f.runtime, 'workspace');
  assert.equal(metadata.available, true);
  assert.equal(metadata.branch, 'main');
  assert.equal(metadata.head, await f.git('rev-parse', 'HEAD'));
  assert.equal(metadata.dirty, false);
  assert.deepEqual(metadata.remotes, [{ name: 'origin', url: 'https://example.invalid/owner/repo.git' }]);
  assert(metadata.branches.some((branch) => branch.name === 'main' && branch.current && branch.remote === null));
  assert(metadata.branches.some((branch) => branch.name === 'remote-feature' && branch.remote === 'origin'));
  assert.equal(JSON.stringify(metadata).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(metadata).includes('fixture-query'), false);
  assert.equal(f.calls[0].argv[0], 'python3');
  assert.equal(f.calls[0].argv.includes('sh'), false);
});

test('selecting existing local and remote branches updates actual files without fetching', async (t) => {
  const f = await fixture(t);
  const local = await workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'feature' });
  assert.equal(local.branch, 'feature');
  assert.equal(await readFile(join(f.cwd, 'file.txt'), 'utf8'), 'feature content\n');
  const remote = await workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'remote-feature', remote: 'origin' });
  assert.equal(remote.branch, 'remote-feature');
  assert.equal(await f.git('config', '--get', 'branch.remote-feature.remote'), 'origin');
  await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'remote-feature', remote: 'origin' }), { code: 'branch_exists' });
});

test('tracked, staged and untracked changes block checkout while preserving HEAD and file bytes', async (t) => {
  for (const kind of ['tracked', 'staged', 'untracked']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t), head = await f.git('rev-parse', 'HEAD');
      const file = kind === 'untracked' ? 'untracked.txt' : 'file.txt';
      await writeFile(join(f.cwd, file), 'changes to preserve\n');
      if (kind === 'staged') await f.git('add', file);
      assert.equal((await workspaceRepository(f.runtime, 'workspace')).dirty, true);
      await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'feature' }), { code: 'repository_dirty' });
      assert.equal(await f.git('rev-parse', 'HEAD'), head);
      assert.equal(await readFile(join(f.cwd, file), 'utf8'), 'changes to preserve\n');
    });
  }
});

test('ignored files that would be overwritten survive a refused checkout', async (t) => {
  const f = await fixture(t);
  await f.git('switch', 'feature');
  await writeFile(join(f.cwd, 'ignored.txt'), 'tracked on feature\n');
  await f.git('add', 'ignored.txt');
  await f.git('commit', '-m', 'Tracked conflict');
  await f.git('switch', 'main');
  await writeFile(join(f.cwd, '.gitignore'), 'ignored.txt\n');
  await f.git('add', '.gitignore');
  await f.git('commit', '-m', 'Ignored conflict');
  await writeFile(join(f.cwd, 'ignored.txt'), 'valuable local file\n');
  assert.equal((await workspaceRepository(f.runtime, 'workspace')).dirty, false);
  await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'feature' }), { code: 'checkout_conflict' });
  assert.equal(await f.git('branch', '--show-current'), 'main');
  assert.equal(await readFile(join(f.cwd, 'ignored.txt'), 'utf8'), 'valuable local file\n');
});

test('invalid refs and missing branches cannot execute commands or change the checkout', async (t) => {
  const f = await fixture(t);
  for (const branch of ['--force', 'refs/heads/main', 'HEAD', 'main..feature', 'main@{1}', '../feature', 'x\nmain', 'x;touch marker']) {
    await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch }));
  }
  await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'not-fetched' }), { code: 'branch_not_found' });
  assert.equal(await f.git('branch', '--show-current'), 'main');
});

test('hooks and fsmonitor from the repository cannot run during metadata or checkout', async (t) => {
  const f = await fixture(t);
  const marker = join(f.dataDir, 'executed');
  const script = '#!/bin/sh\nprintf executed > ' + marker + '\n';
  await writeFile(join(f.cwd, '.git/hooks/post-checkout'), script, { mode: 0o755 });
  await writeFile(join(f.cwd, '.git/hooks/fsmonitor'), script, { mode: 0o755 });
  await f.git('config', 'core.fsmonitor', join(f.cwd, '.git/hooks/fsmonitor'));
  await workspaceRepository(f.runtime, 'workspace');
  await workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'feature' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('external includes and clean or smudge filters are refused before repository code executes', async (t) => {
  for (const key of ['include.path', 'filter.external.clean', 'filter.external.smudge', 'filter.external.process']) {
    await t.test(key, async (t) => {
      const f = await fixture(t);
      const marker = join(f.dataDir, 'executed');
      await f.git('config', key, key === 'include.path' ? join(f.dataDir, 'external-config') : 'touch ' + marker);
      await assert.rejects(workspaceRepository(f.runtime, 'workspace'), { code: 'unsupported_repository' });
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    });
  }
});

test('symlink, hardlink and gitdir escapes are rejected before reading or modifying outside repository files', async (t) => {
  for (const escape of ['gitdir', 'config-link', 'head-hardlink', 'alternates']) {
    await t.test(escape, async (t) => {
      const f = await fixture(t);
      const outside = join(f.dataDir, 'outside');
      await writeFile(outside, 'outside contents');
      if (escape === 'gitdir') { await rm(join(f.cwd, '.git'), { recursive: true }); await writeFile(join(f.cwd, '.git'), 'gitdir: ../outside\n'); }
      if (escape === 'config-link') { await rm(join(f.cwd, '.git/config')); await symlink(outside, join(f.cwd, '.git/config')); }
      if (escape === 'head-hardlink') { await rm(join(f.cwd, '.git/HEAD')); await link(outside, join(f.cwd, '.git/HEAD')); }
      if (escape === 'alternates') await writeFile(join(f.cwd, '.git/objects/info/alternates'), outside + '\n');
      await assert.rejects(workspaceRepository(f.runtime, 'workspace'));
      assert.equal(await readFile(outside, 'utf8'), 'outside contents');
    });
  }
});

test('empty projects, unborn branches and detached HEAD return accurate available states', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await workspaceRepository(f.runtime, 'workspace')).available, false);
  await f.git('init', '--initial-branch=main');
  const unborn = await workspaceRepository(f.runtime, 'workspace');
  assert.equal(unborn.branch, 'main');
  assert.equal(unborn.head, null);
  assert.equal(unborn.detached, false);
  await f.git('commit', '--allow-empty', '-m', 'Initial');
  await f.git('checkout', '--detach', 'HEAD');
  const detached = await workspaceRepository(f.runtime, 'workspace');
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.head, await f.git('rev-parse', 'HEAD'));
});

test('submodules and an ongoing merge expose a disabled checkout without entering nested repository configuration', async (t) => {
  const f = await fixture(t);
  const head = await f.git('rev-parse', 'HEAD');
  await writeFile(join(f.cwd, '.git/MERGE_HEAD'), head + '\n');
  assert.equal((await workspaceRepository(f.runtime, 'workspace')).checkoutReason, 'operation_in_progress');
  await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'feature' }), { code: 'checkout_unsupported' });
  await rm(join(f.cwd, '.git/MERGE_HEAD'));
  await f.git('update-index', '--add', '--cacheinfo', `160000,${head},nested`);
  await f.git('commit', '-m', 'Submodule fixture');
  await mkdir(join(f.cwd, 'nested'));
  const metadata = await workspaceRepository(f.runtime, 'workspace');
  assert.equal(metadata.hasSubmodules, true);
  assert.equal(metadata.checkoutSupported, false);
  assert.equal(metadata.checkoutReason, 'submodules');
  await assert.rejects(workspaceRepository(f.runtime, 'workspace', 'checkout', { branch: 'feature' }), { code: 'checkout_unsupported' });
});

test('inherited Git overrides cannot redirect metadata or checkout to another repository', async (t) => {
  const f = await fixture(t), other = await fixture(t);
  const runtime = {
    cwd: () => f.cwd,
    exec: async (_id, argv, options) => runCommand(argv[0], argv.slice(1), {
      ...options, cwd: f.cwd,
      env: { ...gitEnv, GIT_DIR: join(other.cwd, '.git'), GIT_WORK_TREE: other.cwd, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other.cwd },
    }),
  };
  await workspaceRepository(runtime, 'workspace', 'checkout', { branch: 'feature' });
  assert.equal(await f.git('branch', '--show-current'), 'feature');
  assert.equal(await other.git('branch', '--show-current'), 'main');
});

test('SSH repository execution uses the stored owner, connection and canonical project rather than client overrides', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const backend = { entry: () => ({ ownerId: 7, remote: { connectionId: 'private-connection' } }), connections: { exec: async (owner, connection, argv, options) => {
    calls.push({ owner, connection, argv, options });
    return runCommand(argv[0], argv.slice(1), { ...options, cwd: f.cwd, env: gitEnv });
  } } };
  const runtime = { backend: () => backend, cwd: () => f.cwd };
  const result = await workspaceRepository(runtime, 'workspace', 'metadata', { cwd: '/etc', operation: 'checkout', branch: 'feature' });
  assert.equal(result.branch, 'main');
  assert.equal(calls[0].owner, 7);
  assert.equal(calls[0].connection, 'private-connection');
  assert.equal(JSON.parse(calls[0].options.input).cwd, f.cwd);
});

test('manager guards owners, active tasks and queued work before branch switching and persists safe metadata', async (t) => {
  const f = await fixture(t);
  const store = new WorkspaceStore({ dataDir: f.dataDir });
  await store.initialize();
  const state = store.create(1, { name: 'Repository', model: 'fixture', mode: 'code' });
  const starts = [];
  Object.assign(f.runtime, { environment: async () => ({ status: 'running' }), startUser: async (owner, options) => { starts.push({ owner, options }); }, stopAppServer: async () => {} });
  const manager = new WorkspaceManager({ store, runtime: f.runtime, files: {}, config: { dataDir: f.dataDir, maxActive: 2 } });
  const id = state.workspace.id;
  await assert.rejects(manager.repository(2, id), { code: 'not_found' });
  state.workspace.status = 'running';
  await assert.rejects(manager.checkoutBranch(1, id, { branch: 'feature' }), { code: 'environment_busy' });
  state.workspace.status = 'idle';
  state.queuedTurns = [{ requestId: 'queued' }];
  await assert.rejects(manager.checkoutBranch(1, id, { branch: 'feature' }), { code: 'repository_queue_pending' });
  state.queuedTurns = [];
  const result = await manager.checkoutBranch(1, id, { branch: 'feature' });
  assert.equal(result.repository.branch, 'feature');
  assert.equal(state.workspace.repositoryUrl, 'https://example.invalid/owner/repo.git');
  assert.equal(state.workspace.branch, 'feature');
  assert.equal(starts[0].options.mode, 'code');
  const reopened = new WorkspaceStore({ dataDir: f.dataDir });
  await reopened.initialize();
  assert.equal(reopened.get(1, id).workspace.branch, 'feature');
  await reopened.close();
  await store.close();
});
