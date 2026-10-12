import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../store.mjs';
import { searchCodexConversations } from '../search.mjs';

function fixture() {
  const store = new WorkspaceStore({ dataDir: '/unused-codex-search-test' });
  const project = store.create(1, { name: 'Website project', model: 'fixture', effort: 'medium', mode: 'code' });
  project.conversation.name = 'First conversation';
  return { store, project };
}

function turn(id, prompt, answer, extra = {}) {
  return { id, status: 'completed', items: [
    { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] },
    { id: `assistant-${id}`, type: 'agentMessage', text: answer },
  ], ...extra };
}

test('search finds owned project names, conversation titles, and visible user and assistant text', () => {
  const { store, project } = fixture();
  project.thread = { id: 'thread-first', turns: [turn('first-turn', 'Build the lunar dashboard', 'The solar status is ready')] };
  const otherConversation = store.createConversation(project, 'Deployment notes');
  otherConversation.thread = { id: 'thread-second', turns: [turn('second-turn', 'publish', 'done')] };
  const privateProject = store.create(2, { name: 'Website lunar solar Deployment', model: 'fixture', effort: 'medium', mode: 'code' });
  privateProject.thread = { id: 'thread-private', turns: [turn('private-turn', 'lunar', 'solar')] };

  const byProject = searchCodexConversations(store, 1, { query: 'website' });
  assert.equal(byProject.results.length, 1);
  assert.equal(byProject.results[0].matchType, 'project');
  assert.equal(byProject.results[0].workspaceId, project.workspace.id);
  assert.equal(byProject.results[0].conversationId, undefined);
  const byTitle = searchCodexConversations(store, 1, { query: 'DEPLOYMENT' });
  assert.equal(byTitle.results.length, 1);
  assert.equal(byTitle.results[0].conversationId, otherConversation.conversation.id);
  assert.equal(byTitle.results[0].matchType, 'conversation');
  const byUser = searchCodexConversations(store, 1, { query: 'lunar' });
  assert.equal(byUser.results.length, 1);
  assert.equal(byUser.results[0].role, 'user');
  assert.equal(byUser.results[0].turnId, 'first-turn');
  const byAssistant = searchCodexConversations(store, 1, { query: 'solar' });
  assert.equal(byAssistant.results.length, 1);
  assert.equal(byAssistant.results[0].role, 'assistant');
  assert.equal(byAssistant.results[0].snippet, 'The solar status is ready');
  assert.deepEqual(searchCodexConversations(store, 3, { query: 'lunar' }).results, []);
});

test('search cannot expose hidden messages, reasoning, approvals, tools, or private metadata', () => {
  const { store, project } = fixture();
  project.thread = { id: 'thread-first', turns: [
    turn('hidden-user', 'confidential lunar', 'ordinary', { deletedRoles: ['user'] }),
    turn('hidden-assistant', 'ordinary', 'confidential solar'),
    { id: 'tool-only', status: 'completed', items: [
      { id: 'reasoning', type: 'reasoning', summary: ['confidential reasoning'] },
      { id: 'command', type: 'commandExecution', command: 'confidential command', aggregatedOutput: 'confidential output' },
    ] },
  ] };
  project.messageDeletions = { 'hidden-assistant': ['assistant'] };
  project.pendingApprovals = [{ params: { secret: 'confidential approval' } }];
  project.workspace.lastError = 'confidential credential';
  assert.deepEqual(searchCodexConversations(store, 1, { query: 'confidential' }).results, []);
});

test('archive filtering includes archived matches by default and preserves both archive flags', () => {
  const { store, project } = fixture();
  const archivedConversation = store.createConversation(project, 'needle archived conversation');
  archivedConversation.conversation.archived = true;
  const archivedProject = store.create(1, { name: 'needle archived project', model: 'fixture', effort: 'medium', mode: 'code' });
  archivedProject.workspace.archived = true;
  archivedProject.conversation.name = 'needle default conversation';
  const results = searchCodexConversations(store, 1, { query: 'needle' }).results;
  assert.equal(results.length, 3);
  assert.equal(results.find((result) => result.conversationId === archivedConversation.conversation.id).conversationArchived, true);
  assert.equal(results.find((result) => result.matchType === 'project').workspaceArchived, true);
  assert.equal(results.find((result) => result.conversationId === archivedProject.conversation.id).workspaceArchived, true);
  assert.deepEqual(searchCodexConversations(store, 1, { query: 'needle', includeArchived: false }).results, []);
});

test('one conversation produces one result using its title or most recent matching visible message', () => {
  const { store, project } = fixture();
  project.thread = { id: 'thread-first', turns: [
    turn('earlier', 'needle original', 'needle answer'),
    turn('later', 'needle latest user', 'needle latest answer'),
  ] };
  const result = searchCodexConversations(store, 1, { query: 'needle' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].turnId, 'later');
  assert.equal(result.results[0].role, 'assistant');
  project.conversation.name = 'needle renamed conversation';
  const titleResult = searchCodexConversations(store, 1, { query: 'needle' });
  assert.equal(titleResult.results.length, 1);
  assert.equal(titleResult.results[0].matchType, 'conversation');
  assert.equal(titleResult.results[0].turnId, undefined);
});

test('search reaches an old saved turn even when the current event window contains only a newer turn', () => {
  const { store, project } = fixture();
  project.thread = { id: 'thread-first', turns: [
    turn('older-saved', 'deployment codename is amber-harbor', 'Acknowledged'),
    turn('recent', 'What is the current status?', 'Everything is ready'),
  ] };
  project.events = [{ seq: 101, method: 'turn/completed', params: { turn: project.thread.turns[1] } }];
  project.cursor = 101;
  const result = searchCodexConversations(store, 1, { query: 'amber-harbor' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].turnId, 'older-saved');
  assert.equal(result.results[0].snippet, 'deployment codename is amber-harbor');
});

test('results are globally ordered and limited with an honest hasMore flag', () => {
  const { store, project } = fixture();
  project.conversation.name = 'needle first';
  project.conversation.updatedAt = 20;
  const second = store.createConversation(project, 'needle second');
  second.conversation.updatedAt = 40;
  const thirdProject = store.create(1, { name: 'Other project', model: 'fixture', effort: 'medium', mode: 'code' });
  thirdProject.conversation.name = 'needle third';
  thirdProject.conversation.updatedAt = 30;
  const result = searchCodexConversations(store, 1, { query: 'needle', limit: 2 });
  assert.deepEqual(result.results.map((entry) => entry.conversationId), [second.conversation.id, thirdProject.conversation.id]);
  assert.equal(result.hasMore, true);
  assert.equal(searchCodexConversations(store, 1, { query: 'needle', limit: 3 }).hasMore, false);
});

test('snippets keep literal markup and Unicode intact while clipping around the hit and removing controls', () => {
  const { store, project } = fixture();
  const prefix = 'İ😀'.repeat(180);
  const suffix = '🧩'.repeat(260);
  project.thread = { id: 'thread-first', turns: [turn('unicode', `${prefix} 中文\n  查找\u202e <b>literal</b> ${suffix}`, 'ordinary')] };
  const result = searchCodexConversations(store, 1, { query: ' 中文\t查找 ' });
  assert.equal(result.query, '中文 查找');
  assert.equal(result.results.length, 1);
  const snippet = result.results[0].snippet;
  assert.ok(snippet.includes('中文 查找 <b>literal</b>'));
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(Array.from(snippet).length <= 240);
  assert.equal(snippet.isWellFormed(), true);
  assert.equal(/[\u0000-\u001f\u202e]/.test(snippet), false);
  assert.equal(searchCodexConversations(store, 1, { query: '<b>literal</b>' }).results.length, 1);
});

test('invalid query, owner, limits and archive flags are rejected without treating the query as a regex', () => {
  const { store, project } = fixture();
  for (const query of ['', ' \n\t ', 'x'.repeat(201), null, ['text']]) {
    assert.throws(() => searchCodexConversations(store, 1, { query }), { statusCode: 400, code: 'invalid_search_query' });
  }
  for (const limit of [0, -1, 1.5, 101, '10']) {
    assert.throws(() => searchCodexConversations(store, 1, { query: 'text', limit }), { code: 'invalid_search_limit' });
  }
  assert.throws(() => searchCodexConversations(store, 0, { query: 'text' }), { code: 'invalid_owner' });
  assert.throws(() => searchCodexConversations(store, 1, { query: 'text', includeArchived: 'false' }), { code: 'invalid_search_archive_filter' });
  project.thread = { id: 'thread-first', turns: [turn('literal', 'Use [a-z]+ as text', 'ordinary')] };
  assert.equal(searchCodexConversations(store, 1, { query: '[a-z]+' }).results[0].snippet, 'Use [a-z]+ as text');
  assert.deepEqual(searchCodexConversations(store, 1, { query: '^Use' }).results, []);
});

test('search returns detached metadata and never changes stored thread content', () => {
  const { store, project } = fixture();
  project.thread = { id: 'thread-first', turns: [turn('first-turn', 'needle user', 'needle answer')] };
  const before = JSON.stringify(project);
  const result = searchCodexConversations(store, 1, { query: 'needle' });
  result.results[0].snippet = 'changed by caller';
  result.results[0].workspaceName = 'changed by caller';
  assert.equal(JSON.stringify(project), before);
});
