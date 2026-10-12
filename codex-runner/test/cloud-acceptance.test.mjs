import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DockerRuntime } from '../docker-runtime.mjs';
import { WorkspaceFiles, runCommand } from '../workspace-files.mjs';
import { WorkspaceManager } from '../manager.mjs';
import { createRunnerServer } from '../server.mjs';
import { WorkspaceStore } from '../store.mjs';

// Opt-in integration acceptance: real HTTP, Docker, Git, shell, persistent
// stores, files, and snapshots. No model endpoint or paid request is used.
// Run with CODEX_CLOUD_ACCEPTANCE_DOCKER=1 and optionally
// CODEX_CLOUD_ACCEPTANCE_IMAGE=<an already installed worker image>.
const enabled = process.env.CODEX_CLOUD_ACCEPTANCE_DOCKER === '1';
const image = process.env.CODEX_CLOUD_ACCEPTANCE_IMAGE || 'new-api:codex-worker-percent-20261006';
const secretV1 = 'cloud-acceptance-private-value-v1-6f4ad21e';
const secretV2 = 'cloud-acceptance-private-value-v2-987aca12';

async function docker(...args) {
  const result = await runCommand('docker', args, { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

function environmentInput(version, { leak = false, fail = false } = {}) {
  return {
    name: 'Acceptance environment',
    description: 'Real isolated Docker acceptance fixture',
    config: {
      repositories: [],
      installScript: [
        'set -eu',
        'test -n "$API_SECRET"',
        'test -n "$RELEASE_LABEL"',
        'printf "setting up %s\\n" "$API_SECRET"',
        'mkdir -p "$HOME/.local/bin" "$HOME/.codex"',
        `printf '#!/bin/sh\\nprintf "tool-${version}\\\\n"\\n' > "$HOME/.local/bin/acceptance-tool"`,
        'chmod +x "$HOME/.local/bin/acceptance-tool"',
        // Credential directories must never become template contents.
        'printf "%s" "$API_SECRET" > "$HOME/.codex/auth.json"',
        'rm -f leaked-credential.txt',
        'git init -q --initial-branch=main',
        `printf 'release-${version}\\n' > release.txt`,
        'git -c user.name=Acceptance -c user.email=acceptance@example.invalid add release.txt',
        'git -c user.name=Acceptance -c user.email=acceptance@example.invalid commit -qm "Prepare release" || test -z "$(git status --porcelain)"',
        ...(leak ? ['printf "%s" "$API_SECRET" > leaked-credential.txt'] : []),
        ...(fail ? ['printf "intentional setup failure\\n" >&2', 'exit 23'] : ['printf "setup verified\\n"']),
      ].join('\n'),
      startSkill: 'Run acceptance-tool and inspect release.txt before making changes.',
      internetAccess: 'enabled',
      allowedDomains: [],
      environmentVariables: [
        { name: 'RELEASE_LABEL', value: `release-${version}`, secret: false },
        { name: 'API_SECRET', value: version === 1 ? secretV1 : secretV2, secret: true },
      ],
      privacy: 'private',
      advanced: { setupTimeoutSeconds: 60 },
    },
  };
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cloud-acceptance-'));
  const owner = randomInt(1_000_000_000, 1_900_000_000);
  const network = `new-api-codex-acceptance-${randomUUID().slice(0, 8)}`;
  const container = `new-api-codex-user-${owner}`;
  const key = `cloud-acceptance-runner-${randomUUID()}`;
  const observedResponses = [];
  let server, manager, runtime;
  let networkCreated = false;
  const config = {
    dataDir, key, apiKey: '', apiBaseUrl: '', models: ['acceptance-model'],
    efforts: ['medium'], defaultModel: 'acceptance-model', defaultEffort: 'medium',
    maxActive: 1, maxWorkspaces: 30, idleSeconds: 600,
  };
  const stopServer = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server = null;
    }
    if (manager) { await manager.close(); manager = null; }
  };
  t.after(async () => {
    await stopServer();
    // The owner and bridge were generated for this fixture; production
    // containers, volumes, networks, and directories are never removed.
    await runCommand('docker', ['rm', '-f', container], { timeoutMs: 30_000 });
    if (networkCreated) await docker('network', 'rm', network);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await docker('image', 'inspect', image);
  const collision = await runCommand('docker', ['inspect', '--type=container', container]);
  assert.notEqual(collision.code, 0, 'Acceptance owner must not collide with an existing container');
  await docker('network', 'create', '--internal', '--driver', 'bridge', '--label', 'new-api.codex.managed=true', network);
  networkCreated = true;
  async function startServer() {
    runtime = new DockerRuntime({
      dataDir, image, network, hostCpuCount: 10,
      cpuPercent: 5, memoryMB: 512,
    });
    const store = new WorkspaceStore({ dataDir });
    const files = new WorkspaceFiles({ dataDir, dockerRuntime: runtime });
    manager = new WorkspaceManager({ store, files, runtime, config });
    await manager.initialize();
    server = createRunnerServer({ manager, key });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  await startServer();
  async function request(url, { method = 'GET', body, actor = owner } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'X-Codex-Runner-Key': key, 'X-Codex-Admin-Id': String(actor), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    for (const secret of [secretV1, secretV2]) assert.equal(raw.includes(secret), false, `HTTP ${method} ${url} leaked a credential`);
    const result = { status: response.status, ...JSON.parse(raw) };
    observedResponses.push({ method, url, status: response.status, success: result.success });
    return result;
  }
  async function ok(url, options) {
    const result = await request(url, options);
    assert.equal(result.status, 200, `${options?.method || 'GET'} ${url}: ${JSON.stringify(result)}`);
    assert.equal(result.success, true);
    return result.data;
  }
  async function waitForOperation(id) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await ok(`/environments/${id}`);
      if ((!result.operation || result.operation.status !== 'running') && !['preparing', 'publishing'].includes(result.environment.status)) return result.environment;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.fail('The environment operation did not finish within 120 seconds');
  }
  async function setup(id) {
    await ok(`/environments/${id}/setup`, { method: 'POST', body: {} });
    return waitForOperation(id);
  }
  async function publish(id) {
    const result = await request(`/environments/${id}/publish`, { method: 'POST', body: {} });
    if (result.status !== 200) return result;
    return { status: 200, environment: await waitForOperation(id) };
  }
  async function execute(workspaceId, script) {
    // This calls the actual execution backend with the environment binding
    // used by tasks. It never starts App Server or submits a model prompt.
    const workspaceEnvironment = await manager.cloud.workspaceEnvironment(owner, workspaceId);
    const result = await runtime.exec(workspaceId, ['sh', '-c', script], { workspaceEnvironment });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  }
  return {
    owner, dataDir, request, ok, setup, publish, waitForOperation, execute,
    observedResponses,
    manager: () => manager,
    markRunning: async (id, running) => {
      const state = manager.store.get(owner, id);
      state.workspace.status = running ? 'running' : 'idle';
      await manager.store.persist(state);
    },
    containerState: async () => JSON.parse(await docker('inspect', container))[0].State,
    restart: async () => { await stopServer(); await startServer(); },
    read: async (id, name) => (await ok(`/workspaces/${id}/file?path=${encodeURIComponent(name)}`)).content,
  };
}

test('cloud user journey: save, publish, independent tasks, republish, reopen, permissions and secret exclusion', { skip: !enabled, timeout: 360_000 }, async t => {
  const f = await fixture(t);
  const created = await f.ok('/environments', { method: 'POST', body: environmentInput(1) });
  const id = created.environment.id;
  assert.equal(created.environment.status, 'draft');
  assert.equal(created.environment.publishedVersion, null);
  const setupWorkspace = created.environment.setupWorkspaceId;
  assert.equal((await f.ok(`/workspaces/${setupWorkspace}/files`)).entries.length, 0, 'Saving a draft must not execute setup');
  const unpreparedPublish = await f.request(`/environments/${id}/publish`, { method: 'POST', body: {} });
  assert.equal(unpreparedPublish.status, 200);
  assert.equal((await f.waitForOperation(id)).publishedVersion, null);
  const rejectedPublication = await f.ok(`/environments/${id}`);
  assert.equal(rejectedPublication.operation.status, 'failed');
  assert.equal(rejectedPublication.operation.error.code, 'environment_setup_required');
  const unpreparedTask = await f.request(`/environments/${id}/tasks`, { method: 'POST', body: { name: 'Too early', requestId: randomUUID() } });
  assert.equal(unpreparedTask.status, 409);

  const ready = await f.setup(id);
  assert.equal(ready.preparedRevision, ready.draftRevision);
  assert.equal(ready.publishedVersion, null, 'Preparation must not publish');
  assert.equal(await f.read(setupWorkspace, 'release.txt'), 'release-1\n');
  const firstPublication = await f.publish(id);
  assert.equal(firstPublication.status, 200);
  assert.equal(firstPublication.environment.status, 'published');
  assert.equal(firstPublication.environment.publishedVersion, 1);
  assert(firstPublication.environment.published.snapshot.files > 0);
  await f.ok(`/workspaces/${setupWorkspace}/events`);
  await f.ok(`/workspaces/${setupWorkspace}`);

  const taskA = (await f.ok(`/environments/${id}/tasks`, { method: 'POST', body: { name: 'Task A', requestId: randomUUID() } })).workspace;
  const taskB = (await f.ok(`/environments/${id}/tasks`, { method: 'POST', body: { name: 'Task B', requestId: randomUUID() } })).workspace;
  assert.notEqual(taskA.id, taskB.id);
  for (const task of [taskA, taskB]) {
    assert.equal(await f.read(task.id, 'release.txt'), 'release-1\n');
    const output = await f.execute(task.id, 'test "$RELEASE_LABEL" = release-1 && test -n "$API_SECRET" && test ! -e "$HOME/.codex/auth.json" && acceptance-tool && git log -1 --format=%s');
    assert.match(output, /tool-1/);
    assert.match(output, /Prepare release/);
  }
  await f.execute(taskA.id, 'printf "task-A-change\\n" > release.txt; printf "A-only-tool\\n" > "$HOME/only-a.txt"');
  assert.equal(await f.read(taskA.id, 'release.txt'), 'task-A-change\n');
  assert.equal(await f.read(taskB.id, 'release.txt'), 'release-1\n');
  await f.execute(taskB.id, 'test ! -e "$HOME/only-a.txt"');

  const updated = await f.ok(`/environments/${id}`, { method: 'PATCH', body: environmentInput(2) });
  assert.equal(updated.environment.publishedVersion, 1);
  assert.equal(updated.environment.status, 'changes_pending');
  assert.equal(await f.read(setupWorkspace, 'release.txt'), 'release-1\n', 'Saving changed configuration must not execute it');
  assert.equal((await f.setup(id)).preparedRevision, updated.environment.draftRevision);
  assert.equal((await f.publish(id)).environment.publishedVersion, 2);
  const taskC = (await f.ok(`/environments/${id}/tasks`, { method: 'POST', body: { name: 'Task C', requestId: randomUUID() } })).workspace;
  assert.equal(await f.read(taskC.id, 'release.txt'), 'release-2\n');
  assert.equal(await f.read(taskA.id, 'release.txt'), 'task-A-change\n');
  assert.equal(await f.read(taskB.id, 'release.txt'), 'release-1\n');
  assert.match(await f.execute(taskC.id, 'test "$RELEASE_LABEL" = release-2 && acceptance-tool'), /tool-2/);
  assert.match(await f.execute(taskA.id, 'test "$RELEASE_LABEL" = release-1 && acceptance-tool && cat "$HOME/only-a.txt"'), /tool-1\nA-only-tool/);

  await f.restart();
  assert.equal((await f.ok(`/environments/${id}`)).environment.publishedVersion, 2);
  assert.equal(await f.read(taskA.id, 'release.txt'), 'task-A-change\n');
  assert.equal(await f.read(taskB.id, 'release.txt'), 'release-1\n');
  assert.equal(await f.read(taskC.id, 'release.txt'), 'release-2\n');
  assert.match(await f.execute(taskA.id, 'test "$RELEASE_LABEL" = release-1 && acceptance-tool && cat "$HOME/only-a.txt"'), /tool-1\nA-only-tool/);
  assert.match(await f.execute(taskC.id, 'test "$RELEASE_LABEL" = release-2 && acceptance-tool'), /tool-2/);

  assert.deepEqual((await f.ok('/environments', { actor: f.owner + 1 })).environments, []);
  for (const [url, method, body] of [
    [`/environments/${id}`, 'GET'],
    [`/environments/${id}`, 'PATCH', environmentInput(1)],
    [`/environments/${id}/setup`, 'POST', {}],
    [`/environments/${id}/publish`, 'POST', {}],
    [`/environments/${id}/tasks`, 'POST', { name: 'Stolen task', requestId: randomUUID() }],
    [`/environments/${id}`, 'DELETE'],
    [`/workspaces/${taskA.id}/file?path=release.txt`, 'GET'],
  ]) assert.equal((await f.request(url, { method, body, actor: f.owner + 1 })).status, 404);

  // Inspect captured file bytes, not metadata assertions about "redaction".
  const snapshots = path.join(f.dataDir, 'cloud-environment-snapshots');
  let snapshotFiles = 0;
  async function checkTree(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = path.join(directory, entry.name);
      if (entry.isDirectory()) await checkTree(name);
      else if (entry.isFile()) {
        snapshotFiles++;
        const bytes = await fs.readFile(name);
        for (const secret of [secretV1, secretV2]) assert.equal(bytes.includes(Buffer.from(secret)), false, 'Published snapshot contains a credential');
      }
    }
  }
  await checkTree(snapshots);
  assert(snapshotFiles > 0);
  t.diagnostic(`Verified ${f.observedResponses.length} HTTP responses and ${snapshotFiles} snapshot files using real Docker image ${image}.`);
});

test('cloud setup and publication failures preserve configuration and can be retried', { skip: !enabled, timeout: 240_000 }, async t => {
  const f = await fixture(t);
  const created = await f.ok('/environments', { method: 'POST', body: environmentInput(1, { fail: true }) });
  const id = created.environment.id;
  const failedSetup = await f.setup(id);
  assert.equal(failedSetup.status, 'error');
  assert.equal(failedSetup.publishedVersion, null);
  assert.match(failedSetup.config.installScript, /exit 23/);
  await f.ok(`/environments/${id}`, { method: 'PATCH', body: environmentInput(1, { leak: true }) });
  const prepared = await f.setup(id);
  assert.equal(prepared.preparedRevision, prepared.draftRevision);
  const blockedPublication = await f.publish(id);
  if (blockedPublication.status === 200) {
    assert.equal(blockedPublication.environment.status, 'error');
    assert.equal(blockedPublication.environment.publishedVersion, null);
  } else assert.equal(blockedPublication.code, 'snapshot_contains_secret');
  assert.equal((await f.ok(`/environments/${id}`)).environment.publishedVersion, null);
  assert.equal((await f.request(`/environments/${id}/tasks`, { method: 'POST', body: { name: 'Unsafe snapshot', requestId: randomUUID() } })).status, 409);
  await f.ok(`/environments/${id}`, { method: 'PATCH', body: environmentInput(1) });
  const retried = await f.setup(id);
  assert.equal(retried.preparedRevision, retried.draftRevision);
  const published = await f.publish(id);
  assert.equal(published.status, 200);
  assert.equal(published.environment.status, 'published');
  const task = (await f.ok(`/environments/${id}/tasks`, { method: 'POST', body: { name: 'Recovered task', requestId: randomUUID() } })).workspace;
  assert.equal(await f.read(task.id, 'release.txt'), 'release-1\n');
  assert.match(await f.execute(task.id, 'test ! -e leaked-credential.txt && acceptance-tool'), /tool-1/);
});


test('materializing another published cloud task keeps an active sibling and its container running', {skip:!enabled,timeout:180000}, async t=>{
 const f=await fixture(t);
 const created=await f.ok('/environments',{method:'POST',body:environmentInput(1)});
 const id=created.environment.id;
 await f.setup(id);await f.publish(id);
 const a=(await f.ok(`/environments/${id}/tasks`,{method:'POST',body:{name:'Active sibling',requestId:randomUUID()}})).workspace;
 await f.execute(a.id,'test -f release.txt');
 await f.markRunning(a.id,true);
 const before=await f.containerState();
 try {
  const b=(await f.ok(`/environments/${id}/tasks`,{method:'POST',body:{name:'Parallel cloud task',requestId:randomUUID()}})).workspace;
  const after=await f.containerState();assert.equal(after.Running,true);assert.equal(after.Pid,before.Pid);
  assert.equal((await f.ok(`/workspaces/${a.id}`)).workspace.status,'running');
  assert.equal(await f.read(b.id,'release.txt'),'release-1\n');
 }finally{await f.markRunning(a.id,false);}
});


test('native read-only and writable app servers run together, enforce mounts, and cancel independently without a model turn', {skip:!enabled,timeout:120000}, async t=>{
 const f=await fixture(t), manager=f.manager();
 manager.config.apiKey='isolated-native-protocol-no-model-key';manager.config.apiBaseUrl='http://127.0.0.1:9/v1';
 const workspace=(await f.ok('/workspaces',{method:'POST',body:{name:'Native parallel fixture'}})).workspace;
 const second=(await manager.createConversation(f.owner,workspace.id,{name:'Read-only conversation'})).conversationId;
 const a=manager.store.get(f.owner,workspace.id,workspace.id),b=manager.store.get(f.owner,workspace.id,second);b.workspace.mode='ask';
 const edit=await manager.ensureSession(a),readonly=await manager.ensureSession(b);
 const command=script=>({command:['sh','-c',script],cwd:manager.runtime.cwd(workspace.id),sandboxPolicy:{type:'externalSandbox',networkAccess:'enabled'},timeoutMs:10000});
 const editable=await edit.rpc.request('command/exec',command('printf editable > parallel-marker.txt; cat parallel-marker.txt'));
 assert.equal(editable.exitCode,0);assert.equal(editable.stdout,'editable');
 const denied=await readonly.rpc.request('command/exec',command('printf forbidden > parallel-marker.txt'));
 assert.notEqual(denied.exitCode,0);assert.match(denied.stderr,/Read-only file system|read-only file system/);
 const name=manager.runtime.readonlyName(f.owner,second), info=JSON.parse(await docker('inspect',name))[0];
 assert.equal(info.HostConfig.ReadonlyRootfs,true);
 assert.equal(info.HostConfig.Memory,512*1024**2);
 assert.equal(info.HostConfig.MemorySwap,512*1024**2);
 const {environment}=await f.ok('/environment');
 assert.equal(environment.limits.memoryBytes,512*1024**2);
 assert.equal('memoryPercent' in environment.limits,false);
 assert.equal(info.Mounts.find(m=>m.Destination==='/workspace/projects').RW,false);
 assert(!JSON.stringify(info.Config.Env).includes(manager.config.apiKey));
 await manager.stopSession(`${workspace.id}:${second}`);
 const alive=await edit.rpc.request('command/exec',command('cat parallel-marker.txt'));
 assert.equal(alive.exitCode,0);assert.equal(alive.stdout,'editable');
 assert.equal(manager.sessions.get(workspace.id),edit);
});
