import { randomUUID } from 'node:crypto';
import { apiError } from './store.mjs';

// Capture only conversation data. Project collections and execution queues must
// not be copied: every branch shares files, but queued work executes once.
export function prepareConversationReplay(store, state, turnId, historyLimit) {
  const turnIndex = state.thread?.turns?.findIndex((turn) => turn.id === turnId) ?? -1;
  if (turnIndex < 0) throw apiError(404, 'message_not_found', 'Message not found');
  const entries = store.projectStates(store.root(state));
  if (entries.length >= 100) throw apiError(409, 'conversation_limit', 'This project has reached its conversation limit');
  const prefix = structuredClone(state.thread.turns.slice(0, turnIndex));
  const prefixBytes = Buffer.byteLength(JSON.stringify({ ...state.thread, turns: prefix }));
  const sourceBytes = Buffer.byteLength(JSON.stringify(state.thread));
  const historyBytes = entries.reduce((sum, entry) => sum + (entry.historyBytes || 0), 0);
  if (historyBytes + Math.max(0, sourceBytes - (state.historyBytes || 0)) + prefixBytes >= historyLimit) {
    throw apiError(409, 'history_limit', 'Workspace history limit reached; export your project and create another workspace');
  }
  const source = structuredClone({
    workspace: state.workspace, conversation: state.conversation, thread: state.thread,
    requests: state.requests, messageDeletions: state.messageDeletions || {}, historyBytes: state.historyBytes || 0,
    events: state.events, cursor: state.cursor, eventBytes: state.eventBytes,
  });
  const originalBranch = source.conversation.branch || {
    rootConversationId: state.conversation.id, revisionId: randomUUID(), version: 1,
  };
  const lastVersion = Math.max(originalBranch.version, ...entries
    .filter((entry) => entry.conversation.branch?.rootConversationId === originalBranch.rootConversationId)
    .map((entry) => entry.conversation.branch.version));
  return {
    source, prefix, prefixBytes, originalBranch,
    branch: {
      rootConversationId: originalBranch.rootConversationId, revisionId: randomUUID(),
      parentRevisionId: originalBranch.revisionId, replayTurnId: turnId, turnIndex, version: lastVersion + 1,
    },
  };
}

// This transaction runs after a non-destructive native thread/fork and before
// turn/start. If persistence fails, the original conversation stays selected and
// no model generation is sent. The unstarted native fork can safely be orphaned.
export async function persistConversationReplay(store, state, prepared, forkThread) {
  if (!forkThread?.id || forkThread.id === prepared.source.workspace.threadId) {
    throw apiError(502, 'invalid_fork', 'Codex could not create a separate conversation branch');
  }
  const project = store.root(state);
  const previous = {
    thread: state.thread, threadId: state.workspace.threadId, tokenUsage: state.workspace.tokenUsage,
    branch: state.conversation.branch, historyBytes: state.historyBytes,
    events: state.events, eventBytes: state.eventBytes, cursor: state.cursor,
    messageDeletions: state.messageDeletions, projectUpdatedAt: project.workspace.updatedAt,
    workspaceUpdatedAt: state.workspace.updatedAt, conversationUpdatedAt: state.conversation.updatedAt,
  };
  const name = `${prepared.source.conversation.name.slice(0, 106)} (v${prepared.originalBranch.version})`;
  const original = store.createConversation(state, name);
  const identity = original.conversation;
  Object.assign(original, structuredClone(prepared.source));
  original.conversation = {
    ...original.conversation, id: identity.id, name, branch: prepared.originalBranch,
  };
  original.historyBytes = Math.max(original.historyBytes, Buffer.byteLength(JSON.stringify(original.thread)));
  state.thread = { ...forkThread, turns: prepared.prefix };
  state.workspace.threadId = forkThread.id;
  state.workspace.tokenUsage = null;
  state.conversation.branch = prepared.branch;
  state.messageDeletions = Object.fromEntries(prepared.prefix
    .filter((turn) => prepared.source.messageDeletions[turn.id])
    .map((turn) => [turn.id, structuredClone(prepared.source.messageDeletions[turn.id])]));
  state.historyBytes = Buffer.byteLength(JSON.stringify(state.thread));
  // The native prefix already contains its complete child projections. Keeping
  // old deltas would let legacy event recovery restore descendants from turns
  // intentionally excluded by this edit. Commit the replacement event with the
  // fork itself: a crash before turn/start must still update an open client's
  // cached thread. Keep a detached snapshot and emit only after durable commit.
  const updatedAt = Date.now();
  const replacement = {
    seq: ++state.cursor, method: 'workbench/thread/replaced',
    params: { thread: structuredClone(state.thread) }, time: updatedAt,
  };
  state.events = [replacement];
  state.eventBytes = Buffer.byteLength(JSON.stringify(replacement));
  state.workspace.updatedAt = updatedAt;
  state.conversation.updatedAt = updatedAt;
  project.workspace.updatedAt = updatedAt;
  try {
    await store.persist(state);
  } catch (error) {
    delete project.conversations[identity.id];
    state.thread = previous.thread;
    state.workspace.threadId = previous.threadId;
    state.workspace.tokenUsage = previous.tokenUsage;
    if (previous.branch) state.conversation.branch = previous.branch;
    else delete state.conversation.branch;
    state.historyBytes = previous.historyBytes;
    state.events = previous.events;
    state.eventBytes = previous.eventBytes;
    state.cursor = previous.cursor;
    state.workspace.updatedAt = previous.workspaceUpdatedAt;
    state.conversation.updatedAt = previous.conversationUpdatedAt;
    if (previous.messageDeletions) state.messageDeletions = previous.messageDeletions;
    else delete state.messageDeletions;
    project.workspace.updatedAt = previous.projectUpdatedAt;
    throw error;
  }
  store.emit(state.workspace.id, replacement);
  return original;
}
