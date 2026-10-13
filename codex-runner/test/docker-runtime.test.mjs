import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { DockerRuntime } from '../docker-runtime.mjs';
import { WorkspaceFiles, workspacePaths } from '../workspace-files.mjs';

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))); });
async function fixture(ownerId = 1) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-docker-test-')); temporary.push(dataDir);
  const calls = [], containers = new Map();
  const command = async (program, args, options) => {
    calls.push({ program, args, options });
    if (program === 'du') return { code: 0, stdout: '1024\t/user', stderr: '' };
    if (args[0] === 'inspect') return containers.has(args.at(-1)) ? { code: 0, stdout: JSON.stringify([containers.get(args.at(-1))]), stderr: '' } : { code: 1, stdout: '', stderr: 'Error: No such object' };
    if (args[0] === 'network') return { code: 0, stdout: JSON.stringify([{ Driver: 'bridge', Labels: { 'new-api.codex.managed': 'true' } }]), stderr: '' };
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1], labels = {};
      args.forEach((arg, index) => { if (arg === '--label') { const [key, value] = args[index + 1].split('='); labels[key] = value; } });
      const mounts = args.flatMap((arg, index) => arg === '--mount' ? [args[index + 1]] : []).map((text) => { const source = /src=([^,]+)/.exec(text)[1], destination = /dst=([^,]+)/.exec(text)[1]; return { Type: 'bind', Source: source, Destination: destination, RW: !text.includes('readonly') }; });
      const env = args.flatMap((arg, index) => arg === '--env' ? [args[index + 1]] : []);
      containers.set(name, { Id: randomUUID(), Name: `/${name}`, Config: { User: '1000:1000', Labels: labels, Env: env }, State: { Running: false }, HostConfig: { NetworkMode: 'new-api-codex-workers', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], NanoCpus: 2e9, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3 }, NetworkSettings: { Networks: { 'new-api-codex-workers': {} } }, Mounts: mounts });
    }
    if (args[0] === 'start') containers.get(args[1]).State.Running = true;
    if (args[0] === 'stop') containers.get(args.at(-1)).State.Running = false;
    if (args[0] === 'rm') containers.delete(args.at(-1));
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1];
      const [label, expected] = filter.replace(/^label=/, '').split('=');
      return { code: 0, stdout: [...containers.entries()].filter(([, info]) => info.Config.Labels[label] === expected).map(([name]) => name).join('\n'), stderr: '' };
    }
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const runtime = new DockerRuntime({ dataDir, command, hostCpuCount: 40, hostMemoryBytes: 40 * 1024 ** 3 }), files = new WorkspaceFiles({ dataDir, dockerRuntime: runtime });
  const id = randomUUID(); await files.create(id, ownerId);
  return { dataDir, id, ownerId, runtime, files, calls, containers, command };
}

test('same user projects share one stable container while different users never share mounts', async () => {
  const f = await fixture(), second = randomUUID(), another = randomUUID();
  await f.files.create(second, 1); await f.files.create(another, 2);
  await Promise.all([f.runtime.start(f.id), f.runtime.start(second)]);
  const original = await f.runtime.inspect(f.id);
  assert.equal((await f.runtime.inspect(second)).Id, original.Id);
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').length, 1);
  await f.runtime.start(another);
  const other = await f.runtime.inspect(another);
  assert.notEqual(other.Id, original.Id);
  assert.equal(original.Mounts[0].Source, workspacePaths(f.dataDir, f.id, 1).projectsPath);
  assert.notEqual(other.Mounts[0].Source, original.Mounts[0].Source);
  await assert.rejects(Promise.resolve().then(() => f.runtime.registerWorkspace(f.id, 2)), { code: 'owner_conflict' });
});

test('container default Codex homes are private, survive recreation and do not contain another owner history', async () => {
  const f = await fixture(), other = randomUUID(); await f.files.create(other, 2);
  await f.runtime.start(f.id); await f.runtime.start(other);
  const one = f.files.layout.paths(f.id), two = f.files.layout.paths(other);
  assert.notEqual(one.containerCodexHomePath, two.containerCodexHomePath);
  assert.equal((await fs.stat(one.containerCodexHomePath)).mode & 0o777, 0o700);
  await fs.writeFile(path.join(one.containerCodexHomePath, 'config.toml'), 'fixture_setting = true\n');
  assert.deepEqual(await fs.readdir(two.containerCodexHomePath), []);
  const container = f.containers.get(f.runtime.name(1));
  assert.ok(container.Config.Env.includes('CODEX_HOME=/home/codex/user/.codex'));
  container.Config.Env = container.Config.Env.filter((value) => !value.startsWith('CODEX_HOME='));
  await f.runtime.stopUser(1); await f.runtime.start(f.id);
  assert.notEqual(f.containers.get(f.runtime.name(1)).Id, container.Id);
  assert.equal(await fs.readFile(path.join(one.containerCodexHomePath, 'config.toml'), 'utf8'), 'fixture_setting = true\n');
  assert.ok(f.containers.get(f.runtime.name(1)).Config.Env.includes('CODEX_HOME=/home/codex/user/.codex'));
  assert.equal(f.runtime.projectEnv(f.id).CODEX_HOME, one.codexHome);
});

test('runtime refuses containers with mismatched owner, filesystem mounts or privileges', async () => {
  const f = await fixture(); await f.runtime.start(f.id); const original = structuredClone(f.containers.get(f.runtime.name(1)));
  for (const mutate of [
    (info) => { info.Config.Labels['new-api.codex.owner'] = '2'; },
    (info) => { info.Config.Labels['new-api.codex.isolation-version'] = '1'; },
    (info) => { info.Config.User = '0'; }, (info) => { info.HostConfig.NetworkMode = 'host'; },
    (info) => { info.HostConfig.ReadonlyRootfs = false; }, (info) => { info.Config.Labels['new-api.codex.mode'] = 'ask'; },
    (info) => { info.NetworkSettings.Networks['new-api-database'] = {}; }, (info) => { info.HostConfig.Privileged = true; }, (info) => { info.HostConfig.CapAdd = ['SYS_ADMIN']; },
    (info) => { info.Mounts[0].Source = workspacePaths(f.dataDir, f.id, 2).projectsPath; },
    (info) => { info.Mounts.push({ Type: 'volume', Source: 'other-users', Destination: '/shared' }); },
  ]) {
    const changed = structuredClone(original); mutate(changed); f.containers.set(f.runtime.name(1), changed);
    await assert.rejects(f.runtime.stopUser(1), { code: 'unsafe_container' });
  }
});

test('start gate refuses low host disk before any Docker mutation', async () => {
  const f = await fixture(); f.runtime.statfs = async () => ({ bavail: 1, bsize: 4096 });
  await assert.rejects(f.runtime.start(f.id), { code: 'disk_space_low', statusCode: 507 }); assert.equal(f.calls.length, 0);
});

test('mode changes stop and remove before creating the same named readonly environment', async () => {
  const f = await fixture(); await f.runtime.start(f.id); const original = await f.runtime.inspect(f.id);
  await f.runtime.setMode(f.id, 'ask'); const updated = await f.runtime.inspect(f.id);
  assert.equal(updated.Name, original.Name); assert.notEqual(updated.Id, original.Id); assert.equal(updated.Mounts[0].RW, false);
  const actions = f.calls.filter((call) => ['stop', 'rm', 'create'].includes(call.args[0])).map((call) => call.args[0]);
  assert.deepEqual(actions, ['create', 'stop', 'rm', 'create']);
  await f.runtime.exec(f.id, ['true']); assert.equal((await f.runtime.inspect(f.id)).Id, updated.Id);
});

test('creation keeps nonroot, resource limits, fixed binds and dedicated bridge', async () => {
  const f = await fixture(); await f.runtime.start(f.id); const args = f.calls.find((call) => call.args[0] === 'create').args;
  for (const [flag, value] of [['--user', '1000:1000'], ['--cpus', '2'], ['--memory', '2147483648'], ['--pids-limit', '256'], ['--network', 'new-api-codex-workers'], ['--cap-drop', 'ALL']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.equal(args.includes('--read-only'), true); assert.equal(args.filter((arg) => arg === '--mount').length, 2);
  assert.equal(args.some((arg) => arg.includes('docker.sock')), false); assert.equal(args.includes('--privileged'), false);
});

test('default CPU uses five percent while memory uses a fixed MB budget', async () => {
  const f = await fixture();
  const environment = await f.runtime.environment(f.ownerId);
  assert.equal(environment.cpuPercent, 5);
  assert.equal(environment.cpu, 2);
  assert.equal('memoryPercent' in environment, false);
  assert.equal(environment.memoryBytes, 2 * 1024 ** 3);
});

test('App Server uses project cwd and history with credentials outside argv', async () => {
  const f = await fixture(); let spawned; const child = { stdin: {}, stdout: {}, stderr: {} };
  f.runtime.spawnImpl = (program, args, options) => { spawned = { program, args, options }; return child; };
  assert.equal(await f.runtime.spawnAppServer(f.id, { env: { NEW_API_KEY: 'dedicated-secret', NEW_API_BASE_URL: 'https://api.example/v1', HOME: '/root' } }), child);
  assert.equal(spawned.args.join(' ').includes('dedicated-secret'), false);
  assert.equal(spawned.args[spawned.args.indexOf('--workdir') + 1], `/workspace/projects/${f.id}/project`);
  const runtimeEnv = JSON.parse(spawned.options.env.NEW_API_CODEX_RUNTIME_ENV);
  assert.equal(runtimeEnv.CODEX_HOME, `/home/codex/workspaces/${f.id}/.codex`);
  assert.deepEqual(spawned.args.slice(-3), ['app-server', '--listen', 'stdio://']);
  assert.equal(runtimeEnv.NEW_API_KEY, 'dedicated-secret'); assert.notEqual(runtimeEnv.HOME, '/root');
  await assert.rejects(f.runtime.spawnAppServer(f.id, { env: { NEW_API_KEY: 'secret', NEW_API_BASE_URL: 'https://user:pass@example.com/v1' } }), { code: 'model_not_configured' });
});

test('GitHub token reaches only its owner App Server and clone through environment, never argv or container configuration', async () => {
  const f = await fixture(), other = randomUUID(); await f.files.create(other, 2);
  const token = 'gho_fixture_private_token_123';
  f.runtime.setGitHubCredential(1, { token, login: 'fixture', generation: 1 });
  let spawned;
  f.runtime.spawnImpl = (program, args, options) => { spawned = { program, args, options }; return { stdin: {}, stdout: {}, stderr: {} }; };
  const env = { NEW_API_KEY: 'dedicated-secret', NEW_API_BASE_URL: 'https://api.example/v1' };
  await f.runtime.spawnAppServer(f.id, { env });
  assert.equal(JSON.parse(spawned.options.env.NEW_API_CODEX_RUNTIME_ENV).GH_TOKEN, token);
  assert.equal(JSON.parse(spawned.options.env.NEW_API_CODEX_RUNTIME_ENV).GITHUB_TOKEN, token);
  assert.equal(JSON.stringify(spawned.args).includes(token), false);
  assert.equal(f.calls.filter((call) => call.args[0] === 'create').some((call) => JSON.stringify(call).includes(token)), false);
  f.runtime.command = async (program, args, options) => {
    if (args.includes('/opt/new-api-codex/workspace-git.py')) { f.calls.push({ program, args, options }); return { code: 0, stdout: '{"ok":true,"result":{"imported":true}}', stderr: '' }; }
    return f.command(program, args, options);
  };
  await f.runtime.clone(f.id, { url: 'https://github.com/fixture/private.git', hostname: 'github.com', addresses: ['140.82.116.3'] });
  const clone = f.calls.findLast((call) => call.args.includes('/opt/new-api-codex/workspace-git.py'));
  assert.equal(JSON.parse(clone.options.env.NEW_API_CODEX_RUNTIME_ENV).GH_TOKEN, token);
  assert.equal(clone.args.join(' ').includes(token), false);
  assert.equal(clone.options.input.includes(token), false);
  await f.runtime.spawnAppServer(other, { env });
  assert.equal(JSON.parse(spawned.options.env.NEW_API_CODEX_RUNTIME_ENV).GH_TOKEN, undefined);
  f.runtime.setGitHubCredential(1, null);
  await f.runtime.spawnAppServer(f.id, { env });
  assert.equal(JSON.parse(spawned.options.env.NEW_API_CODEX_RUNTIME_ENV).GH_TOKEN, undefined);
  assert.equal(JSON.parse(spawned.options.env.NEW_API_CODEX_RUNTIME_ENV).GIT_CONFIG_VALUE_1, undefined);
});

test('project deletion preserves the shared container, sibling files and user home', async () => {
  const f = await fixture(), second = randomUUID(); await f.files.create(second, 1); await f.runtime.start(f.id);
  await f.files.write(second, 'keep.txt', 'keep', null); const before = await f.runtime.inspect(second);
  await f.files.remove(f.id);
  assert.equal((await f.runtime.inspect(second)).Id, before.Id); assert.equal((await f.files.read(second, 'keep.txt')).content, 'keep');
  assert.equal(f.calls.some((call) => ['stop', 'rm'].includes(call.args[0])), false);
});

test('stopAppServer uses only project cleanup and disk usage counts the user root', async () => {
  const f = await fixture(); await f.runtime.start(f.id); await f.runtime.stopAppServer(f.id); await f.runtime.diskUsage(f.id);
  const args = f.calls.find((call) => call.args.includes('/opt/new-api-codex/workspace-process.py')).args;
  assert.deepEqual(args.slice(-2), ['stop', f.id]); assert.equal((await f.runtime.inspect(f.id)).State.Running, true);
  assert.equal(f.calls.find((call) => call.program === 'du').args.at(-1), path.join(f.dataDir, 'users', '1'));
});

test('user can start an empty environment and startup also stops owners without projects', async () => {
  const f = await fixture(); await f.runtime.startUser(99); const running = await f.runtime.inspectUser(99); assert.equal(running.State.Running, true);
  await f.runtime.initialize([{ id: f.id, ownerId: 1 }]); assert.equal((await f.runtime.inspectUser(99)).State.Running, false);
  const environment = await f.runtime.environment(99); assert.equal(environment.status, 'stopped'); assert.equal(environment.diskBytes, 1024);
});

test('a status poll spanning container start cannot cache or return an obsolete stopped state', async () => {
  const f = await fixture(); await f.runtime.start(f.id); await f.runtime.stopUser(1);
  let release, entered;
  const delayed = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  const measure = f.runtime.userDiskUsage.bind(f.runtime);
  f.runtime.userDiskUsage = async (ownerId) => { entered(); await delayed; return measure(ownerId); };
  const pending = f.runtime.environment(1); await started;
  await f.runtime.start(f.id); release();
  assert.equal((await pending).status, 'running');
  assert.equal((await f.runtime.environment(1)).status, 'running');
});

test('a transient disk scan failure during file changes does not stop an in-budget user environment', async () => {
  const f = await fixture(); await f.runtime.start(f.id);
  let scans = 0;
  f.runtime.command = async (program, args, options) => {
    if (program !== 'du') return f.command(program, args, options);
    if (++scans === 1) return { code: 1, stdout: '512\t/user\n', stderr: "du: cannot access '/user/cache.tmp': No such file or directory\n" };
    return { code: 0, stdout: '1024\t/user\n', stderr: '' };
  };
  assert.deepEqual(await f.runtime.enforceUserDiskLimit(1), { bytes: 1024, limit: f.runtime.resources(1).workspaceBytes });
  assert.equal((await f.runtime.inspectUser(1)).State.Running, true);
});

test('persistent disk scan failures cannot turn a partial count into a valid budget measurement', async () => {
  const f = await fixture(); let scans = 0;
  f.runtime.command = async (program, args, options) => {
    if (program !== 'du') return f.command(program, args, options);
    scans++; return { code: 1, stdout: '512\t/user\n', stderr: 'du: Permission denied\n' };
  };
  await assert.rejects(f.runtime.enforceUserDiskLimit(1), { code: 'storage_unavailable', statusCode: 503 });
  assert.ok(scans <= 3, 'failure retries must remain bounded');
});

test('a successful retry still enforces the actual disk quota', async () => {
  const f = await fixture(); await f.runtime.start(f.id); let scans = 0;
  f.runtime.command = async (program, args, options) => {
    if (program !== 'du') return f.command(program, args, options);
    if (++scans === 1) return { code: 1, stdout: '', stderr: 'Transient file change' };
    return { code: 0, stdout: `${f.runtime.resources(1).workspaceBytes + 1}\t/user\n`, stderr: '' };
  };
  await assert.rejects(f.runtime.enforceUserDiskLimit(1), { code: 'workspace_storage_limit', statusCode: 507 });
  assert.equal((await f.runtime.inspectUser(1)).State.Running, false);
});

test('storage checks can report usage before the manager stops the container', async () => {
  const f = await fixture(); await f.runtime.start(f.id);
  const usage = f.runtime.resources(1).workspaceBytes + 1;
  f.runtime.command = async (program, args, options) => program === 'du'
    ? { code: 0, stdout: `${usage}\t/user\n`, stderr: '' }
    : f.command(program, args, options);
  await assert.rejects(f.runtime.enforceUserDiskLimit(1, {stop:false}), {code:'workspace_storage_limit',usedBytes:usage,limitBytes:f.runtime.resources(1).workspaceBytes});
  assert.equal((await f.runtime.inspectUser(1)).State.Running,true);
});
