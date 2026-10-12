import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../store.mjs';
import { prepareConversationReplay, persistConversationReplay } from '../branching.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-branches-test-'));
  const store = new WorkspaceStore({ dataDir });
  await store.initialize();
  const state = store.create(1, { name: 'Project', model: 'fixture-model', effort: 'high', mode: 'code' });
  state.workspace.threadId = 'native-original';
  state.thread = { id: 'native-original', turns: ['previous', 'selected', 'later'].map((id) => ({
    id, status: 'completed', items: [
      { id: `${id}-user`, type: 'userMessage', content: [{ type: 'text', text: `${id} user message` }] },
      { id: `${id}-agent`, type: 'agentMessage', text: `${id} reply` },
    ],
  })) };
  state.messageDeletions = { previous: ['assistant'], later: ['user'] };
  state.thread.turns[0].deletedRoles = ['assistant'];
  state.thread.turns[2].deletedRoles = ['user'];
  state.thread.turns[0].items.push({ id: 'child', type: 'subagent', children: [{ text: 'nested result' }] });
  state.historyBytes = Buffer.byteLength(JSON.stringify(state.thread));
  state.requests.old = { status: 'accepted', turnId: 'previous', fingerprint: 'previous-fingerprint' };
  state.queuedTurns = [{ requestId: 'pending-queue', prompt: 'execute once' }];
  await store.persist(state);
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { store, state, dataDir };
}

test('editing preserves original replies and subagent data as an independently addressable durable branch', async (t) => {
  const { store, state, dataDir } = await fixture(t);
  const originalThread = structuredClone(state.thread);
  const prepared = prepareConversationReplay(store, state, 'selected', 1024 * 1024);
  state.requests.edit = { status: 'pending', fingerprint: 'edit-fingerprint' };
  const original = await persistConversationReplay(store, state, prepared, { id: 'native-fork', forkedFromId: 'native-original', turns: [] });
  assert.deepEqual(original.thread, originalThread);
  assert.equal(original.workspace.threadId, 'native-original');
  assert.equal(store.detail(original).conversationId, original.conversation.id);
  assert.deepEqual(state.thread.turns.map((turn) => turn.id), ['previous']);
  assert.deepEqual(state.messageDeletions, { previous: ['assistant'] });
  assert.equal(original.requests.edit, undefined);
  assert.equal(original.queuedTurns, undefined);
  assert.equal(state.queuedTurns.length, 1);
  state.thread.turns[0].items.at(-1).children[0].text = 'updated independently';
  assert.equal(original.thread.turns[0].items.at(-1).children[0].text, 'nested result');
  const reopened = new WorkspaceStore({ dataDir });
  await reopened.initialize();
  assert.deepEqual(reopened.get(1, state.workspace.id, original.conversation.id).thread, originalThread);
  assert.throws(() => reopened.get(2, state.workspace.id, original.conversation.id), { code: 'not_found' });
  await reopened.close();
});

test('editing the first message creates an empty native prefix and retains the full original branch', async (t) => {
  const { store, state } = await fixture(t);
  const prepared = prepareConversationReplay(store, state, 'previous', 1024 * 1024);
  const original = await persistConversationReplay(store, state, prepared, { id: 'first-message-fork', turns: [] });
  assert.deepEqual(state.thread.turns, []);
  assert.deepEqual(state.messageDeletions, {});
  assert.equal(original.thread.turns.length, 3);
});

test('nested edits and edits from an old branch retain stable revision ancestry and increment family versions', async (t) => {
  const { store, state } = await fixture(t);
  const original = await persistConversationReplay(store, state, prepareConversationReplay(store, state, 'selected', 1024 * 1024), { id: 'fork-2' });
  state.thread.turns.push({ id: 'edited', status: 'completed', items: [] });
  const versionTwo = await persistConversationReplay(store, state, prepareConversationReplay(store, state, 'edited', 1024 * 1024), { id: 'fork-3' });
  const originalRevision = original.conversation.branch.revisionId;
  assert.equal(versionTwo.conversation.branch.version, 2);
  assert.equal(state.conversation.branch.version, 3);
  assert.equal(state.conversation.branch.parentRevisionId, versionTwo.conversation.branch.revisionId);
  assert.equal(versionTwo.conversation.branch.parentRevisionId, originalRevision);
  await persistConversationReplay(store, original, prepareConversationReplay(store, original, 'later', 1024 * 1024), { id: 'fork-4' });
  assert.equal(original.conversation.branch.version, 4);
  assert.equal(original.conversation.branch.parentRevisionId, originalRevision);
  assert.equal(new Set(store.projectStates(state).map((entry) => entry.conversation.branch.revisionId)).size, 4);
});

test('missing turns and capacity limits fail before creating or replacing a branch', async (t) => {
  const { store, state } = await fixture(t);
  assert.throws(() => prepareConversationReplay(store, state, 'missing', 1024 * 1024), { code: 'message_not_found' });
  assert.throws(() => prepareConversationReplay(store, state, 'selected', state.historyBytes + 1), { code: 'history_limit' });
  for (let count = 1; count < 100; count++) store.createConversation(state, `Conversation ${count}`);
  assert.throws(() => prepareConversationReplay(store, state, 'selected', 1024 * 1024), { code: 'conversation_limit' });
  assert.equal(state.thread.id, 'native-original');
  assert.equal(state.thread.turns.length, 3);
  assert.equal(state.conversation.branch, undefined);
});

test('saving a branch failure restores the selected original without erasing its history or exposing an empty backup', async (t) => {
  const { store, state, dataDir } = await fixture(t);
  const snapshot = structuredClone(state.thread);
  const previousEvents = structuredClone(state.events);
  const previousCursor = state.cursor;
  const emitted = [];
  store.on(state.workspace.id, (event) => emitted.push(event));
  const prepared = prepareConversationReplay(store, state, 'selected', 1024 * 1024);
  const directory = store.directory;
  const invalidDirectory = join(dataDir, 'blocked-state-directory');
  await writeFile(invalidDirectory, 'not a directory');
  store.directory = invalidDirectory;
  try {
    await assert.rejects(persistConversationReplay(store, state, prepared, { id: 'unstarted-orphan-fork' }), { code: 'persistence_failed' });
  } finally { store.directory = directory; }
  assert.deepEqual(state.thread, snapshot);
  assert.equal(state.workspace.threadId, 'native-original');
  assert.equal(store.projectStates(state).length, 1);
  assert.equal(state.conversation.branch, undefined);
  assert.deepEqual(state.events, previousEvents);
  assert.equal(state.cursor, previousCursor);
  assert.deepEqual(emitted, []);
  const reopened = new WorkspaceStore({ dataDir });
  await reopened.initialize();
  assert.deepEqual(reopened.get(1, state.workspace.id).thread, snapshot);
  await reopened.close();
});

test('an invalid native fork response cannot alias or replace the original thread', async (t) => {
  const { store, state } = await fixture(t);
  const prepared = prepareConversationReplay(store, state, 'selected', 1024 * 1024);
  for (const thread of [null, {}, { id: 'native-original' }]) {
    await assert.rejects(persistConversationReplay(store, state, prepared, thread), { code: 'invalid_fork' });
  }
  assert.equal(state.workspace.threadId, 'native-original');
  assert.equal(store.projectStates(state).length, 1);
});

test('child events after the edit point remain only in the original branch after a new turn and reload', async (t) => {
  const { store, state, dataDir } = await fixture(t);
  store.record(state, 'turn/started', { threadId: 'native-original', turn: { id: 'later', status: 'inProgress', items: [] } });
  store.record(state, 'workbench/subagent/event', { event: { method: 'thread/started', params: { thread: { id: 'later-child', turns: [] } } } });
  store.record(state, 'workbench/subagent/event', { event: { method: 'turn/started', params: { threadId: 'later-child', turn: { id: 'child-turn', status: 'inProgress', items: [] } } } });
  store.record(state, 'workbench/subagent/event', { event: { method: 'item/agentMessage/delta', params: { threadId: 'later-child', turnId: 'child-turn', itemId: 'child-output', delta: 'output belonging only to later turn' } } });
  store.record(state, 'turn/completed', { threadId: 'native-original', turn: { id: 'later', status: 'completed', items: [] } });
  const cursor = state.cursor;
  const original = await persistConversationReplay(store, state, prepareConversationReplay(store, state, 'selected', 1024 * 1024), { id: 'native-fork' });
  assert(original.events.some((event) => event.method === 'workbench/subagent/event'));
  assert.equal(state.cursor, cursor + 1);
  assert.deepEqual(state.events.map((event) => event.method), ['workbench/thread/replaced']);
  store.record(state, 'turn/started', { threadId: 'native-fork', turn: { id: 'edited-turn', status: 'inProgress', items: [] } });
  assert.equal(state.thread.turns.flatMap((turn) => turn.items).some((item) => item.threadId === 'later-child'), false);
  assert.equal(state.cursor, cursor + 2);
  await store.persist(state);
  const reopened = new WorkspaceStore({ dataDir });
  await reopened.initialize();
  assert.equal(reopened.get(1, state.workspace.id).thread.turns.flatMap((turn) => turn.items).some((item) => item.threadId === 'later-child'), false);
  assert.equal(reopened.get(1, state.workspace.id, original.conversation.id).thread.turns.flatMap((turn) => turn.items).some((item) => item.threadId === 'later-child'), true);
  await reopened.close();
});

test('a restart immediately after the first fork commit tells a previously open client to replace its cached thread', async (t) => {
  const { store, state, dataDir } = await fixture(t);
  const prepared = prepareConversationReplay(store, state, 'selected', 1024 * 1024);
  state.workspace.status = 'starting';
  store.record(state, 'workbench/task/starting', { requestId: 'pending-edit' });
  await store.persist(state);
  const cachedCursor = state.cursor;
  await persistConversationReplay(store, state, prepared, { id: 'native-fork' });
  // Reopen at the first durable fork boundary, before turn/start or any caller
  // follow-up persist. The browser already consumed the starting notification.
  const reopened = new WorkspaceStore({ dataDir });
  await reopened.initialize();
  const recovered = reopened.get(1, state.workspace.id);
  const page = reopened.eventsAfter(recovered, cachedCursor);
  const replacement = page.events.find((event) => event.method === 'workbench/thread/replaced');
  assert.equal(page.reset, false);
  assert.equal(replacement?.params.thread.id, 'native-fork');
  assert.deepEqual(replacement.params.thread.turns.map((turn) => turn.id), ['previous']);
  assert.equal(page.workspace.status, 'interrupted');
  assert.equal(replacement.seq, cachedCursor + 1);
  await reopened.close();
});
