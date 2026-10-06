import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from './store.mjs';
import { WorkspaceManager } from './manager.mjs';
import { CodexRpc } from './rpc.mjs';
import { createRunnerServer, loadConfig } from './server.mjs';

class FixtureRuntime {
  constructor() { this.children = new Map(); this.requests = []; this.turns = 0; this.stops = []; this.owners = new Map(); this.environments = new Map(); this.containerStarts = []; }
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
  async stopAppServer(id) { this.children.get(id)?.kill(); }
  async baseline() {}
  async spawnAppServer(id) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.send = (value) => child.stdout.write(JSON.stringify(value) + '\n');
    child.kill = () => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } };
    child.stdin = new Writable({ write: (chunk, _, done) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line); this.requests.push(message);
        if (!message.method || !('id' in message)) continue;
        let result = {};
        if (message.method === 'initialize') result = { userAgent: 'fixture/0.160.0' };
        else if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: message.params.threadId || `thread-${id}`, turns: [] } };
        else if (message.method === 'turn/start') { this.turns++; result = { turn: { id: `turn-${this.turns}`, status: 'inProgress', items: [] } }; }
        queueMicrotask(() => child.send({ id: message.id, result }));
      }
      done();
    } });
    this.children.set(id, child);
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
  return { config, runtime, manager, store, request, dataDir };
}

async function newWorkspace(context, owner = '1') {
  const { data } = await context.request('/workspaces', { owner, method: 'POST', body: { name: 'Website project' } });
  return data.workspace.id;
}
const turnInput = () => ({ prompt: 'Update the website', model: 'fixture-model', effort: 'high', mode: 'code', requestId: randomUUID() });

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
  assert.equal(summary.projectCount, 2); assert.equal(summary.limits.cpus, 2);
  assert.equal(context.runtime.environments.size, 1);
  const stopped = (await context.request('/environment/stop', { method: 'POST', body: {} })).data.environment;
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.projectCount, 2);
  assert.equal((await context.request(`/workspaces/${first}`)).status, 200);
  assert.equal((await context.request(`/workspaces/${second}`)).status, 200);
  assert.equal(context.runtime.requests.length, 0);
});

test('one active project protects the entire user environment while other owners remain independent', async (t) => {
  const context = await fixture(t);
  const first = await newWorkspace(context); const second = await newWorkspace(context); const other = await newWorkspace(context, '2');
  await context.manager.turn(1, first, turnInput());
  const environment = (await context.request('/environment')).data.environment;
  assert.equal(environment.activeWorkspaceId, first); assert.equal(environment.activeWorkspaceName, 'Website project');
  for (const [path, options] of [
    ['/environment/stop', { method: 'POST', body: {} }],
    ['/workspaces', { method: 'POST', body: { name: 'another' } }],
    [`/workspaces/${second}/turns`, { method: 'POST', body: turnInput() }],
    [`/workspaces/${second}/file`, { method: 'PUT', body: { path: 'a', content: 'b', expectedHash: null } }],
    [`/workspaces/${second}/export`, {}],
    [`/workspaces/${second}/diff`, {}],
    [`/workspaces/${second}`, { method: 'DELETE' }],
  ]) {
    const result = await context.request(path, options);
    assert.equal(result.status, 409, path); assert.equal(result.code, 'environment_busy', path);
  }
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

test('switching projects closes only the previous app server and resumes independent thread histories in one user environment', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  await context.manager.turn(1, first, turnInput());
  const firstChild = context.runtime.children.get(first);
  firstChild.send({ method: 'item/agentMessage/delta', params: { threadId: `thread-${first}`, turnId: 'turn-1', itemId: 'a', delta: 'first project history' } });
  firstChild.send({ method: 'turn/completed', params: { threadId: `thread-${first}`, turn: { id: 'turn-1', status: 'completed', items: [] } } });
  await context.manager.turn(1, second, { ...turnInput(), mode: 'ask' });
  assert.equal(firstChild.killed, true); assert.deepEqual(context.runtime.stops, []);
  assert.equal(context.runtime.environments.size, 1); assert.equal(context.runtime.environments.get(1).mode, 'ask');
  assert.equal((await context.request(`/workspaces/${second}/diff`)).status, 409);
  const secondChild = context.runtime.children.get(second);
  secondChild.send({ method: 'turn/completed', params: { threadId: `thread-${second}`, turn: { id: 'turn-2', status: 'completed', items: [] } } });
  await context.manager.turn(1, first, turnInput());
  assert.equal(secondChild.killed, true); assert.deepEqual(context.runtime.stops, []);
  const resume = context.runtime.requests.filter((request) => request.method === 'thread/resume').at(-1);
  assert.equal(resume.params.threadId, `thread-${first}`); assert.equal(resume.params.cwd, `/workspace/projects/${first}/project`);
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


test('concurrent task submissions for two projects of the same owner execute only once', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  const results = await Promise.all([first, second].map((id) => context.request(`/workspaces/${id}/turns`, { method: 'POST', body: turnInput() })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(context.runtime.turns, 1); assert.equal(context.runtime.environments.size, 1);
});

test('a failed worker cleanup blocks new tasks until that exact cleanup succeeds', async (t) => {
  const context = await fixture(t); const first = await newWorkspace(context); const second = await newWorkspace(context);
  await context.manager.turn(1, first, turnInput());
  context.runtime.children.get(first).send({ method: 'turn/completed', params: { threadId: `thread-${first}`, turn: { id: 'turn-1', status: 'completed', items: [] } } });
  const originalStop = context.runtime.stopAppServer.bind(context.runtime);
  context.runtime.stopAppServer = async () => { throw Object.assign(new Error('Cleanup failed'), { code: 'runtime_stop_failed', statusCode: 503 }); };
  await assert.rejects(context.manager.stopSession(first), /Cleanup failed/);
  assert.equal(context.manager.pendingSessionCleanup.has(first), true);
  await assert.rejects(context.manager.turn(1, second, turnInput()), /Cleanup failed/);
  assert.equal(context.runtime.turns, 1);
  context.runtime.stopAppServer = originalStop;
  await context.manager.turn(1, second, turnInput());
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
  await assert.rejects(context.manager.turn(1, other, turnInput()), (error) => error.code === 'environment_busy');
  releaseCleanup(); await interruption;
  context.runtime.stopAppServer = original;
  await context.manager.turn(1, other, turnInput());
  assert.equal(context.runtime.turns, 2);
});
