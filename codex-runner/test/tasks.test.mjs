import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore } from '../store.mjs';
import { listTasks } from '../tasks.mjs';

function fixture() {
  const store = new WorkspaceStore({ dataDir: '/unused-codex-task-list-test' });
  const project = store.create(1, { name: 'Website project', model: 'fixture', effort: 'medium', mode: 'code' });
  project.conversation.name = 'First conversation';
  return { store, project };
}

test('task listing includes every owned conversation and preserves empty, active, failed and completed states', () => {
  const { store, project } = fixture();
  const completed = store.createConversation(project, 'Completed task');
  completed.thread = { id: 'done-thread', turns: [{ id: 'done-turn', status: 'completed', items: [] }] };
  const active = store.createConversation(project, 'Awaiting input');
  active.workspace.status = 'waiting_approval';
  active.thread = { id: 'active-thread', turns: [{ id: 'active-turn', status: 'inProgress', items: [] }] };
  active.pendingApprovals = [{ id: 'pending-question', params: { questions: ['private'] } }];
  active.queuedTurns = [{ requestId: 'queued', prompt: 'private queued instruction', status: 'queued' }];
  const failed = store.createConversation(project, 'Failed task');
  failed.workspace.status = 'error';
  failed.thread = { id: 'failed-thread', turns: [{ id: 'failed-turn', status: 'failed', items: [] }] };
  const stranger = store.create(2, { name: 'Private project', model: 'private-model', effort: 'high', mode: 'code' });
  store.createConversation(stranger, 'Private sub-conversation');
  const result = listTasks(store, 1);
  assert.equal(result.total, 4);
  assert.equal(result.tasks.length, 4);
  const emptyTask = result.tasks.find((entry) => entry.conversationId === project.conversation.id);
  assert.equal(emptyTask.status, 'idle');
  assert.equal(emptyTask.latestTurnStatus, null);
  assert.equal(emptyTask.turnCount, 0);
  assert.equal(result.tasks.find((entry) => entry.conversationId === completed.conversation.id).latestTurnStatus, 'completed');
  assert.equal(result.tasks.find((entry) => entry.conversationId === failed.conversation.id).latestTurnStatus, 'failed');
  const waitingTask = result.tasks.find((entry) => entry.conversationId === active.conversation.id);
  assert.equal(waitingTask.status, 'waiting_approval');
  assert.equal(waitingTask.latestTurnStatus, 'inProgress');
  assert.equal(waitingTask.queuedCount, 1);
  assert.equal(waitingTask.approvalCount, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(listTasks(store, 3), { tasks: [], total: 0, hasMore: false, nextOffset: null });
});

test('archive tabs use the union of project and conversation archive state without hiding child conversations', () => {
  const { store, project } = fixture();
  const archived = store.createConversation(project, 'Archived conversation');
  archived.conversation.archived = true;
  const archivedProject = store.create(1, { name: 'Archived project', model: 'fixture', effort: 'medium', mode: 'code' });
  archivedProject.workspace.archived = true;
  const nested = store.createConversation(archivedProject, 'Unarchived child in archived project');
  const all = listTasks(store, 1);
  assert.equal(all.total, 4);
  assert.equal(listTasks(store, 1, { archived: false }).total, 1);
  const archivedTasks = listTasks(store, 1, { archived: true });
  assert.equal(archivedTasks.total, 3);
  const nestedTask = archivedTasks.tasks.find((entry) => entry.conversationId === nested.conversation.id);
  assert.equal(nestedTask.archived, true);
  assert.equal(nestedTask.workspaceArchived, true);
  assert.equal(nestedTask.conversationArchived, false);
});

test('tasks order by each conversation activity rather than the shared project timestamp and paginate honestly', () => {
  const { store, project } = fixture();
  project.conversation.updatedAt = 10;
  const newest = store.createConversation(project, 'Newest conversation');
  newest.conversation.updatedAt = 30;
  const middle = store.createConversation(project, 'Middle conversation');
  middle.conversation.updatedAt = 20;
  project.workspace.updatedAt = 1000;
  const first = listTasks(store, 1, { limit: 2 });
  assert.deepEqual(first.tasks.map((entry) => entry.conversationId), [newest.conversation.id, middle.conversation.id]);
  assert.equal(first.total, 3);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  const second = listTasks(store, 1, { offset: first.nextOffset, limit: 2 });
  assert.deepEqual(second.tasks.map((entry) => entry.conversationId), [project.conversation.id]);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(listTasks(store, 1, { offset: 100 }).tasks, []);
});

test('title queries are literal and normalized and never search message or approval contents', () => {
  const { store, project } = fixture();
  project.conversation.name = '中文\n\u202e  验收 [a-z]+';
  project.thread = { id: 'root-thread', turns: [{ id: 'root-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'hidden-content-needle' }] }] };
  assert.equal(listTasks(store, 1, { query: '中文 验收' }).tasks[0].title, '中文 验收 [a-z]+');
  assert.equal(listTasks(store, 1, { query: '[a-z]+' }).total, 1);
  assert.equal(listTasks(store, 1, { query: 'WEBSITE' }).total, 1);
  assert.equal(listTasks(store, 1, { query: 'hidden-content-needle' }).total, 0);
});

test('source, mode, model and available repository metadata are real detached values without repository secrets', () => {
  const { store, project } = fixture();
  project.workspace.remote = { connectionId: 'fixture-connection', host: 'example.test', username: 'private-username', path: '/private/path' };
  project.workspace.repositoryUrl = 'https://token:private-secret@example.test/owner/repository.git?token=private-token#secret';
  project.workspace.mode = 'ask';
  const before = JSON.stringify(project);
  const task = listTasks(store, 1).tasks[0];
  assert.equal(task.source, 'ssh');
  assert.equal(task.mode, 'ask');
  assert.equal(task.model, 'fixture');
  assert.equal(task.repository, 'https://example.test/owner/repository.git');
  assert.equal(JSON.stringify(task).includes('private'), false);
  task.title = 'Mutated by caller';
  task.repository = 'https://example.test/different';
  assert.equal(JSON.stringify(project), before);
  delete project.workspace.repositoryUrl;
  project.thread = { id: 'native-thread', gitInfo: { repositoryUrl: 'https://example.test/native/repository' }, turns: [] };
  assert.equal(listTasks(store, 1).tasks[0].repository, 'https://example.test/native/repository');
  delete project.thread.gitInfo;
  assert.equal(listTasks(store, 1).tasks[0].repository, undefined);
});

test('task listing rejects invalid trusted identity and filters instead of coercing them', () => {
  const { store } = fixture();
  for (const owner of [0, -1, 1.1, '1', 10000000000]) assert.throws(() => listTasks(store, owner), { code: 'invalid_owner' });
  for (const options of [null, [], 'query']) assert.throws(() => listTasks(store, 1, options), { code: 'invalid_task_filter' });
  for (const query of [null, [], 'a'.repeat(201)]) assert.throws(() => listTasks(store, 1, { query }), { code: 'invalid_task_query' });
  for (const limit of [0, 1.2, 1001, '20']) assert.throws(() => listTasks(store, 1, { limit }), { code: 'invalid_task_limit' });
  for (const offset of [-1, 1.2, 100001, '20']) assert.throws(() => listTasks(store, 1, { offset }), { code: 'invalid_task_offset' });
  assert.throws(() => listTasks(store, 1, { archived: 'false' }), { code: 'invalid_task_archive_filter' });
});
