import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from './store.mjs';
import { WorkspaceManager } from './manager.mjs';
import { CodexRpc } from './rpc.mjs';
import { createRunnerServer, loadConfig } from './server.mjs';

class FixtureRuntime {
  constructor() { this.children = new Map(); this.requests = []; this.turns = 0; this.stops = []; this.owners = new Map(); this.environments = new Map(); this.containerStarts = []; this.githubCredentials = new Map(); }
  setGitHubCredential(ownerId, credential) { if (credential) this.githubCredentials.set(ownerId, credential); else this.githubCredentials.delete(ownerId); }
  registerWorkspace(id, ownerId) { this.owners.set(id, ownerId); }
  unregisterWorkspace(id) { this.owners.delete(id); }
  async initialize(workspaces) { for (const workspace of workspaces) this.registerWorkspace(workspace.id, workspace.ownerId); }
  cwd(id) { return `/workspace/projects/${id}/project`; }
  async environment(ownerId) { return this.environments.get(ownerId) || { status: 'not_created', mode: 'code', diskLimitBytes: 2 * 1024 ** 3 }; }
  async startUser(ownerId, { mode = 'code' } = {}) {
    this.environments.set(ownerId, { status: 'running', mode, diskLimitBytes: 2 * 1024 ** 3 });
    this.containerStarts.push(ownerId);
  }
  async stopUser(ownerId) {
    this.stops.push(ownerId);
    const info = await this.environment(ownerId);
    if (info.status !== 'not_created') this.environments.set(ownerId, { ...info, status: 'stopped' });
    for (const [id, owner] of this.owners) if (owner === ownerId) this.children.get(id)?.kill();
  }
  async stopAppServer(id, { processId = id } = {}) { this.children.get(processId === id ? id : `${id}:${processId}`)?.kill(); }
  async baseline() {}
  async spawnAppServer(id, { processId = id } = {}) {
    const sessionId = processId === id ? id : `${id}:${processId}`;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.send = (value) => child.stdout.write(JSON.stringify(value) + '\n');
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    child.stdin = new Writable({ write: (chunk, _, done) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line); this.requests.push(message); this.onRequest?.(message, child);
        if (!message.method || !('id' in message)) continue;
        const failure = this.rpcFailures?.get(message.method);
        if (failure) { queueMicrotask(() => child.send({ id: message.id, error: failure })); continue; }
        if (this.unansweredMethods?.has(message.method)) continue;
        let result = {};
        if (message.method === 'initialize') result = { userAgent: 'fixture/0.160.0' };
        else if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: message.params.threadId || `thread-${sessionId}`, turns: [] } };
        else if (message.method === 'thread/fork') result = { thread: { id: `fork-${this.requests.filter((request) => request.method === 'thread/fork').length}-${id}`, forkedFromId: message.params.threadId, turns: [] } };
        else if (message.method === 'turn/start') { this.turns++; result = { turn: { id: `turn-${this.turns}`, status: 'inProgress', items: [] } }; }
        queueMicrotask(() => {
          if (message.method === 'thread/fork') child.send({ method: 'thread/started', params: { thread: result.thread } });
          child.send({ id: message.id, result });
        });
      }
      done();
    } });
    this.children.set(sessionId, child);
    return child;
  }
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-runner-test-'));
  const config = { dataDir, key: 'service-secret-' + 'x'.repeat(32), apiKey: 'test-api-key-' + 'y'.repeat(32), apiBaseUrl: 'http://127.0.0.1:9999/v1', models: ['fixture-model'], efforts: ['medium', 'high'], defaultModel: 'fixture-model', defaultEffort: 'medium', maxActive: 2, maxWorkspaces: 4, idleSeconds: 600, ...overrides };
  const runtime = new FixtureRuntime();
  const files = { initialize: async () => {}, create: async () => {}, remove: async () => {}, exportZip: async () => Buffer.from('zip'), diff: async () => ({ diff: '', files: [], truncated: false }), write: async (_, path, content) => ({ path, content }), list: async () => ({ path: '', entries: [] }) };
  const store = new WorkspaceStore({ dataDir, maxEvents: 10 });
  const manager = new WorkspaceManager({ store, files, runtime, config });
  await manager.initialize();
  const server = createRunnerServer({ manager, key: config.key });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { owner = '1', key = config.key, body, ...options } = {}) => {
    const response = await fetch(base + path, { ...options, headers: { 'X-Codex-Runner-Key': key, 'X-Codex-Admin-Id': owner, 'Content-Type': 'application/json', ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { config, runtime, manager, store, request, dataDir, base };
}

async function newWorkspace(context, owner = '1') {
  const { data } = await context.request('/workspaces', { owner, method: 'POST', body: { name: 'Website project' } });
  return data.workspace.id;
}
const turnInput = () => ({ prompt: 'Update the website', model: 'fixture-model', effort: 'high', mode: 'code', requestId: randomUUID() });

test('a startup failure before submitting to Codex can retry the same retained draft exactly once', async (t) => {
  const context = await fixture(t);
  const id = await newWorkspace(context);
  const input = turnInput();
  context.runtime.baseline = async () => { throw Object.assign(new Error('Host directory snapshot failed'), {code:'remote_operation_failed',statusCode:409}); };
  const failed = await context.request(`/workspaces/${id}/turns`, {method:'POST',body:input});
  assert.equal(failed.status,409);assert.equal(context.runtime.turns,0);
  context.runtime.baseline = async () => {};
  const retry = await context.request(`/workspaces/${id}/turns`, {method:'POST',body:input});
  assert.equal(retry.status,200);assert.equal(context.runtime.turns,1);
  const duplicate = await context.request(`/workspaces/${id}/turns`, {method:'POST',body:input});
  assert.equal(duplicate.status,200);assert.equal(duplicate.data.turnId,retry.data.turnId);assert.equal(context.runtime.turns,1);
});

test('a rejection after submitting to Codex never resubmits the same request', async (t) => {
  const context = await fixture(t);
  const id = await newWorkspace(context);
  const input = turnInput();
  context.runtime.rpcFailures = new Map([['turn/start',{code:-32000,message:'Upstream rejected task'}]]);
  const failed = await context.request(`/workspaces/${id}/turns`, {method:'POST',body:input});
  assert.equal(failed.success,false);
  context.runtime.rpcFailures.clear();
  const retry = await context.request(`/workspaces/${id}/turns`, {method:'POST',body:input});
  assert.equal(retry.success,false);assert.equal(retry.code,failed.code);
  assert.equal(context.runtime.requests.filter(request=>request.method==='turn/start').length,1);
});

test('disconnecting during task startup leaves server execution, persistence and explicit stop independent', { timeout: 15000 }, async (t) => {
  const context = await fixture(t);
  const id = await newWorkspace(context);
  const input = turnInput();
  context.runtime.unansweredMethods = new Set(['turn/start']);
  const nativeStart = new Promise((resolve) => {
    context.runtime.onRequest = (message, child) => {
      if (message.method === 'turn/start') resolve({ message, child });
    };
  });
  const browser = new AbortController();
  const submitted = context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input, signal: browser.signal });
  const aborted = assert.rejects(submitted, { name: 'AbortError' });
  const { message, child } = await nativeStart;
  browser.abort();
  await aborted;
  const started = new Promise((resolve) => {
    const listen = (event) => {
      if (event.method === 'turn/started') { context.store.off(id, listen); resolve(); }
    };
    context.store.on(id, listen);
  });
  child.send({ id: message.id, result: { turn: { id: 'offline-turn', status: 'inProgress', items: [] } } });
  await started;
  context.runtime.unansweredMethods.clear();
  const state = context.store.get(1, id);
  context.manager.runningOwners.set(1, Date.now() - 3600000);
  context.manager.sessions.get(id).lastUsed = Date.now() - 3600000;
  await context.manager.reapIdle();
  assert.equal(state.workspace.status, 'running');
  assert.equal(child.killed, undefined, 'an active task is not an idle environment');
  assert.deepEqual(context.runtime.stops, []);
  const completed = new Promise((resolve) => {
    const listen = (event) => {
      if (event.method === 'turn/completed') { context.store.off(id, listen); resolve(); }
    };
    context.store.on(id, listen);
  });
  child.send({ method: 'item/completed', params: { threadId: state.workspace.threadId, turnId: 'offline-turn', item: { id: 'offline-answer', type: 'agentMessage', text: 'Finished while the website was closed' } } });
  child.send({ method: 'turn/completed', params: { threadId: state.workspace.threadId, turn: { id: 'offline-turn', status: 'completed', items: [] } } });
  await completed;
  await context.store.persist(state);
  const reconnected = await context.request(`/workspaces/${id}`);
  assert.equal(reconnected.data.workspace.status, 'idle');
  assert.equal(reconnected.data.thread.turns[0].items[0].text, 'Finished while the website was closed');
  const disk = new WorkspaceStore({ dataDir: context.dataDir });
  await disk.initialize();
  assert.equal(disk.get(1, id).thread.turns[0].items[0].text, 'Finished while the website was closed');
  const count = context.runtime.requests.filter((entry) => entry.method === 'turn/start').length;
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input })).status, 200);
  assert.equal(context.runtime.requests.filter((entry) => entry.method === 'turn/start').length, count, 'recovery must not bill a duplicate turn');
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() })).status, 200);
  assert.equal((await context.request(`/workspaces/${id}/interrupt`, { method: 'POST', body: {} })).status, 200);
  assert.equal(context.store.get(1, id).workspace.status, 'interrupted');
  assert.equal(child.killed, true, 'explicit Stop still stops the native task');
});

for (const mode of ['auto', 'full-access']) {
  test(`${mode} persists the permission mode and sends the native no-approval policy without changing Docker mounts`, async (t) => {
    const context = await fixture(t);
    const id = await newWorkspace(context);
    const result = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: { ...turnInput(), mode } });
    assert.equal(result.status, 200);
    assert.equal(result.data.workspace.mode, mode);
    assert.equal(context.runtime.environments.get(1).mode, 'code');
    const start = context.runtime.requests.find((entry) => entry.method === 'thread/start');
    const turn = context.runtime.requests.find((entry) => entry.method === 'turn/start');
    assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(turn.params.approvalPolicy, 'never');
    assert.deepEqual(turn.params.sandboxPolicy, mode === 'full-access' ? { type: 'dangerFullAccess' } : { type: 'externalSandbox', networkAccess: 'enabled' });
    const state = context.store.get(1, id);
    assert.equal(JSON.parse(await readFile(join(context.dataDir, 'state', `${id}.json`), 'utf8')).workspace.mode, mode);
    const child = context.runtime.children.get(id);
    child.send({ id: 'auto-command', method: 'item/commandExecution/requestApproval', params: { threadId: state.workspace.threadId, command: 'npm test' } });
    assert.deepEqual(context.runtime.requests.find((entry) => entry.id === 'auto-command')?.result, { decision: 'accept' });
    assert.equal(state.pendingApprovals.length, 0);
    child.send({ id: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Choose a color' }] } });
    assert.equal(state.pendingApprovals[0]?.method, 'item/tool/requestUserInput');
    await assert.rejects(context.manager.turn(1, id, { ...turnInput(), mode: 'unrestricted-host' }), { code: 'invalid_mode' });
  });
}

test('changing permission mode cannot reuse a billable request ID and read-only restores its native sandbox and approval policy', async (t) => {
  const context = await fixture(t);
  const id = await newWorkspace(context);
  const input = { ...turnInput(), mode: 'full-access' };
  await context.manager.turn(1, id, input);
  await assert.rejects(context.manager.turn(1, id, { ...input, mode: 'auto' }), { code: 'idempotency_conflict' });
  assert.equal(context.runtime.turns, 1);
  await context.manager.interrupt(1, id);
  await context.manager.turn(1, id, { ...turnInput(), mode: 'ask' });
  assert.equal(context.runtime.environments.get(1).mode, 'code');
  const latest = context.runtime.requests.filter((entry) => entry.method === 'turn/start').at(-1);
  assert.equal(latest.params.approvalPolicy, 'on-request');
  assert.deepEqual(latest.params.sandboxPolicy, { type: 'externalSandbox', networkAccess: 'enabled' });
});

// These are protocol and isolation contracts, not tests of the chosen file layout.
test('runner rejects browser/direct unauthorized access and isolates administrator projects', async (t) => {
  const context = await fixture(t);
  const id = await newWorkspace(context);
  assert.equal((await context.request('/status', { key: 'wrong' })).status, 401);
  assert.equal((await context.request('/status', { owner: '0' })).status, 401);
  assert.equal((await context.request('/status', { headers: { Origin: 'https://hostile.example' } })).status, 403);
  assert.equal((await context.request(`/workspaces/${id}`, { owner: '2' })).status, 404);
  assert.deepEqual((await context.request('/workspaces', { owner: '2' })).data.workspaces, []);
  assert.equal((await context.request(`/workspaces/${id}/turns`, { owner: '2', method: 'POST', body: turnInput() })).status, 404);
});

test('projects keep multiple conversation histories independently addressable', async (t) => {
  const context = await fixture(t);
  const id = await newWorkspace(context);
  const created = await context.request(`/workspaces/${id}/conversations`, {
    method: 'POST',
    body: { name: 'Second conversation' },
  });
  assert.equal(created.status, 200);
  const conversationId = created.data.conversationId;
  assert.match(conversationId, /^[0-9a-f-]{36}$/);
  assert.equal(created.data.conversations.length, 2);
  const conversations = await context.request(`/workspaces/${id}/conversations`);
  assert.deepEqual(
    conversations.data.conversations.map((entry) => entry.name),
    ['Second conversation', 'Conversation 1']
  );
  const input = turnInput();
  assert.equal(
    (await context.request(`/workspaces/${id}/turns?conversation=${conversationId}`, {
      method: 'POST',
      body: input,
    })).status,
    200
  );
  const child = await context.request(`/workspaces/${id}?conversation=${conversationId}`);
  const root = await context.request(`/workspaces/${id}`);
  assert.equal(child.data.conversationId, conversationId);
  assert.equal(child.data.thread.id, `thread-${id}:${conversationId}`);
  assert.equal(root.data.conversationId, id);
  assert.equal(root.data.thread, null);
  assert.equal(root.data.conversations.length, 2);
  assert.equal(context.store.get(1, id).conversations[conversationId].thread.id, `thread-${id}:${conversationId}`);
});

test('conversation archive and restore preserve history and project state across reloads', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context), other = await newWorkspace(context);
  const root = context.store.get(1, id);
  root.thread = { id: 'saved-root-thread', turns: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Keep this history' }] }] };
  root.workspace.threadId = root.thread.id;
  const archived = await context.request(`/workspaces/${id}/conversations/${id}`, { method: 'PATCH', body: { archived: true } });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.workspace.archived, false);
  assert.equal(archived.data.workspace.conversationArchived, true);
  assert.equal(archived.data.thread.turns[0].items[0].text, 'Keep this history');
  const fresh = await context.request(`/workspaces/${id}/conversations`, { method: 'POST', body: { name: 'Second' } });
  assert.equal(fresh.status, 200); assert.equal(fresh.data.workspace.conversationArchived, false); assert.equal(fresh.data.thread, null);
  const second = fresh.data.conversationId;
  const listed = (await context.request(`/workspaces/${id}/conversations`)).data.conversations;
  assert.deepEqual(listed.map(({ id, archived }) => ({ id, archived })).sort((a, b) => a.id.localeCompare(b.id)), [{ id, archived: true }, { id: second, archived: false }].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal((await context.request(`/workspaces/${other}/conversations`)).data.conversations.length, 1);
  assert.equal((await context.request(`/workspaces/${id}/turns?conversation=${id}`, { method: 'POST', body: turnInput() })).code, 'conversation_archived');
  const reloaded = new WorkspaceStore({ dataDir: context.dataDir }); await reloaded.initialize();
  assert.equal(reloaded.get(1, id, id).conversation.archived, true);
  const invalid = await context.request(`/workspaces/${id}/conversations/${id}`, { method: 'PATCH', body: { name: 'Must not change', archived: 'yes' } });
  assert.equal(invalid.status, 400); assert.notEqual(context.store.get(1, id).conversation.name, 'Must not change');
  assert.equal((await context.request(`/workspaces/${id}/conversations/${id}`, { owner: '2', method: 'PATCH', body: { archived: false } })).status, 404);
  const restored = await context.request(`/workspaces/${id}/conversations/${id}`, { method: 'PATCH', body: { archived: false, name: 'Restored history' } });
  assert.equal(restored.status, 200); assert.equal(restored.data.workspace.conversationArchived, false); assert.equal(restored.data.workspace.conversationName, 'Restored history');
});

test('deleting a conversation preserves shared files and other histories including an active replacement', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const second = (await context.request(`/workspaces/${id}/conversations`, { method: 'POST', body: { name: 'Still running' } })).data.conversationId;
  let fileRemovals = 0;
  context.manager.files.remove = async () => { fileRemovals++; };
  const turn = await context.manager.turn(1, id, turnInput(), null, second);
  const child = context.runtime.children.get(`${id}:${second}`);
  child.send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${id}:${second}`, turnId: turn.turnId, itemId: 'answer', delta: 'Preserved output' } });
  for (const options of [{ method: 'PATCH', body: { archived: true } }, { method: 'DELETE' }]) {
    const blocked = await context.request(`/workspaces/${id}/conversations/${second}`, options);
    assert.equal(blocked.status, 409); assert.equal(blocked.code, 'workspace_busy');
  }
  assert.equal((await context.request(`/workspaces/${id}/conversations/${id}`, { owner: '2', method: 'DELETE' })).status, 404);
  const deleted = await context.request(`/workspaces/${id}/conversations/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200); assert.equal(deleted.data.deleted, true); assert.equal(deleted.data.conversationId, second);
  assert.equal(deleted.data.conversations.length, 1); assert.equal(fileRemovals, 0); assert.equal(child.killed, undefined);
  assert.equal((await context.request(`/workspaces/${id}?conversation=${id}`)).status, 404);
  const current = (await context.request(`/workspaces/${id}`)).data;
  assert.equal(current.conversationId, second); assert.equal(current.workspace.status, 'running');
  assert.equal(current.thread.turns[0].items[0].text, 'Preserved output');
  child.send({ method: 'turn/completed', params: { threadId: `thread-${id}:${second}`, turn: { id: turn.turnId, status: 'completed', items: [] } } });
  await context.store.persist(context.store.get(1, id));
  const reloaded = new WorkspaceStore({ dataDir: context.dataDir }); await reloaded.initialize();
  assert.equal(reloaded.get(1, id).conversation.id, second); assert.equal(reloaded.get(1, id).thread.turns[0].items[0].text, 'Preserved output');
  assert.equal(reloaded.get(1, id).workspace.status, 'idle');
});

test('deleting the last or an idle secondary conversation keeps the project and starts fresh identities', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const second = (await context.request(`/workspaces/${id}/conversations`, { method: 'POST', body: { name: 'Secondary' } })).data.conversationId;
  const deletedSecondary = await context.request(`/workspaces/${id}/conversations/${second}`, { method: 'DELETE' });
  assert.equal(deletedSecondary.status, 200); assert.equal(deletedSecondary.data.conversationId, id);
  const turn = await context.manager.turn(1, id, turnInput());
  const child = context.runtime.children.get(id);
  child.send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: turn.turnId, status: 'completed', items: [] } } });
  const deleted = await context.request(`/workspaces/${id}/conversations/${id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200); assert.notEqual(deleted.data.conversationId, id); assert.equal(deleted.data.conversations.length, 1);
  assert.equal(child.killed, true); assert.equal((await context.request('/workspaces')).data.workspaces.length, 1);
  assert.equal(context.runtime.owners.get(id), 1); assert.equal((await context.runtime.environment(1)).status, 'running');
  assert.equal((await context.request(`/workspaces/${id}?conversation=${id}`)).status, 404);
  assert.equal((await context.request(`/workspaces/${id}?conversation=${second}`)).status, 404);
  const current = (await context.request(`/workspaces/${id}`)).data;
  assert.equal(current.thread, null); assert.equal(current.workspace.threadId, null); assert.equal(current.workspace.conversationArchived, false);
  assert.equal(current.conversations[0].turnCount, 0);
  const reloaded = new WorkspaceStore({ dataDir: context.dataDir }); await reloaded.initialize();
  assert.equal(reloaded.get(1, id).conversation.id, current.conversationId); assert.equal(reloaded.get(1, id).thread, null);
});

test('GitHub disconnect stops only its owner, rejects old credentials and redacts split process output before persistence', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context), otherId = await newWorkspace(context, '2');
  const token = 'gho_PRIVATE_FIXTURE_1234567890';
  const grant = { 'X-Codex-GitHub-Token': token, 'X-Codex-GitHub-Login': 'fixture-admin', 'X-Codex-GitHub-Generation': '1' };
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', headers: grant, body: turnInput() })).status, 200);
  assert.equal((await context.request(`/workspaces/${otherId}/turns`, { method: 'POST', owner: '2', body: turnInput() })).status, 200);
  const child = context.runtime.children.get(id), otherChild = context.runtime.children.get(otherId);
  assert.equal(context.runtime.githubCredentials.get(1).token, token);
  assert.equal(context.runtime.githubCredentials.has(2), false);
  const params = { threadId: `thread-${id}`, turnId: 'turn-1', itemId: 'credential-output' };
  child.send({ method: 'item/commandExecution/outputDelta', params: { ...params, delta: 'result ' + token.slice(0, 10) } });
  child.send({ method: 'item/commandExecution/outputDelta', params: { ...params, delta: token.slice(10) + ' done.' } });
  const detail = (await context.request(`/workspaces/${id}`)).data;
  assert.equal(detail.thread.turns[0].items[0].aggregatedOutput, 'result [REDACTED] done.');
  const clear = { 'X-Codex-GitHub-Token': '', 'X-Codex-GitHub-Login': '', 'X-Codex-GitHub-Generation': '2' };
  const disconnected = await context.request('/integrations/github', { method: 'DELETE', headers: clear });
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.data.disconnected, true);
  assert.equal(child.killed, true);
  assert.equal(Boolean(otherChild.killed), false);
  assert.equal(context.runtime.githubCredentials.has(1), false);
  assert.equal(context.store.get(1, id).workspace.status, 'interrupted');
  const stale = await context.request(`/workspaces/${id}/turns`, { method: 'POST', headers: grant, body: turnInput() });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'github_credentials_changed');
  assert.equal(context.runtime.turns, 2);
  assert.equal(JSON.stringify(context.store.get(1, id)).includes(token), false);
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', headers: clear, body: turnInput() })).status, 200);
  assert.equal(context.runtime.githubCredentials.has(1), false);
});

test('GitHub cleanup failure keeps authorization cleared and blocks new work until cleanup is retried', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const grant = { 'X-Codex-GitHub-Token': 'gho_PRIVATE_FIXTURE_1234567890', 'X-Codex-GitHub-Login': 'fixture-admin', 'X-Codex-GitHub-Generation': '1' };
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', headers: grant, body: turnInput() })).status, 200);
  const stop = context.runtime.stopAppServer.bind(context.runtime);
  context.runtime.stopAppServer = async () => { throw new Error('remote server unreachable'); };
  const clear = { 'X-Codex-GitHub-Token': '', 'X-Codex-GitHub-Login': '', 'X-Codex-GitHub-Generation': '2' };
  const failed = await context.request('/integrations/github', { method: 'DELETE', headers: clear });
  assert.equal(failed.status, 503);
  assert.equal(failed.code, 'github_cleanup_failed');
  assert.equal(context.runtime.githubCredentials.has(1), false);
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', headers: clear, body: turnInput() })).status, 503);
  context.runtime.stopAppServer = stop;
  assert.equal((await context.request('/integrations/github', { method: 'DELETE', headers: clear })).status, 200);
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', headers: clear, body: turnInput() })).status, 200);
});

test('idempotent task retries execute once and mismatched payloads conflict', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context); const input = turnInput();
  const first = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  const second = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(first.status, 200); assert.equal(first.data.turnId, 'turn-1');
  assert.equal(second.data.duplicate, true); assert.equal(context.runtime.turns, 1);
  const conflict = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: { ...input, prompt: 'Different request' } });
  assert.equal(conflict.status, 409); assert.equal(context.runtime.turns, 1);
  const command = context.runtime.requests.find((value) => value.method === 'turn/start');
  assert.equal(command.params.sandboxPolicy.type, 'externalSandbox');
  assert.equal(command.params.cwd, `/workspace/projects/${id}/project`);
});

test('native events persist partial text, completed outputs, usage and safe recovery cursors', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() });
  const child = context.runtime.children.get(id); const threadId = `thread-${id}`;
  const before = context.store.get(1, id).cursor;
  child.send({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: { id: 'a', type: 'agentMessage', text: '' } } });
  child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'a', delta: 'hello hello ' } });
  child.send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', itemId: 'a', delta: context.config.apiKey } });
  child.send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { id: 'a', type: 'agentMessage', text: 'hello hello done' } } });
  child.send({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { totalTokens: 50 } } } });
  child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [] } } });
  const detail = await context.request(`/workspaces/${id}`);
  assert.equal(detail.data.thread.turns[0].items[0].text, 'hello hello done');
  assert.equal(detail.data.workspace.status, 'idle');
  assert.equal(detail.data.workspace.tokenUsage.total.totalTokens, 50);
  assert.ok(!JSON.stringify(detail).includes(context.config.apiKey));
  const events = await context.request(`/workspaces/${id}/events?after=${before}`);
  assert.equal(events.data.events.length, 6);
  assert.ok(events.data.events.every((event) => event.time > 0));
  for (let index = 0; index < 12; index++) child.send({ method: 'turn/plan/updated', params: { threadId, turnId: 'turn-1', plan: [{ step: 'work', status: 'completed' }] } });
  assert.equal((await context.request(`/workspaces/${id}/events?after=0`)).data.reset, true);
  assert.equal((await context.request(`/workspaces/${id}/events?after=-1`)).status, 400);
});

test('approvals are owner scoped and user input answers map to the actual pending server request', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() });
  const child = context.runtime.children.get(id);
  child.send({ id: 912, method: 'item/commandExecution/requestApproval', params: { threadId: `thread-${id}`, turnId: 'turn-1', itemId: 'cmd', command: 'npm test' } });
  let detail = (await context.request(`/workspaces/${id}`)).data;
  assert.equal(detail.workspace.status, 'waiting_approval');
  const approvalId = detail.pendingApprovals[0].id;
  assert.equal((await context.request(`/workspaces/${id}/approvals/${approvalId}`, { method: 'POST', owner: '2', body: { decision: 'accept' } })).status, 404);
  assert.equal((await context.request(`/workspaces/${id}/approvals/${approvalId}`, { method: 'POST', body: { decision: 'accept' } })).status, 200);
  assert.deepEqual(context.runtime.requests.find((value) => value.id === 912), { id: 912, result: { decision: 'accept' } });
  assert.equal((await context.request(`/workspaces/${id}/approvals/${approvalId}`, { method: 'POST', body: { decision: 'accept' } })).status, 409);
  child.send({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: `thread-${id}`, turnId: 'turn-1', questions: [{ id: 'color', question: 'Choose a color' }] } });
  detail = (await context.request(`/workspaces/${id}`)).data;
  const answer = { answers: { color: { answers: ['Blue'] } } };
  assert.equal((await context.request(`/workspaces/${id}/approvals/${detail.pendingApprovals[0].id}`, { method: 'POST', body: answer })).status, 200);
  assert.deepEqual(context.runtime.requests.find((value) => value.id === 'question-1').result, answer);
  child.send({ id: 'unknown', method: 'unsupported/request', params: {} });
  assert.equal(context.runtime.requests.find((value) => value.id === 'unknown').error.code, -32601);
});

test('subagent lifecycle cannot replace the root thread, active task or root output', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() });
  const child = context.runtime.children.get(id);
  child.send({ method: 'thread/started', params: { thread: { id: 'sub-thread', turns: [] } } });
  child.send({ method: 'turn/started', params: { threadId: 'sub-thread', turn: { id: 'sub-turn', status: 'inProgress', items: [] } } });
  child.send({ method: 'turn/completed', params: { threadId: 'sub-thread', turn: { id: 'sub-turn', status: 'completed', items: [] } } });
  const detail = (await context.request(`/workspaces/${id}`)).data;
  assert.equal(detail.workspace.threadId, `thread-${id}`); assert.equal(detail.workspace.activeTurnId, 'turn-1');
  assert.equal(detail.workspace.status, 'running'); assert.equal(detail.thread.turns.length, 1);
});

test('restart marks active tasks interrupted, preserves partial output and resumes the same thread', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context); const input = turnInput();
  await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  context.runtime.children.get(id).send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${id}`, turnId: 'turn-1', itemId: 'a', delta: 'partial result' } });
  await context.store.persist(context.store.get(1, id));
  const store = new WorkspaceStore({ dataDir: context.dataDir });
  await store.initialize();
  const recovered = store.get(1, id);
  assert.equal(recovered.workspace.status, 'interrupted');
  assert.equal(recovered.thread.turns[0].items[0].text, 'partial result');
  assert.equal(recovered.requests[input.requestId].turnId, 'turn-1');
  await store.close();
  context.runtime.children.get(id).kill();
  await context.manager.turn(1, id, { ...turnInput(), mode: 'ask' });
  const resumed = context.runtime.requests.filter((request) => request.method === 'thread/resume').at(-1);
  assert.equal(resumed.params.threadId, `thread-${id}`); assert.equal(resumed.params.sandbox, 'danger-full-access');
  assert.equal(context.runtime.requests.filter((request) => request.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'externalSandbox');
});

test('active tasks block file edits, archive and deletion; max active count is enforced', async (t) => {
  const context = await fixture(t, { maxActive: 1 }); const id = await newWorkspace(context); const second = await newWorkspace(context, '2');
  await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() });
  assert.equal((await context.request(`/workspaces/${id}/file`, { method: 'PUT', body: { path: 'a.txt', content: 'a', expectedHash: null } })).status, 409);
  assert.equal((await context.request(`/workspaces/${id}`, { method: 'PATCH', body: { archived: true } })).status, 409);
  assert.equal((await context.request(`/workspaces/${id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await context.request(`/workspaces/${second}/turns`, { owner: '2', method: 'POST', body: turnInput() })).status, 429);
});

test('configured secrets and model allowlists are validated without accepting browser provider overrides', async () => {
  await assert.rejects(loadConfig({ CODEX_RUNNER_KEY: 'short' }), /at least 32/);
  await assert.rejects(loadConfig({ CODEX_RUNNER_KEY: 'x'.repeat(32), CODEX_MODELS: 'model', CODEX_DEFAULT_MODEL: 'other' }), /must be in/);
  const config = await loadConfig({ CODEX_RUNNER_KEY: 'x'.repeat(32), CODEX_MODELS: 'model', CODEX_API_BASE_URL: 'https://api.example/v1' });
  assert.deepEqual(config.models, ['model']); assert.equal(config.defaultModel, 'model');
});

test('history limit visibly stops execution while preserving received content', async (t) => {
  const context = await fixture(t, { historyBytes: 700 }); const id = await newWorkspace(context);
  await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() });
  const child = context.runtime.children.get(id);
  child.send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${id}`, turnId: 'turn-1', itemId: 'a', delta: 'kept' } });
  child.send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${id}`, turnId: 'turn-1', itemId: 'a', delta: 'x'.repeat(1000) } });
  const detail = (await context.request(`/workspaces/${id}`)).data;
  assert.equal(detail.workspace.status, 'error'); assert.match(detail.workspace.lastError, /容量上限/);
  assert.equal(detail.thread.turns[0].items[0].text, 'kept'); assert.equal(child.killed, true);
});

test('RPC tolerates split multibyte output and rejects pending work when stdin closes', async () => {
  const runtime = new FixtureRuntime(); const child = await runtime.spawnAppServer(randomUUID()); const rpc = new CodexRpc(child);
  await rpc.initialize();
  const observed = [];
  rpc.on('message', (message) => observed.push(message));
  const bytes = Buffer.from(JSON.stringify({ method: 'text', params: { delta: '中文' } }) + '\n');
  const chinese = bytes.indexOf(Buffer.from('中'));
  child.stdout.write(bytes.subarray(0, chinese + 1)); child.stdout.write(bytes.subarray(chinese + 1));
  assert.equal(observed[0].params.delta, '中文');
  child.stdin.emit('error', new Error('EPIPE'));
  assert.equal(rpc.closed, true);
  await assert.rejects(rpc.request('thread/read'), /disconnected/);
});

test('interrupt during startup prevents a delayed worker from submitting a new task', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  let releaseBaseline; let enteredBaseline;
  const baselineEntered = new Promise((resolve) => { enteredBaseline = resolve; });
  context.runtime.baseline = async () => { enteredBaseline(); await new Promise((resolve) => { releaseBaseline = resolve; }); };
  const task = context.manager.turn(1, id, turnInput());
  await baselineEntered;
  await context.manager.interrupt(1, id);
  releaseBaseline();
  await assert.rejects(task, /interrupted before it started/);
  assert.equal(context.runtime.turns, 0);
  assert.equal(context.store.get(1, id).workspace.status, 'interrupted');
});

test('uncertain task acknowledgment is not resubmitted when the browser retries', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context); const input = turnInput();
  const original = context.manager.ensureSession.bind(context.manager);
  context.manager.ensureSession = async (state) => {
    const session = await original(state);
    const originalRequest = session.rpc.request.bind(session.rpc);
    session.rpc.request = async (method, params) => {
      if (method === 'turn/start') {
        context.runtime.turns++;
        throw Object.assign(new Error('timed out'), { code: 'runtime_timeout', statusCode: 504 });
      }
      return originalRequest(method, params);
    };
    return session;
  };
  const first = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(first.status, 504);
  const retry = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true); assert.equal(context.runtime.turns, 1);
  assert.equal(context.store.get(1, id).requests[input.requestId].status, 'uncertain');
});

test('failed archive requests cannot partially rename the workspace', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  const response = await context.request(`/workspaces/${id}`, { method: 'PATCH', body: { name: 'Mutated', archived: true } });
  assert.equal(response.status, 409); assert.equal(context.store.get(1, id).workspace.name, 'Website project');
});

test('status accurately reports a configured but unavailable container runtime', async (t) => {
  const context = await fixture(t);
  context.runtime.availability = async () => ({ available: false, reason: 'Worker image is missing' });
  const response = await context.request('/status');
  assert.equal(response.data.configured, true); assert.equal(response.data.available, false);
  assert.equal(response.data.reason, 'Worker image is missing');
});

test('summary-only completion preserves user messages and executed tools in history', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  const child = context.runtime.children.get(id); const threadId = `thread-${id}`;
  const user = { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Build it' }] };
  const tool = { id: 'tool-1', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'passed', status: 'completed' };
  child.send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: user } });
  child.send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: tool } });
  child.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', itemsView: 'summary', items: [{ id: 'assistant-1', type: 'agentMessage', text: 'Done' }] } } });
  const detail = context.store.detail(context.store.get(1, id));
  assert.deepEqual(detail.thread.turns[0].items.map((item) => item.id), ['user-1', 'tool-1', 'assistant-1']);
});

test('late notifications from a stopped worker cannot revive an interrupted task', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  const child = context.runtime.children.get(id);
  await context.manager.stopSession(id);
  const state = context.store.get(1, id);
  state.workspace.status = 'interrupted'; state.workspace.activeTurnId = null;
  const cursor = state.cursor;
  child.send({ method: 'turn/started', params: { threadId: `thread-${id}`, turn: { id: 'late-turn', status: 'inProgress', items: [] } } });
  assert.equal(state.workspace.status, 'interrupted'); assert.equal(state.cursor, cursor);
});


test('environment starts no model session, persists one user environment across projects and stops without deleting history', async (t) => {
  const context = await fixture(t);
  const initial = (await context.request('/environment')).data.environment;
  assert.equal(initial.status, 'not_created'); assert.equal(initial.projectCount, 0);
  const started = await context.request('/environment/start', { method: 'POST', body: {} });
  assert.equal(started.data.environment.status, 'running'); assert.equal(context.runtime.requests.length, 0);
  const first = await newWorkspace(context); const second = await newWorkspace(context);
  const summary = (await context.request('/environment')).data.environment;
  assert.equal(summary.projectCount, 2); assert.equal(summary.limits.cpuPercent, 5);
  assert.equal(context.runtime.environments.size, 1);
  const stopped = (await context.request('/environment/stop', { method: 'POST', body: {} })).data.environment;
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.projectCount, 2);
  assert.equal((await context.request(`/workspaces/${first}`)).status, 200);
  assert.equal((await context.request(`/workspaces/${second}`)).status, 200);
  assert.equal(context.runtime.requests.length, 0);
});

test('active projects protect whole-environment operations while new projects and parallel tasks remain available', async (t) => {
  const context = await fixture(t,{maxActive:4});
  const first = await newWorkspace(context); const second = await newWorkspace(context); const other = await newWorkspace(context, '2');
  await context.manager.turn(1, first, turnInput());
  const environment = (await context.request('/environment')).data.environment;
  assert.equal(environment.activeWorkspaceId, first); assert.equal(environment.activeWorkspaceName, 'Website project');
  for (const [path, options] of [
    ['/environment/stop', { method: 'POST', body: {} }],
    [`/workspaces/${second}/file`, { method: 'PUT', body: { path: 'a', content: 'b', expectedHash: null } }],
    [`/workspaces/${second}/export`, {}],
    [`/workspaces/${second}/diff`, {}],
    [`/workspaces/${second}`, { method: 'DELETE' }],
  ]) {
    const result = await context.request(path, options);
    assert.equal(result.status, 409, path); assert.equal(result.code, 'environment_busy', path);
  }
  assert.equal((await context.request('/workspaces', {method:'POST',body:{name:'another'}})).status,200);
  assert.equal((await context.request(`/workspaces/${second}/turns`,{method:'POST',body:turnInput()})).status,200);
  assert.equal((await context.request(`/workspaces/${first}/diff`)).status, 200);
  assert.equal((await context.request(`/workspaces/${second}/files`)).status, 200);
  assert.equal((await context.request(`/workspaces/${other}/turns`, { owner: '2', method: 'POST', body: turnInput() })).status, 200);
  const unrelated = (await context.request('/environment', { owner: '3' })).data.environment;
  assert.equal(unrelated.activeWorkspaceId, null); assert.equal(unrelated.activeWorkspaceName, null); assert.equal(unrelated.projectCount, 0);
});

test('manual starts and automatic starts share the global environment capacity reservation', async (t) => {
  const context = await fixture(t);
  const results = await Promise.all(['1', '2', '3'].map((owner) => context.request('/environment/start', { owner, method: 'POST', body: {} })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 429]);
  assert.equal(context.runtime.environments.size, 2); assert.equal(context.runtime.requests.length, 0);
  const denied = results.findIndex((result) => result.status === 429) + 1;
  const project = await newWorkspace(context, String(denied));
  const task = await context.request(`/workspaces/${project}/turns`, { owner: String(denied), method: 'POST', body: turnInput() });
  assert.equal(task.status, 429); assert.equal(task.code, 'environment_limit'); assert.equal(context.runtime.turns, 0);
  const liveOwner = [...context.runtime.environments.keys()][0];
  await context.manager.stopEnvironment(liveOwner);
  assert.equal((await context.request('/environment/start', { owner: String(denied), method: 'POST', body: {} })).status, 200);
});

test('switching projects keeps independent app servers and thread histories in the same user environment', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  await context.manager.turn(1, first, turnInput());
  const firstChild = context.runtime.children.get(first);
  firstChild.send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${first}`, turnId: 'turn-1', itemId: 'a', delta: 'first project history' } });
  firstChild.send({ method: 'turn/completed', params: { threadId: `thread-${first}`, turn: { id: 'turn-1', status: 'completed', items: [] } } });
  await context.manager.turn(1, second, { ...turnInput(), mode: 'ask' });
  assert.notEqual(firstChild.killed, true); assert.deepEqual(context.runtime.stops, []);
  assert.equal(context.runtime.environments.size, 1); assert.equal(context.runtime.environments.get(1).mode, 'code');
  assert.equal((await context.request(`/workspaces/${second}/diff`)).status, 409);
  const secondChild = context.runtime.children.get(second);
  secondChild.send({ method: 'turn/completed', params: { threadId: `thread-${second}`, turn: { id: 'turn-2', status: 'completed', items: [] } } });
  await context.manager.turn(1, first, turnInput());
  assert.notEqual(secondChild.killed, true); assert.deepEqual(context.runtime.stops, []);
  const latest = context.runtime.requests.filter((request) => request.method === 'turn/start').at(-1);
  assert.equal(latest.params.threadId, `thread-${first}`); assert.equal(latest.params.cwd, `/workspace/projects/${first}/project`);
  assert.equal(context.store.get(1, first).thread.turns[0].items[0].text, 'first project history');
});

test('deleting one project does not stop or remove its user environment or another project', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  await context.manager.startEnvironment(1);
  assert.equal((await context.request(`/workspaces/${first}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(context.runtime.stops, []); assert.equal(context.runtime.environments.get(1).status, 'running');
  assert.equal(context.runtime.owners.has(first), false); assert.equal(context.runtime.owners.get(second), 1);
  assert.equal((await context.request(`/workspaces/${second}`)).status, 200);
});

test('environment polling does not renew idle time and sleeping preserves projects without starting models', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.manager.startEnvironment(1);
  const expired = Date.now() - 601_000;
  context.manager.runningOwners.set(1, expired);
  await context.request('/environment');
  assert.equal(context.manager.runningOwners.get(1), expired);
  await context.manager.reapIdle();
  assert.equal(context.runtime.environments.get(1).status, 'stopped');
  assert.equal(context.manager.store.get(1, id).workspace.id, id); assert.equal(context.runtime.requests.length, 0);
});

test('environment errors expose safe state without host paths or secrets', async (t) => {
  const context = await fixture(t);
  context.runtime.environment = async () => { throw new Error('/root/private/host ' + context.config.apiKey); };
  const result = await context.request('/environment');
  assert.equal(result.status, 200); assert.equal(result.data.environment.status, 'error');
  assert.ok(!JSON.stringify(result).includes('/root/private/host')); assert.ok(!JSON.stringify(result).includes(context.config.apiKey));
});


test('concurrent submissions for two projects both execute once without duplicate billable requests', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  const results = await Promise.all([first, second].map((id) => context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200]);
  assert.equal(context.runtime.turns, 2); assert.equal(context.runtime.environments.size, 1);
});

test('a failed worker cleanup blocks reuse of that conversation without blocking independent projects', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  await context.manager.turn(1, first, turnInput());
  context.runtime.children.get(first).send({ method: 'turn/completed', params: { threadId: `thread-${first}`, turn: { id: 'turn-1', status: 'completed', items: [] } } });
  const originalStop = context.runtime.stopAppServer.bind(context.runtime);
  context.runtime.stopAppServer = async () => { throw Object.assign(new Error('Cleanup failed'), { code: 'runtime_stop_failed', statusCode: 503 }); };
  await assert.rejects(context.manager.stopSession(first), /Cleanup failed/);
  assert.equal(context.manager.pendingSessionCleanup.has(first), true);
  await assert.rejects(context.manager.turn(1, first, turnInput()), /Cleanup failed/);
  assert.equal(context.runtime.turns, 1);
  context.runtime.stopAppServer = originalStop;
  await context.manager.turn(1, first, turnInput());
  assert.equal(context.manager.pendingSessionCleanup.has(first), false); assert.equal(context.runtime.turns, 2);
});


test('stopping the user environment recovers safely from failed project cleanup', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  context.runtime.children.get(id).send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: 'turn-1', status: 'completed', items: [] } } });
  const original = context.runtime.stopAppServer.bind(context.runtime);
  context.runtime.stopAppServer = async () => { throw new Error('Cleanup unavailable'); };
  const stopped = await context.manager.stopEnvironment(1);
  assert.equal(stopped.environment.status, 'stopped'); assert.equal(context.manager.pendingSessionCleanup.has(id), false);
  assert.equal(context.runtime.children.get(id).killed, true);
  context.runtime.stopAppServer = original;
  await context.manager.turn(1, id, turnInput());
  assert.equal(context.runtime.turns, 2);
});


test('shared storage monitoring stops an idle environment with background processes too', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context);
  await context.manager.startEnvironment(1);
  context.runtime.enforceDiskLimit = async (workspaceId) => {
    assert.equal(workspaceId, id);
    throw Object.assign(new Error('Disk quota exceeded'), { code: 'workspace_storage_limit', statusCode: 507 });
  };
  await context.manager.reapIdle();
  assert.equal(context.runtime.environments.get(1).status, 'stopped');
  const environment = (await context.manager.environment(1)).environment;
  assert.equal(environment.status, 'error'); assert.match(environment.lastError, /存储/);
  assert.equal(context.store.get(1, id).workspace.status, 'idle');
});


test('an empty user environment still has its shared home storage monitored', async (t) => {
  const context = await fixture(t);
  await context.manager.startEnvironment(1);
  let monitored = false;
  context.runtime.enforceUserDiskLimit = async (ownerId) => {
    monitored = true; assert.equal(ownerId, 1);
    throw Object.assign(new Error('Shared home is too large'), { code: 'workspace_storage_limit', statusCode: 507 });
  };
  await context.manager.reapIdle();
  assert.equal(monitored, true); assert.equal(context.runtime.environments.get(1).status, 'stopped');
});


test('interrupt reaps the actual project app server while preserving the shared container and resumable history', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context); const second = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  const child = context.runtime.children.get(id);
  child.send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${id}`, turnId: 'turn-1', itemId: 'partial', delta: 'Keep partial output' } });
  const result = await context.manager.interrupt(1, id);
  assert.equal(result.workspace.status, 'interrupted'); assert.equal(child.killed, true);
  assert.equal(context.manager.sessions.has(id), false); assert.deepEqual(context.runtime.stops, []);
  assert.equal(context.runtime.environments.get(1).status, 'running');
  assert.equal(context.store.get(1, id).thread.turns[0].items[0].text, 'Keep partial output');
  assert.equal(context.store.get(1, second).workspace.status, 'idle');
  await context.manager.turn(1, id, turnInput());
  assert.equal(context.runtime.requests.filter((value) => value.method === 'thread/resume').at(-1).params.threadId, `thread-${id}`);
});

test('a native interrupted notification cannot allow a new task before project cleanup finishes', async (t) => {
  const context = await fixture(t); const id = await newWorkspace(context); const other = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  let enterCleanup, releaseCleanup;
  const cleanupStarted = new Promise((resolve) => { enterCleanup = resolve; });
  const original = context.runtime.stopAppServer.bind(context.runtime);
  context.runtime.stopAppServer = async (workspaceId) => {
    enterCleanup(); await new Promise((resolve) => { releaseCleanup = resolve; });
    await original(workspaceId);
  };
  const interruption = context.manager.interrupt(1, id);
  await cleanupStarted;
  context.store.get(1, id).workspace.status = 'interrupted';
  await assert.rejects(context.manager.turn(1, id, turnInput()), (error) => error.code === 'workspace_busy');
  releaseCleanup(); await interruption;
  context.runtime.stopAppServer = original;
  await context.manager.turn(1, other, turnInput());
  assert.equal(context.runtime.turns, 2);
});


test('message deletion persists through reload, isolates owners and blocks running tasks', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const state = context.store.get(1, id);
  state.thread = { id: `thread-${id}`, turns: [{ id: 'turn-history', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Original request' }] }] }] };
  state.workspace.threadId = state.thread.id;
  const endpoint = `/workspaces/${id}/turns/turn-history/messages/user`;
  assert.equal((await context.request(endpoint, { method: 'DELETE', owner: '2' })).status, 404);
  const deleted = await context.request(endpoint, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data.thread.turns[0].deletedRoles, ['user']);
  const reopened = new WorkspaceStore({ dataDir: context.dataDir });
  await reopened.initialize();
  assert.deepEqual(reopened.detail(reopened.get(1, id)).thread.turns[0].deletedRoles, ['user']);
  await reopened.close();
  state.workspace.status = 'running';
  assert.equal((await context.request(endpoint, { method: 'DELETE' })).status, 409);
  state.workspace.status = 'idle';
  assert.equal((await context.request(`/workspaces/${id}/turns/missing/messages/user`, { method: 'DELETE' })).status, 404);
});

test('retry forks prior context once and preserves selected and later turns in a durable conversation', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const state = context.store.get(1, id);
  state.workspace.threadId = `thread-${id}`;
  state.thread = { id: state.workspace.threadId, turns: ['previous', 'selected', 'later'].map((id) => ({ id, status: 'completed', items: [] })) };
  const input = { ...turnInput(), prompt: 'Edited request', replayTurnId: 'selected' };
  const result = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(result.status, 200);
  assert.deepEqual(context.runtime.requests.find((request) => request.method === 'thread/fork')?.params, { threadId: `thread-${id}`, beforeTurnId: 'selected', excludeTurns: true, deferGoalContinuation: true });
  assert.deepEqual(state.thread.turns.map((turn) => turn.id), ['previous', 'turn-1']);
  const original = context.store.projectStates(state).find((entry) => entry !== state);
  assert.ok(original);
  assert.equal(original.workspace.threadId, `thread-${id}`);
  assert.deepEqual(original.thread.turns.map((turn) => turn.id), ['previous', 'selected', 'later']);
  assert.notEqual(state.workspace.threadId, original.workspace.threadId);
  assert.equal(state.conversation.branch.parentRevisionId, original.conversation.branch.revisionId);
  const reopened = new WorkspaceStore({ dataDir: context.dataDir });
  await reopened.initialize();
  assert.deepEqual(reopened.get(1, id, original.conversation.id).thread, original.thread);
  await reopened.close();
  const resent = context.runtime.requests.find((request) => request.method === 'turn/start');
  assert.deepEqual(resent.params.input, [{ type: 'text', text: 'Edited request' }]);
  const duplicate = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(context.runtime.turns, 1);
  assert.equal(context.runtime.requests.filter((request) => request.method === 'thread/fork').length, 1);
  assert.equal(context.runtime.requests.some((request) => request.method === 'thread/rollback'), false);
  assert.equal(context.store.projectStates(state).length, 2);
  assert.equal(state.thread.turns.some((turn) => turn.items.some((item) => item.type === 'subagent')), false);
  state.workspace.status = 'idle';
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: { ...turnInput(), replayTurnId: 'missing' } })).status, 404);
});

test('native fork failure preserves original history and repeated request IDs cannot fork or generate twice', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const state = context.store.get(1, id);
  state.workspace.threadId = `thread-${id}`;
  state.thread = { id: state.workspace.threadId, turns: [{ id: 'selected', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Original response' }] }] };
  const original = structuredClone(state.thread);
  context.runtime.rpcFailures = new Map([['thread/fork', { code: -32600, message: 'Fixture fork rejected' }]]);
  const input = { ...turnInput(), replayTurnId: 'selected' };
  const result = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(result.status, 502);
  assert.deepEqual(state.thread, original);
  assert.equal(context.store.projectStates(state).length, 1);
  context.runtime.rpcFailures.clear();
  const duplicate = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(duplicate.status, 502);
  assert.equal(context.runtime.requests.filter((request) => request.method === 'thread/fork').length, 1);
  assert.equal(context.runtime.turns, 0);
  const recovered = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: { ...input, requestId: randomUUID() } });
  assert.equal(recovered.status, 200);
  assert.equal(context.store.projectStates(state).length, 2);
  assert.equal(context.runtime.turns, 1);
});

test('generation failure after a saved fork preserves both histories and rejects a duplicate start', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const state = context.store.get(1, id);
  state.workspace.threadId = `thread-${id}`;
  state.thread = { id: state.workspace.threadId, turns: [{ id: 'selected', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Original response' }] }] };
  context.runtime.rpcFailures = new Map([['turn/start', { code: -32600, message: 'Fixture generation rejected' }]]);
  const input = { ...turnInput(), replayTurnId: 'selected' };
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input })).status, 502);
  const original = context.store.projectStates(state).find((entry) => entry !== state);
  assert.equal(original.thread.turns[0].items[0].text, 'Original response');
  assert.equal(state.thread.turns.length, 0);
  assert.notEqual(state.workspace.threadId, original.workspace.threadId);
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input })).status, 502);
  assert.equal(context.runtime.requests.filter((request) => request.method === 'thread/fork').length, 1);
  assert.equal(context.runtime.requests.filter((request) => request.method === 'turn/start').length, 1);
  const reopened = new WorkspaceStore({ dataDir: context.dataDir });
  await reopened.initialize();
  assert.equal(reopened.get(1, id, original.conversation.id).thread.turns[0].items[0].text, 'Original response');
  await reopened.close();
});

test('an unconfirmed generation start after forking remains idempotent when its response times out', async (t) => {
  const context = await fixture(t, { rpcTimeoutMs: 20 }), id = await newWorkspace(context);
  const state = context.store.get(1, id);
  state.workspace.threadId = `thread-${id}`;
  state.thread = { id: state.workspace.threadId, turns: [{ id: 'selected', status: 'completed', items: [] }] };
  context.runtime.unansweredMethods = new Set(['turn/start']);
  const input = { ...turnInput(), replayTurnId: 'selected' };
  assert.equal((await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input })).status, 504);
  assert.equal(state.requests[input.requestId].status, 'uncertain');
  const duplicate = await context.request(`/workspaces/${id}/turns`, { method: 'POST', body: input });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(context.runtime.requests.filter((request) => request.method === 'thread/fork').length, 1);
  assert.equal(context.runtime.requests.filter((request) => request.method === 'turn/start').length, 1);
  assert.equal(context.store.projectStates(state).length, 2);
});


test('queued turns execute once in per-conversation FIFO order and remain publicly credential-free', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context), otherOwner = await newWorkspace(context, '2');
  const second = id;
  const first = await context.manager.turn(1, id, turnInput());
  const queuedA = { ...turnInput(), prompt: 'First queued', busyAction: 'queue' };
  const queuedB = { ...turnInput(), prompt: 'Second queued', busyAction: 'queue' };
  const authorization = { model: 'fixture-model', group: 'default', token: 'nacx_queued_secret_never_public_123456' };
  const accepted = await context.manager.turn(1, id, queuedA, authorization, second);
  assert.equal(accepted.queued, true); assert.equal(accepted.requestId, queuedA.requestId);
  assert.equal((await context.manager.turn(1, id, queuedA, authorization, second)).duplicate, true);
  await assert.rejects(context.manager.turn(1, id, { ...queuedA, prompt: 'Changed' }, authorization, second), { code: 'idempotency_conflict' });
  await context.manager.turn(1, id, queuedB, null, id);
  const detail = (await context.request(`/workspaces/${id}?conversation=${second}`)).data;
  assert.equal(detail.queuedTurns[0].prompt, 'First queued'); assert.equal(detail.queuedTurns[0].conversationId, second);
  assert.equal(detail.queuedTurns[0].status, 'queued'); assert.equal(JSON.stringify(detail).includes(authorization.token), false);
  assert.equal((await readFile(join(context.dataDir, 'state', id + '.json'), 'utf8')).includes(authorization.token), false);
  await context.manager.turn(2, otherOwner, turnInput());
  assert.equal(context.runtime.turns, 2);
  context.runtime.children.get(id).send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: first.turnId, status: 'completed', items: [] } } });
  await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 3); assert.equal(context.store.get(1, id, second).workspace.status, 'running');
  assert.deepEqual(context.store.detail(context.store.get(1, id, second)).queuedTurns.map(entry=>entry.requestId), [queuedB.requestId]);
  const active = context.store.get(1, id, second).workspace.activeTurnId;
  context.runtime.children.get(id).send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: active, status: 'completed', items: [] } } });
  await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 4); assert.equal(context.store.get(1, id, id).workspace.status, 'running');
  assert.deepEqual(context.runtime.requests.filter((entry) => entry.method === 'turn/start').map((entry) => entry.params.input[0].text), ['Update the website', 'Update the website', 'First queued', 'Second queued']);
});

test('interrupt-and-send takes priority over queued turns and retries never interrupt accepted work', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const first = await context.manager.turn(1, id, turnInput());
  const queued = { ...turnInput(), prompt: 'After priority', busyAction: 'queue' };
  await context.manager.turn(1, id, queued);
  const priority = { ...turnInput(), prompt: 'Run immediately', busyAction: 'interrupt' };
  const result = await context.manager.turn(1, id, priority);
  assert.equal(context.store.get(1, id).thread.turns.find((turn) => turn.id === first.turnId).status, 'interrupted');
  assert.equal(context.runtime.turns, 2); assert.equal(result.turnId, 'turn-2');
  const current = context.runtime.children.get(id);
  assert.equal((await context.manager.turn(1, id, priority)).duplicate, true);
  assert.equal(current.killed, undefined); assert.equal(context.runtime.turns, 2);
  current.send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: result.turnId, status: 'completed', items: [] } } });
  await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 3);
  assert.equal(context.runtime.requests.filter((entry) => entry.method === 'turn/start').at(-1).params.input[0].text, 'After priority');
});

test('queue cancellation, limits and conversation lifecycle protect queued user input', async (t) => {
  const context = await fixture(t,{maxActive:1}), id = await newWorkspace(context);
  const second = (await context.manager.createConversation(1, id, { name: 'Queued conversation' })).conversationId;
  await context.manager.turn(1, id, turnInput());
  const entries = [];
  for (let index = 0; index < 20; index++) { const input = { ...turnInput(), prompt: `Queued ${index}`, busyAction: 'queue' }; entries.push(input); await context.manager.turn(1, id, input, null, second); }
  await assert.rejects(context.manager.turn(1, id, { ...turnInput(), busyAction: 'queue' }, null, second), { code: 'queue_limit' });
  assert.equal((await context.request(`/workspaces/${id}/queue/${entries[0].requestId}?conversation=${second}`, { owner: '2', method: 'DELETE' })).status, 404);
  const cancelled = await context.request(`/workspaces/${id}/queue/${entries[0].requestId}?conversation=${second}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.cancelled, true); assert.equal(cancelled.data.queuedTurns.length, 19);
  await assert.rejects(context.manager.turn(1, id, entries[0], null, second), { code: 'request_cancelled' });
  await assert.rejects(context.manager.renameConversation(1, id, second, { archived: true }), { code: 'conversation_queue_pending' });
  await context.manager.deleteConversation(1, id, second);
  assert.equal(context.store.allStates().flatMap((state) => state.queuedTurns || []).length, 0);
  assert.equal(context.runtime.turns, 1);
});

test('restart preserves queued prompts as paused until explicit credential refresh, then resumes once', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  await context.manager.turn(1, id, turnInput());
  const queued = { ...turnInput(), prompt: 'Restore after restart', busyAction: 'queue' };
  await context.manager.turn(1, id, queued, { model: 'fixture-model', group: 'default', token: 'nacx_before_restart_secret_123456789' });
  await context.manager.close();
  const store = new WorkspaceStore({ dataDir: context.dataDir });
  const runtime = new FixtureRuntime();
  const manager = new WorkspaceManager({ store, runtime, files: context.manager.files, config: context.config });
  await manager.initialize();
  const pending = store.detail(store.get(1, id)).queuedTurns;
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'paused'); assert.match(pending[0].error, /Resume the queue/);
  await manager.processQueue(1); assert.equal(runtime.turns, 0);
  const resumed = await manager.turn(1, id, queued, { model: 'fixture-model', group: 'default', token: 'nacx_after_restart_secret_1234567890' });
  assert.equal(resumed.queued, true);
  await manager.processQueue(1); assert.equal(runtime.turns, 1); assert.equal(store.detail(store.get(1, id)).queuedTurns.length, 0);
  await manager.close();
});

test('expired queued credentials pause visibly without blocking the next queued message', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const first = await context.manager.turn(1, id, turnInput());
  const expired = 'nacx_header.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.signature';
  const paused = { ...turnInput(), prompt: 'Needs authorization', busyAction: 'queue' };
  await context.manager.turn(1, id, paused, { model: 'fixture-model', group: 'default', token: expired });
  await context.manager.turn(1, id, { ...turnInput(), prompt: 'Continue queue', busyAction: 'queue' });
  context.runtime.children.get(id).send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: first.turnId, status: 'completed', items: [] } } });
  await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 2, JSON.stringify(context.store.detail(context.store.get(1, id)).queuedTurns));
  const pending = context.store.detail(context.store.get(1, id)).queuedTurns;
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'paused'); assert.match(pending[0].error, /authorization/);
});


test('freeing environment capacity automatically starts a waiting owner queue', async (t) => {
  const context = await fixture(t, { maxActive: 1 });
  await newWorkspace(context);
  const second = await newWorkspace(context, '2');
  await context.manager.startEnvironment(1);
  const input = { ...turnInput(), busyAction: 'queue' };
  await context.manager.turn(2, second, input);
  await context.manager.processQueue(2);
  assert.equal(context.runtime.turns, 0); assert.equal(context.store.detail(context.store.get(2, second)).queuedTurns[0].status, 'queued');
  await context.manager.stopEnvironment(1);
  await context.manager.queueDrains.get(2);
  assert.equal(context.runtime.turns, 1); assert.equal(context.store.get(2, second).workspace.status, 'running');
  assert.equal(context.store.detail(context.store.get(2, second)).queuedTurns.length, 0);
});

test('queue startup failure remains recoverable without replaying a request that reached RPC', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const originalStart = context.runtime.startUser.bind(context.runtime);
  context.runtime.startUser = async () => { throw Object.assign(new Error('Temporary worker failure'), { code: 'runtime_start_failed', statusCode: 503 }); };
  const input = { ...turnInput(), busyAction: 'queue' };
  await context.manager.turn(1, id, input); await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 0); assert.equal(context.store.detail(context.store.get(1, id)).queuedTurns[0].status, 'paused');
  context.runtime.startUser = originalStart;
  await context.manager.turn(1, id, input); await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 1);
  const active = context.store.get(1, id).workspace.activeTurnId;
  context.runtime.children.get(id).send({ method: 'turn/completed', params: { threadId: `thread-${id}`, turn: { id: active, status: 'completed', items: [] } } });
  const ensureSession = context.manager.ensureSession.bind(context.manager);
  context.manager.ensureSession = async (state) => {
    const session = await ensureSession(state), request = session.rpc.request.bind(session.rpc);
    session.rpc.request = async (method, params) => {
      if (method === 'turn/start') { context.runtime.turns++; throw Object.assign(new Error('Connection lost after send'), { code: 'runtime_stopped', statusCode: 503 }); }
      return request(method, params);
    };
    return session;
  };
  const uncertain = { ...turnInput(), prompt: 'Do not execute twice', busyAction: 'queue' };
  await context.manager.turn(1, id, uncertain); await context.manager.processQueue(1);
  assert.equal(context.runtime.turns, 2); assert.equal(context.store.detail(context.store.get(1, id)).queuedTurns[0].status, 'paused');
  await assert.rejects(context.manager.turn(1, id, uncertain), { code: 'runtime_stopped' });
  await context.manager.processQueue(1); assert.equal(context.runtime.turns, 2);
});


test('single-file uploads preserve raw bytes and cannot bypass owner or active-task guards', async (t) => {
  const context = await fixture(t), id = await newWorkspace(context);
  const received = [];
  context.manager.files.upload = async (workspace, path, bytes) => { received.push({ workspace, path, bytes }); return { path, size: bytes.length }; };
  const bytes = Buffer.from([0, 255, 137, 80, 78, 71]);
  const upload = (owner, contentType = 'application/octet-stream') => fetch(`${context.base}/workspaces/${id}/upload?path=assets%2Fimage.png`, { method: 'POST', headers: { 'X-Codex-Runner-Key': context.config.key, 'X-Codex-Admin-Id': owner, 'Content-Type': contentType }, body: bytes });
  const accepted = await upload('1'); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).data.size, bytes.length);
  assert.deepEqual(received[0], { workspace: id, path: 'assets/image.png', bytes });
  assert.equal((await upload('2')).status, 404); assert.equal((await upload('1', 'text/plain')).status, 415);
  await context.manager.turn(1, id, turnInput());
  const busy = await upload('1'); assert.equal(busy.status, 409); assert.equal((await busy.json()).code, 'environment_busy');
  assert.equal(received.length, 1);
});


test('separate projects run concurrently without killing one another and stop affects only its target', async (t) => {
 const f = await fixture(t,{maxActive:4});
 const a=await newWorkspace(f), b=await newWorkspace(f);
 const first=await f.manager.turn(1,a,turnInput());
 const second=await f.manager.turn(1,b,turnInput());
 assert.equal(f.store.get(1,a).workspace.status,'running');
 assert.equal(f.store.get(1,b).workspace.status,'running');
 assert.notEqual(f.runtime.children.get(a).killed,true);
 f.runtime.children.get(a).send({method:'item/agentMessage/delta',params:{threadId:`thread-${a}`,turnId:first.turnId,itemId:'a',delta:'project A only'}});
 f.runtime.children.get(b).send({method:'item/agentMessage/delta',params:{threadId:`thread-${b}`,turnId:second.turnId,itemId:'b',delta:'project B only'}});
 assert.equal(f.store.get(1,a).thread.turns[0].items[0].text,'project A only');
 assert.equal(f.store.get(1,b).thread.turns[0].items[0].text,'project B only');
 await f.manager.interrupt(1,b);
 assert.equal(f.store.get(1,a).workspace.status,'running');
 assert.notEqual(f.runtime.children.get(a).killed,true);
 assert.equal(f.runtime.children.get(b).killed,true);
});

test('two conversations in one project have independent workers, streams, approvals, and cancellation', async (t) => {
 const f=await fixture(t,{maxActive:4});const id=await newWorkspace(f);
 const created=await f.manager.createConversation(1,id,{name:'Parallel conversation'});
 const second=created.conversationId;
 const firstTurn=await f.manager.turn(1,id,turnInput(),null,id);
 const secondTurn=await f.manager.turn(1,id,turnInput(),null,second);
 const childA=f.runtime.children.get(id),childB=f.runtime.children.get(`${id}:${second}`);
 assert.notEqual(childA,childB);assert.notEqual(childA.killed,true);
 childA.send({method:'item/agentMessage/delta',params:{threadId:`thread-${id}`,turnId:firstTurn.turnId,itemId:'a',delta:'conversation A'}});
 childB.send({method:'item/agentMessage/delta',params:{threadId:`thread-${id}:${second}`,turnId:secondTurn.turnId,itemId:'b',delta:'conversation B'}});
 assert.equal(f.store.get(1,id,id).thread.turns[0].items[0].text,'conversation A');
 assert.equal(f.store.get(1,id,second).thread.turns[0].items[0].text,'conversation B');
 childB.send({id:'b-approval',method:'item/commandExecution/requestApproval',params:{threadId:`thread-${id}:${second}`,command:'npm test'}});
 assert.equal(f.store.get(1,id,id).pendingApprovals.length,0);
 const approval=f.store.detail(f.store.get(1,id,second)).pendingApprovals[0];
 await f.manager.approve(1,id,approval.id,{decision:'accept'},second);
 await f.manager.interrupt(1,id,second);
 assert.equal(f.store.get(1,id,id).workspace.status,'running');assert.notEqual(childA.killed,true);
 assert.equal(childB.killed,true);
});

test('a read-only conversation runs beside writable work without changing shared container mounts', async (t) => {
 const f=await fixture(t,{maxActive:4});const a=await newWorkspace(f),b=await newWorkspace(f);
 await f.manager.turn(1,a,turnInput());
 await f.manager.turn(1,b,{...turnInput(),mode:'ask'});
 assert.equal(f.runtime.environments.get(1).mode,'code');
 assert.notEqual(f.runtime.children.get(a).killed,true);
 assert.deepEqual(f.runtime.requests.filter(r=>r.method==='turn/start').at(-1).params.sandboxPolicy,{type:'externalSandbox',networkAccess:'enabled'});
});


test('model-supported max and ultra are advertised, accepted, and rejected for unsupported models', async (t) => {
 const f=await fixture(t,{models:['gpt-6.1-sol','gpt-6-luna'],defaultModel:'gpt-6.1-sol',efforts:['low','medium','high','xhigh','max','ultra']});
 const models=f.manager.status().models;
 assert.deepEqual(models[0].efforts,['low','medium','high','xhigh','max','ultra']);
 assert.deepEqual(models[1].efforts,['low','medium','high','xhigh','max']);
 const id=await newWorkspace(f);
 await f.manager.turn(1,id,{...turnInput(),model:'gpt-6.1-sol',effort:'ultra'});
 assert.equal(f.runtime.requests.filter(r=>r.method==='turn/start').at(-1).params.effort,'ultra');
 await assert.rejects(f.manager.turn(1,id,{...turnInput(),model:'gpt-6-luna',effort:'ultra'}),{code:'invalid_effort'});
});


test('a new project and conversation can be created while other tasks are active', async (t) => {
 const f=await fixture(t,{maxActive:4});const id=await newWorkspace(f);
 await f.manager.turn(1,id,turnInput());
 const second=(await f.manager.createConversation(1,id,{name:'Parallel after start'})).conversationId;
 await f.manager.turn(1,id,turnInput(),null,second);
 const fresh=await newWorkspace(f);
 await f.manager.turn(1,fresh,turnInput());
 assert.equal(f.runtime.turns,3);
 assert.equal((await f.manager.environment(1)).environment.activeTasks.length,3);
});

test('storage exhaustion preserves its diagnostic for every parallel conversation before stopping processes', async (t) => {
 const f=await fixture(t,{maxActive:4});const id=await newWorkspace(f);
 const second=(await f.manager.createConversation(1,id,{name:'Second'})).conversationId;
 await f.manager.turn(1,id,turnInput(),null,id);await f.manager.turn(1,id,turnInput(),null,second);
 f.runtime.enforceUserDiskLimit=async(owner,options)=>{
  assert.deepEqual(options,{stop:false});
  throw Object.assign(new Error('Storage limit'),{code:'workspace_storage_limit',usedBytes:10284*1024**2,limitBytes:10240*1024**2});
 };
 await f.manager.reapIdle();
 for (const cid of [id,second]) {
  const state=f.store.detail(f.store.get(1,id,cid));
  assert.equal(state.workspace.status,'error');assert.equal(state.workspace.activeTurnId,null);
  assert.equal(state.thread.turns[0].status,'failed');
  assert.match(state.workspace.lastError,/10284 MB.*10240 MB/);
  assert.notEqual(state.workspace.lastError,'Codex process stopped (0)');
 }
 assert.equal((await f.manager.environment(1)).environment.activeTasks.length,0);
});

test('Docker storage exhaustion leaves a parallel host task running', async (t) => {
 const f=await fixture(t,{maxActive:4});const id=await newWorkspace(f);
 f.runtime.host={};
 const policy={userId:1,enabled:true,allowDocker:true,allowSSH:true,allowHost:true,cpuPercent:0,memoryMB:0,diskMB:0,maxProjects:0,idleSeconds:0};
 f.manager.acceptPolicy(1,Buffer.from(JSON.stringify(policy)).toString('base64url'));
 const host=(await f.manager.create(1,{name:'Host task',host:{path:'/tmp/admin-project'}})).workspace.id;
 await f.manager.turn(1,id,turnInput());await f.manager.turn(1,host,{...turnInput(),mode:'full-access'});
 // The Docker backend only stops its container; host processes are independent.
 f.runtime.stopUser=async(owner)=>{
  f.runtime.stops.push(owner);
  f.runtime.environments.set(owner,{...(await f.runtime.environment(owner)),status:'stopped'});
  f.runtime.children.get(id)?.kill();
 };
 f.runtime.enforceUserDiskLimit=async()=>{throw Object.assign(new Error('Storage limit'),{code:'workspace_storage_limit'});};
 await f.manager.reapIdle();
 assert.equal(f.store.get(1,host).workspace.status,'running');
 assert.notEqual(f.runtime.children.get(host).killed,true);
 assert.equal(f.store.get(1,id).workspace.status,'error');
});

test('host projects require administrator policy, bypass Docker and reject access after role loss', async (t) => {
 const context = await fixture(t);
 context.runtime.host = {};
 const denied = await context.request('/workspaces', {method:'POST',body:{name:'Host app',host:{path:'/tmp/admin-project'},allowHost:true}});
 assert.equal(denied.status,403);
 const policy = {userId:1,enabled:true,allowDocker:false,allowSSH:false,allowHost:true,cpuPercent:0,memoryMB:0,diskMB:0,maxProjects:0,idleSeconds:0};
 const headers = {'X-Codex-User-Policy':Buffer.from(JSON.stringify(policy)).toString('base64url')};
 const created = await context.request('/workspaces',{method:'POST',headers,body:{name:'Host app',host:{path:'/tmp/admin-project'}}});
 assert.equal(created.status,200);assert.deepEqual(created.data.workspace.host,{path:'/tmp/admin-project'});
 const id = created.data.workspace.id;
 assert.equal((await context.request(`/workspaces/${id}/turns`,{method:'POST',headers,body:{...turnInput(),mode:'full-access'}})).status,200);
 assert.deepEqual(context.runtime.containerStarts,[]);
 const turn = context.runtime.requests.find(value=>value.method==='turn/start');
 assert.equal(turn.params.sandboxPolicy.type,'dangerFullAccess');
 assert.equal(turn.params.approvalPolicy,'never');
 const revoked = {'X-Codex-User-Policy':Buffer.from(JSON.stringify({...policy,allowHost:false})).toString('base64url')};
 assert.equal((await context.request(`/workspaces/${id}/file?path=README.md`,{headers:revoked})).status,403);
});

test('native account tools stay outside workspace credentials and preserve approval and read-only modes', async (t) => {
 const {createServer} = await import('node:http');
 const calls = [];
 const server = createServer(async (request,response)=>{
  assert.equal(request.headers.authorization,'Bearer nact_fixture-control-only');
  response.setHeader('Content-Type','application/json');
  if(request.url.endsWith('/catalog')) {response.end(JSON.stringify({success:true,data:{tools:[{name:'profile.update',description:'Update your profile',mutating:true,inputSchema:{properties:{display_name:{type:'string'}}}}]}}));return;}
  let input='';for await(const chunk of request)input+=chunk;calls.push(JSON.parse(input));response.end(JSON.stringify({success:true}));
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
 const context=await fixture(t,{apiBaseUrl:`http://127.0.0.1:${server.address().port}/v1`});
 let environment;
 const spawn=context.runtime.spawnAppServer.bind(context.runtime);
 context.runtime.spawnAppServer=async(id,options)=>{environment=options.env;return spawn(id,options)};
 const id=await newWorkspace(context);
 const headers={'X-Codex-Tools-Token':'nact_fixture-control-only'};
 assert.equal((await context.request(`/workspaces/${id}/turns`,{method:'POST',headers,body:turnInput()})).status,200);
 assert.ok(!JSON.stringify(environment).includes('nact_fixture-control-only'));
 const registered=context.runtime.requests.find(value=>value.method==='thread/start').params.dynamicTools;
 assert.deepEqual(registered.map(tool=>tool.name),['newapi_list_tools','newapi_call_tool']);
 const state=context.store.get(1,id),session=context.manager.sessions.get(id);
 await context.manager.accountTools.handle(state,session,{id:600,params:{tool:'newapi_call_tool',arguments:{name:'profile.update',arguments:{display_name:'Owner'}}}});
 assert.equal(calls.length,0);assert.equal(state.pendingApprovals.length,1);
 const approval=state.pendingApprovals[0];
 await context.manager.approve(1,id,approval.id,{decision:'accept'});
 assert.equal(calls.length,1);assert.deepEqual(calls[0],{name:'profile.update',arguments:{display_name:'Owner'},confirmed:true});
 state.workspace.mode='ask';
 await context.manager.accountTools.handle(state,session,{id:601,params:{tool:'newapi_call_tool',arguments:{name:'profile.update',arguments:{display_name:'Forbidden'}}}});
 const reply=context.runtime.requests.find(value=>value.id===601 && value.result);
 assert.equal(reply.result.success,false);assert.equal(calls.length,1);
 state.workspace.mode='full-access';
 await context.manager.accountTools.handle(state,session,{id:602,params:{tool:'newapi_call_tool',arguments:{name:'profile.update',arguments:{display_name:'Approved mode'}}}});
 assert.equal(calls.length,2);assert.equal(state.pendingApprovals.length,0);
 await context.manager.accountTools.handle(state,session,{id:603,params:{tool:'newapi_call_tool',arguments:{name:'profile.update',arguments:{password:'unsupported-secret'}}}});
 assert.equal(calls.length,2);assert.ok(!JSON.stringify(state).includes('unsupported-secret'));
 assert.equal((await context.request(`/workspaces/${id}`)).status,200);
});


test('one environment can run four parallel conversations and cancellation frees only one task slot', async (t) => {
  const f = await fixture(t, { maxActive: 1, maxActiveTasks: 4 });
  const id = await newWorkspace(f);
  const states = [f.store.get(1, id)];
  for (let i = 0; i < 4; i++) {
    const created = await f.manager.createConversation(1, id, { name: `Parallel ${i + 1}` });
    states.push(f.store.get(1, id, created.conversationId));
  }
  await Promise.all(states.slice(0, 4).map(state => f.manager.turn(1, id, turnInput(), undefined, state.conversation.id)));
  assert.equal(f.runtime.turns, 4);
  assert.equal(states.filter(state => state.workspace.status === 'running').length, 4);
  await assert.rejects(f.manager.turn(1, id, turnInput(), undefined, states[4].conversation.id), { code: 'active_limit' });
  await f.manager.interrupt(1, id, states[1].conversation.id);
  assert.equal(states[0].workspace.status, 'running');
  assert.equal(states[2].workspace.status, 'running');
  assert.equal(states[3].workspace.status, 'running');
  await f.manager.turn(1, id, turnInput(), undefined, states[4].conversation.id);
  assert.equal(f.runtime.turns, 5);
  assert.equal(states.filter(state => state.workspace.status === 'running').length, 4);
});

test('task concurrency has an independent default and rejects invalid configured bounds', async () => {
  const env = { CODEX_RUNNER_KEY: 'fixture-runner-key-12345678901234567890', CODEX_MAX_ACTIVE: '1' };
  const config = await loadConfig(env);
  assert.equal(config.maxActive, 1);
  assert.equal(config.maxActiveTasks, 8);
  for (const value of ['0', '65', '2.5']) {
    await assert.rejects(loadConfig({ ...env, CODEX_MAX_ACTIVE_TASKS: value }), /Invalid maxActiveTasks/);
  }
});
