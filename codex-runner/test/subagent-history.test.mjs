import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../store.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-subagent-history-'));
  const store = new WorkspaceStore({ dataDir, ...options });
  await store.initialize();
  const stores = [store];
  t.after(async () => {
    for (const entry of stores) await entry.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    store, dataDir,
    async reopen() {
      await stores.at(-1).close();
      const restored = new WorkspaceStore({ dataDir, ...options });
      await restored.initialize();
      stores.push(restored);
      return restored;
    },
  };
}

function project(store, ownerId = 1, rootId = 'root-thread') {
  const state = store.create(ownerId, { name: 'Isolated subagent test', model: 'fixture', effort: 'medium', mode: 'code' });
  store.record(state, 'thread/started', { thread: { id: rootId, turns: [] } });
  store.record(state, 'turn/started', { threadId: rootId, turn: { id: 'root-turn', status: 'inProgress', items: [] } });
  return state;
}

function descendant(store, state, method, params) {
  return store.record(state, 'workbench/subagent/event', { event: { method, params } });
}

function child(state, threadId = 'child-thread') {
  return state.thread.turns.flatMap((turn) => turn.items).find((item) => item.id === `subagent:${threadId}`);
}

test('child text, tools and plans survive event eviction and disk reload without changing the root lifecycle', async (t) => {
  const context = await fixture(t, { maxEvents: 2 });
  const { store } = context, state = project(store);
  descendant(store, state, 'thread/started', { thread: { id: 'child-thread', name: 'Reviewer', preview: 'Inspect changes', turns: [] } });
  const params = { threadId: 'child-thread', turnId: 'child-turn' };
  descendant(store, state, 'turn/started', { threadId: params.threadId, turn: { id: params.turnId, status: 'inProgress', items: [] } });
  descendant(store, state, 'item/agentMessage/delta', { ...params, itemId: 'answer', delta: 'Verified ' });
  descendant(store, state, 'item/agentMessage/delta', { ...params, itemId: 'answer', delta: 'the change.' });
  descendant(store, state, 'item/started', { ...params, item: { id: 'command', type: 'commandExecution', command: 'node --test', status: 'inProgress' } });
  descendant(store, state, 'item/commandExecution/outputDelta', { ...params, itemId: 'command', delta: '1 passed' });
  descendant(store, state, 'item/completed', { ...params, item: { id: 'command', type: 'commandExecution', status: 'completed', exitCode: 0 } });
  descendant(store, state, 'turn/plan/updated', { ...params, plan: [{ step: 'Inspect', status: 'completed' }], explanation: 'Done' });
  descendant(store, state, 'turn/diff/updated', { ...params, diff: '+verified' });
  descendant(store, state, 'turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'completed', items: [] } });
  assert.equal(state.workspace.threadId, 'root-thread');
  assert.equal(state.workspace.activeTurnId, 'root-turn');
  assert.equal(state.workspace.status, 'running');
  assert.equal(state.thread.turns.length, 1);
  const item = child(state);
  assert.equal(item.agentName, 'Reviewer');
  assert.equal(item.text, 'Inspect changes');
  assert.equal(item.status, 'completed');
  assert.equal(item.items.find((entry) => entry.id === 'answer').text, 'Verified the change.');
  assert.equal(item.items.find((entry) => entry.id === 'command').aggregatedOutput, '1 passed');
  assert.equal(item.turns[0].diff, '+verified');
  assert.deepEqual(item.turns[0].plan, [{ step: 'Inspect', status: 'completed' }]);
  store.record(state, 'turn/completed', { threadId: 'root-thread', turn: { id: 'root-turn', status: 'completed', items: [] } });
  store.record(state, 'thread/started', { thread: { id: 'root-thread', turns: [] } });
  const expected = structuredClone(state.thread);
  const restored = await context.reopen();
  assert.deepEqual(restored.detail(restored.get(1, state.workspace.id)).thread, expected);
  assert.equal(restored.detail(restored.get(1, state.workspace.id)).events.some((event) => event.method === 'workbench/subagent/event'), false);
});

test('late child snapshots and later root turns preserve the original parent and complete output', async (t) => {
  const { store } = await fixture(t), state = project(store);
  const params = { threadId: 'child-thread', turnId: 'child-turn', itemId: 'answer' };
  descendant(store, state, 'item/agentMessage/delta', { ...params, delta: 'Early output' });
  descendant(store, state, 'turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'completed', items: [] } });
  descendant(store, state, 'thread/started', { thread: { id: params.threadId, name: 'Worker', turns: [] } });
  assert.equal(child(state).status, 'completed');
  assert.equal(child(state).items[0].text, 'Early output');
  descendant(store, state, 'thread/started', { thread: { id: 'snapshot-child', turns: [{ id: 'snapshot-turn', status: 'completed', items: [{ id: 'snapshot-answer', type: 'agentMessage', text: 'Already complete' }] }] } });
  assert.equal(child(state, 'snapshot-child').status, 'completed');
  assert.equal(child(state, 'snapshot-child').items[0].text, 'Already complete');
  store.record(state, 'turn/completed', { turn: { id: 'root-turn', status: 'completed', items: [] } });
  store.record(state, 'turn/started', { turn: { id: 'root-turn-2', status: 'inProgress', items: [] } });
  descendant(store, state, 'turn/started', { threadId: params.threadId, turn: { id: 'child-turn-2', status: 'inProgress', items: [] } });
  descendant(store, state, 'item/agentMessage/delta', { ...params, turnId: 'child-turn-2', itemId: 'answer-2', delta: 'Follow-up' });
  assert.equal(state.thread.turns[0].items[0].id, 'subagent:child-thread');
  assert.deepEqual(state.thread.turns[1].items, []);
  assert.equal(child(state).turns.length, 2);
  assert.equal(child(state).items.length, 2);
  assert.equal(state.workspace.activeTurnId, 'root-turn-2');
});

test('legacy raw child events migrate once with the correct historical parent and persist the projection', async (t) => {
  const context = await fixture(t), { store } = context, state = project(store);
  descendant(store, state, 'thread/started', { thread: { id: 'child-thread', turns: [] } });
  descendant(store, state, 'item/agentMessage/delta', { threadId: 'child-thread', turnId: 'child-turn', itemId: 'answer', delta: 'Once only' });
  descendant(store, state, 'turn/completed', { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed', items: [] } });
  store.record(state, 'turn/completed', { turn: { id: 'root-turn', status: 'completed', items: [] } });
  store.record(state, 'turn/started', { turn: { id: 'root-turn-2', status: 'inProgress', items: [] } });
  store.record(state, 'turn/completed', { turn: { id: 'root-turn-2', status: 'completed', items: [] } });
  state.thread.turns[0].items = [];
  const restored = await context.reopen(), entry = restored.get(1, state.workspace.id);
  assert.equal(entry.thread.turns[0].items[0].items[0].text, 'Once only');
  assert.deepEqual(entry.thread.turns[1].items, []);
  const saved = JSON.parse(await readFile(join(context.dataDir, 'state', state.workspace.id + '.json'), 'utf8'));
  assert.equal(saved.thread.turns[0].items[0].items[0].text, 'Once only');
  const reopened = await context.reopen();
  assert.deepEqual(reopened.get(1, state.workspace.id).thread, entry.thread);
});

test('another saved conversation or owner thread cannot be exposed as descendant history or raw events', async (t) => {
  const context = await fixture(t), { store } = context, state = project(store);
  const sibling = store.createConversation(state, 'Private sibling');
  store.record(sibling, 'thread/started', { thread: { id: 'sibling-thread', turns: [] } });
  const otherOwner = project(store, 2, 'other-owner-thread');
  const cursor = state.cursor;
  for (const threadId of ['sibling-thread', 'other-owner-thread']) {
    descendant(store, state, 'thread/started', { thread: { id: threadId, preview: 'Private sibling content', turns: [] } });
    descendant(store, state, 'item/agentMessage/delta', { threadId, turnId: 'private-turn', itemId: 'answer', delta: 'Private output' });
  }
  assert.equal(state.cursor, cursor);
  assert.equal(JSON.stringify(store.detail(state)).includes('Private output'), false);
  assert.equal(JSON.stringify(store.detail(state)).includes('Private sibling content'), false);
  assert.equal(child(sibling), undefined);
  assert.equal(child(otherOwner), undefined);
  // Remove already saved legacy misclassification as well as its event payload.
  state.thread.turns[0].items.push({ id: 'subagent:sibling-thread', type: 'subagent', threadId: 'sibling-thread', items: [{ id: 'x', type: 'agentMessage', text: 'Private output' }], turns: [] });
  state.events.push({ seq: ++state.cursor, method: 'workbench/subagent/event', params: { event: { method: 'item/agentMessage/delta', params: { threadId: 'sibling-thread', turnId: 'private-turn', itemId: 'answer', delta: 'Private output' } } }, time: Date.now() });
  const restored = await context.reopen();
  assert.equal(JSON.stringify(restored.detail(restored.get(1, state.workspace.id))).includes('Private output'), false);
  assert.throws(() => restored.get(2, state.workspace.id), { code: 'not_found' });
});

test('malformed or unsupported child events cannot invent turns, and pre-turn events attach when a root turn arrives', async (t) => {
  const { store } = await fixture(t);
  const state = store.create(1, { name: 'Early event fixture', model: 'fixture', effort: 'medium', mode: 'code' });
  store.record(state, 'thread/started', { thread: { id: 'root-thread', turns: [] } });
  descendant(store, state, 'thread/started', { thread: { id: 'child-thread', preview: 'Early child', turns: [] } });
  descendant(store, state, 'item/agentMessage/delta', { threadId: 'child-thread', turnId: 'child-turn', itemId: 'answer', delta: 'Before root start' });
  assert.deepEqual(state.thread.turns, []);
  store.record(state, 'turn/started', { turn: { id: 'root-turn', status: 'inProgress', items: [] } });
  assert.equal(child(state).items[0].text, 'Before root start');
  const snapshot = structuredClone(state.thread);
  descendant(store, state, 'unknown/notification', { threadId: 'unknown-thread', turnId: 'unknown-turn' });
  descendant(store, state, 'item/agentMessage/delta', { threadId: 'missing-item-thread', turnId: 'child-turn', delta: 'No item ID' });
  descendant(store, state, 'item/agentMessage/delta', { threadId: 'missing-turn-thread', itemId: 'answer', delta: 'No turn ID' });
  descendant(store, state, 'turn/completed', { threadId: 'missing-id-thread', turn: { status: 'completed' } });
  descendant(store, state, 'turn/completed', { threadId: 'root-thread', turn: { id: 'wrong-root-turn', status: 'completed', items: [] } });
  assert.deepEqual(state.thread, snapshot);
  assert.equal(state.workspace.status, 'running');
});

test('confirmed interruption and service restart stop active child cards while preserving completed child results', async (t) => {
  const context = await fixture(t), { store } = context, state = project(store);
  descendant(store, state, 'turn/started', { threadId: 'child-thread', turn: { id: 'child-turn', status: 'inProgress', items: [] } });
  descendant(store, state, 'item/started', { threadId: 'child-thread', turnId: 'child-turn', item: { id: 'command', type: 'commandExecution', status: 'inProgress' } });
  descendant(store, state, 'item/commandExecution/outputDelta', { threadId: 'child-thread', turnId: 'child-turn', itemId: 'command', delta: 'Partial output' });
  descendant(store, state, 'turn/completed', { threadId: 'done-child', turn: { id: 'done-turn', status: 'completed', items: [{ id: 'done', type: 'agentMessage', text: 'Complete' }] } });
  const restored = await context.reopen(), entry = restored.get(1, state.workspace.id);
  assert.equal(entry.workspace.status, 'interrupted');
  assert.equal(child(entry).status, 'interrupted');
  assert.equal(child(entry).turns[0].status, 'interrupted');
  assert.equal(child(entry).items[0].status, 'interrupted');
  assert.equal(child(entry).items[0].aggregatedOutput, 'Partial output');
  assert.equal(child(entry, 'done-child').status, 'completed');
  assert.equal(child(entry, 'done-child').items[0].text, 'Complete');
});

test('acknowledgement errors do not stop child activity until the workspace is confirmed failed', async (t) => {
  const { store } = await fixture(t), state = project(store);
  descendant(store, state, 'turn/started', { threadId: 'child-thread', turn: { id: 'child-turn', status: 'inProgress', items: [] } });
  store.record(state, 'workbench/error', { code: 'runtime_timeout', message: 'Acknowledgement unknown' });
  assert.equal(child(state).status, 'inProgress');
  assert.equal(child(state).turns[0].status, 'inProgress');
  state.workspace.status = 'error';
  store.record(state, 'workbench/error', { code: 'history_limit', message: 'History limit reached' });
  assert.equal(child(state).status, 'failed');
  assert.equal(child(state).turns[0].status, 'failed');
});

test('a replacement branch never restores removed descendant output from earlier raw events', async (t) => {
  const context = await fixture(t), { store } = context, state = project(store);
  descendant(store, state, 'item/agentMessage/delta', { threadId: 'removed-child', turnId: 'removed-child-turn', itemId: 'answer', delta: 'Removed branch content' });
  store.record(state, 'turn/completed', { turn: { id: 'root-turn', status: 'completed', items: [] } });
  state.thread = { id: 'forked-thread', turns: [] };
  state.workspace.threadId = 'forked-thread';
  store.record(state, 'workbench/thread/replaced', { thread: structuredClone(state.thread) });
  store.record(state, 'turn/started', { turn: { id: 'forked-turn', status: 'inProgress', items: [] } });
  assert.equal(child(state, 'removed-child'), undefined);
  assert.deepEqual(state.thread.turns[0].items, []);
  descendant(store, state, 'item/agentMessage/delta', { threadId: 'new-child', turnId: 'new-child-turn', itemId: 'answer', delta: 'New branch content' });
  const restored = await context.reopen(), entry = restored.get(1, state.workspace.id);
  assert.equal(child(entry, 'removed-child'), undefined);
  assert.equal(child(entry, 'new-child').items[0].text, 'New branch content');
});
