import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerServer } from '../server.mjs';
import { WorkspaceStore } from '../store.mjs';

async function fixture(t) {
  const key = 'isolated-http-route-fixture-key-over-32-characters';
  const store = new WorkspaceStore({ dataDir: '/unused-http-route-fixture' });
  const project = store.create(1, { name: 'Alpha project', model: 'fixture', effort: 'medium', mode: 'code' });
  project.conversation.name = 'Alpha first';
  const second = store.createConversation(project, 'Alpha archived');
  second.conversation.archived = true;
  const stranger = store.create(2, { name: 'Private alpha', model: 'fixture', effort: 'medium', mode: 'code' });
  const repositoryCalls = [];
  const manager = {
    store, sanitize: value => value,
    async repository(ownerId, id) { repositoryCalls.push({ ownerId, id }); return { repository: { available: true, branch: 'main' } }; },
    async checkoutBranch(ownerId, id, body) { repositoryCalls.push({ ownerId, id, body }); return { repository: { available: true, branch: body.branch } }; },
  };
  const server = createRunnerServer({ manager, key });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function request(path, { ownerId = 1, method = 'GET', body } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'X-Codex-Runner-Key': key, 'X-Codex-Admin-Id': String(ownerId), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ...await response.json() };
  }
  return { request, project, second, stranger, repositoryCalls };
}

test('task HTTP route exposes every owned conversation with filters and pagination', async t => {
  const { request, project, second } = await fixture(t);
  const first = await request('/tasks?query=ALPHA&limit=1&offset=0');
  assert.equal(first.status, 200);
  assert.equal(first.data.tasks.length, 1);
  assert.equal(first.data.total, 2);
  assert.equal(first.data.hasMore, true);
  assert.equal(first.data.nextOffset, 1);
  const last = await request('/tasks?query=ALPHA&limit=1&offset=1');
  assert.equal(last.data.tasks.length, 1);
  assert.equal(last.data.nextOffset, null);
  assert.notEqual(first.data.tasks[0].conversationId, last.data.tasks[0].conversationId);
  const active = await request('/tasks?archived=false');
  assert.deepEqual(active.data.tasks.map(task => task.conversationId), [project.conversation.id]);
  assert.equal(active.data.tasks[0].turnCount, 0);
  assert.equal(active.data.tasks[0].latestTurnStatus, null);
  const archived = await request('/tasks?archived=true');
  assert.deepEqual(archived.data.tasks.map(task => task.conversationId), [second.conversation.id]);
  assert.equal((await request('/tasks?ownerId=2&query=Private')).data.total, 0);
});

test('task HTTP route rejects malformed filters without numeric coercion', async t => {
  const { request } = await fixture(t);
  for (const value of ['', '-1', '0', '1.5', '1e2', '0x10', '1001', 'NaN', ' 1']) {
    const result = await request('/tasks?limit=' + encodeURIComponent(value));
    assert.equal(result.status, 400, `limit ${JSON.stringify(value)}`);
    assert.equal(result.code, 'invalid_task_limit');
  }
  for (const value of ['', '-1', '1.5', '1e2', '100001', 'NaN', ' 1']) {
    const result = await request('/tasks?offset=' + encodeURIComponent(value));
    assert.equal(result.status, 400, `offset ${JSON.stringify(value)}`);
    assert.equal(result.code, 'invalid_task_offset');
  }
  for (const value of ['', '1', 'TRUE', 'all']) {
    const result = await request('/tasks?archived=' + encodeURIComponent(value));
    assert.equal(result.status, 400);
    assert.equal(result.code, 'invalid_task_archive_filter');
  }
  const query = await request('/tasks?query=' + 'a'.repeat(201));
  assert.equal(query.status, 400);
  assert.equal(query.code, 'invalid_task_query');
  assert.equal((await request('/tasks?query=&limit=1000&offset=100000')).status, 200);
});

test('repository HTTP routes resolve owner before dispatch and pass checkout JSON exactly', async t => {
  const { request, project, stranger, repositoryCalls } = await fixture(t);
  const path = `/workspaces/${project.workspace.id}/repository`;
  const read = await request(path);
  assert.equal(read.status, 200);
  assert.equal(read.data.repository.branch, 'main');
  const write = await request(path + '/checkout', { method: 'POST', body: { branch: 'feature/review', remote: 'origin' } });
  assert.equal(write.status, 200);
  assert.deepEqual(repositoryCalls, [
    { ownerId: 1, id: project.workspace.id },
    { ownerId: 1, id: project.workspace.id, body: { branch: 'feature/review', remote: 'origin' } },
  ]);
  const hidden = await request(`/workspaces/${stranger.workspace.id}/repository`);
  assert.equal(hidden.status, 404);
  const denied = await request(`/workspaces/${stranger.workspace.id}/repository/checkout`, { method: 'POST', body: { branch: 'main' } });
  assert.equal(denied.status, 404);
  assert.equal(repositoryCalls.length, 2);
});
