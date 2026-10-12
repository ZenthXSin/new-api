import { apiError } from './store.mjs';

function taskText(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function repositoryLocation(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  let url;
  try { url = new URL(value); } catch { return undefined; }
  // Repository metadata can originate from a Git remote. Return only the
  // location, never credentials or access-token query strings embedded in it.
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.pathname === '/') return undefined;
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}

/**
 * List every owned conversation, including empty conversations and revisions.
 * The caller must obtain ownerId from its authenticated session. Only public
 * metadata is projected; message bodies, approvals and queued prompts stay out.
 */
export function listTasks(store, ownerId, options = {}) {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || ownerId > 9999999999) throw apiError(400, 'invalid_owner', 'Invalid task owner');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw apiError(400, 'invalid_task_filter', 'Invalid task filters');
  if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 400)) throw apiError(400, 'invalid_task_query', 'Enter a task title query of up to 200 characters');
  const query = taskText(options.query || '');
  if (Array.from(query).length > 200) throw apiError(400, 'invalid_task_query', 'Enter a task title query of up to 200 characters');
  const { archived } = options, limit = options.limit ?? 100, offset = options.offset ?? 0;
  if (archived !== undefined && typeof archived !== 'boolean') throw apiError(400, 'invalid_task_archive_filter', 'Choose whether to show archived tasks');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw apiError(400, 'invalid_task_limit', 'Task limit must be between 1 and 1000');
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw apiError(400, 'invalid_task_offset', 'Task offset must be between 0 and 100000');
  const tasks = [], seen = new Set(), needle = query.toLowerCase();
  for (const workspace of store.list(ownerId)) {
    // Resolve the listing through the same ownership guard as a detail request.
    // Never walk the global state map or native history belonging to other users.
    const root = store.get(ownerId, workspace.id);
    const workspaceName = taskText(root.workspace.name), workspaceArchived = root.workspace.archived === true;
    for (const conversation of store.conversations(root)) {
      const id = `conversation:${workspace.id}:${conversation.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = store.get(ownerId, workspace.id, conversation.id);
      const title = taskText(state.conversation.name), conversationArchived = state.conversation.archived === true;
      const isArchived = workspaceArchived || conversationArchived;
      if (archived !== undefined && archived !== isArchived) continue;
      if (needle && !title.toLowerCase().includes(needle) && !workspaceName.toLowerCase().includes(needle)) continue;
      const turns = Array.isArray(state.thread?.turns) ? state.thread.turns : [];
      const latestTurnStatus = typeof turns.at(-1)?.status === 'string' ? turns.at(-1).status : null;
      const repository = repositoryLocation(root.workspace.repositoryUrl || state.thread?.gitInfo?.repositoryUrl || root.thread?.gitInfo?.repositoryUrl);
      tasks.push({
        id, workspaceId: workspace.id, conversationId: conversation.id, title, workspaceName,
        createdAt: Number(state.conversation.createdAt) || 0,
        updatedAt: Number(state.conversation.updatedAt) || 0,
        status: state.workspace.status,
        latestTurnStatus, turnCount: turns.length,
        mode: state.workspace.mode, model: state.workspace.model,
        queuedCount: Array.isArray(state.queuedTurns) ? state.queuedTurns.length : 0,
        approvalCount: Array.isArray(state.pendingApprovals) ? state.pendingApprovals.length : 0,
        archived: isArchived, workspaceArchived, conversationArchived,
        source: root.workspace.remote ? 'ssh' : 'local',
        ...(repository ? { repository } : {}),
      });
    }
  }
  tasks.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const total = tasks.length, page = tasks.slice(offset, offset + limit), next = offset + page.length;
  return { tasks: page, total, hasMore: next < total, nextOffset: next < total ? next : null };
}
