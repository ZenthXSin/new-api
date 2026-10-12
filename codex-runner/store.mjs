import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ACTIVE_STATUSES = new Set(['starting', 'running', 'waiting_approval']);

export function apiError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function getTurn(state, turnId) {
  if (!state.thread) state.thread = { id: state.workspace.threadId, turns: [] };
  state.thread.turns ||= [];
  let turn = state.thread.turns.find((value) => value.id === turnId);
  if (!turn) {
    turn = { id: turnId, status: 'inProgress', items: [], error: null };
    state.thread.turns.push(turn);
  }
  if (state.messageDeletions?.[turn.id]) turn.deletedRoles = state.messageDeletions[turn.id];
  return turn;
}

function getItem(state, params, type) {
  const turn = getTurn(state, params.turnId || state.workspace.activeTurnId);
  let item = turn.items.find((value) => value.id === params.itemId);
  if (!item) { item = { id: params.itemId, type }; turn.items.push(item); }
  return item;
}

function subagentThreadId(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const id = event.params?.threadId || (event.method === 'thread/started' ? event.params?.thread?.id : null);
  return typeof id === 'string' && id ? id : null;
}

// A descendant is presented inside the turn that first observed it. Reducing
// its events against a private workspace prevents child lifecycle notifications
// from completing the root turn or replacing the conversation's native thread.
function reduceSubagentNotification(state, event, parentTurnId = state.workspace.activeTurnId) {
  const threadId = subagentThreadId(event);
  if (!threadId || threadId === state.workspace.threadId || threadId === state.thread?.id) return;
  const params = event.params || {}, method = event.method;
  const isTurn = method === 'turn/started' || method === 'turn/completed';
  const isItem = method === 'item/started' || method === 'item/completed';
  const isDelta = ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta'].includes(method);
  const isPlan = method === 'turn/plan/updated', isDiff = method === 'turn/diff/updated';
  if (method !== 'thread/started' && !isTurn && !isItem && !isDelta && !isPlan && !isDiff) return;
  const id = `subagent:${threadId}`, turns = state.thread?.turns || [];
  const parent = turns.find((turn) => turn.items?.some((item) => item.type === 'subagent' && item.id === id))
    || turns.find((turn) => turn.id === parentTurnId) || turns.at(-1);
  if (!parent) return;
  const existing = parent.items.find((item) => item.type === 'subagent' && item.id === id);
  const subagent = existing || { id, type: 'subagent', threadId, status: 'inProgress', items: [], turns: [] };
  const childTurns = Array.isArray(subagent.turns) ? subagent.turns : [];
  const activeTurn = childTurns.findLast((turn) => turn.status === 'inProgress');
  const childState = {
    workspace: { threadId, activeTurnId: activeTurn?.id || null, status: activeTurn ? 'running' : 'idle' },
    thread: { id: threadId, turns: childTurns }, pendingApprovals: [],
  };
  if (method === 'thread/started') {
    if (!params.thread || params.thread.id !== threadId) return;
    if (typeof params.thread.preview === 'string') subagent.text = params.thread.preview;
    if (typeof params.thread.name === 'string') subagent.agentName = params.thread.name;
    // A late/summary thread snapshot must not discard previously streamed items.
    for (const turn of Array.isArray(params.thread.turns) ? params.thread.turns : []) {
      if (!turn || typeof turn.id !== 'string' || !turn.id) continue;
      reduceNotification(childState, turn.status === 'inProgress' ? 'turn/started' : 'turn/completed', {
        threadId, turn: { ...turn, items: Array.isArray(turn.items) ? turn.items : [] },
      });
    }
  } else {
    const turnId = isTurn ? params.turn?.id : params.turnId || activeTurn?.id || childTurns.at(-1)?.id;
    if (typeof turnId !== 'string' || !turnId) return;
    if (isTurn) {
      const turn = { ...params.turn, status: params.turn.status || (method === 'turn/started' ? 'inProgress' : 'completed'), items: Array.isArray(params.turn.items) ? params.turn.items : [] };
      reduceNotification(childState, method, { ...params, turn });
      subagent.status = turn.status;
    } else {
      if (isItem && (typeof params.item?.id !== 'string' || !params.item.id || typeof params.item.type !== 'string')) return;
      if (isDelta && (typeof params.itemId !== 'string' || !params.itemId || typeof params.delta !== 'string')) return;
      if ((isPlan && !Array.isArray(params.plan)) || (isDiff && typeof params.diff !== 'string')) return;
      reduceNotification(childState, method, { ...params, turnId });
    }
  }
  subagent.turns = childState.thread.turns;
  subagent.items = subagent.turns.flatMap((turn) => turn.items);
  if (subagent.turns.at(-1)?.status) subagent.status = subagent.turns.at(-1).status;
  if (!existing) parent.items.push(subagent);
  return true;
}

function restoreSubagentHistory(state) {
  // Older snapshots only retained descendant events in the bounded event ring.
  // Replay a missing child in full, never replay deltas into an existing child.
  const restored = new Set((state.thread?.turns || []).flatMap((turn) =>
    (turn.items || []).filter((item) => item.type === 'subagent').map((item) => item.threadId)));
  let parentTurnId = null, changed = false;
  // A fork/replay snapshot is the complete new branch. Older descendants can
  // belong to its removed suffix and must never be resurrected from raw events.
  const events = state.events || [];
  const replacement = events.findLastIndex((event) => event.method === 'workbench/thread/replaced');
  for (const event of events.slice(replacement + 1)) {
    if (event.method === 'turn/started') parentTurnId = event.params?.turn?.id || parentTurnId;
    if (event.method === 'workbench/subagent/event' && !restored.has(subagentThreadId(event.params?.event))) {
      changed = reduceSubagentNotification(state, event.params?.event, parentTurnId) || changed;
    }
  }
  return changed;
}

function settleSubagents(thread, status) {
  let changed = false;
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item.type !== 'subagent') continue;
      if (['inProgress', 'starting', 'running'].includes(item.status)) {
        item.status = status;
        changed = true;
      }
      for (const childTurn of item.turns || []) {
        if (childTurn.status === 'inProgress') { childTurn.status = status; changed = true; }
        for (const childItem of childTurn.items || []) {
          if (childItem.status === 'inProgress') { childItem.status = status; changed = true; }
        }
      }
      item.items = (item.turns || []).flatMap((childTurn) => childTurn.items || []);
    }
  }
  return changed;
}

// Store the same public thread shape as App Server, including partial output.
export function reduceNotification(state, method, params) {
  const workspace = state.workspace;
  if (method === 'workbench/subagent/event') {
    reduceSubagentNotification(state, params.event);
  } else if (method === 'workbench/interrupted') {
    settleSubagents(state.thread, 'interrupted');
  } else if (method === 'workbench/error' && workspace.status === 'error') {
    // A timed-out acknowledgement can leave a live turn running. Only a
    // confirmed terminal workspace state may settle its descendant activity.
    settleSubagents(state.thread, 'failed');
  } else if (method === 'thread/started' && params.thread) {
    const turns = state.thread?.id === params.thread.id ? state.thread.turns : [];
    for (const incoming of params.thread.turns || []) {
      const saved = turns.find((turn) => turn.id === incoming.id);
      if (!saved) { turns.push(incoming); continue; }
      const items = [...saved.items];
      for (const item of incoming.items || []) {
        const index = items.findIndex((entry) => entry.id === item.id);
        if (index < 0) items.push(item);
        else items[index] = { ...items[index], ...item };
      }
      Object.assign(saved, incoming, { items });
    }
    workspace.threadId = params.thread.id;
    state.thread = { ...params.thread, turns };
    for (const turn of state.thread.turns) if (state.messageDeletions?.[turn.id]) turn.deletedRoles = state.messageDeletions[turn.id];
  } else if (method === 'turn/started' && params.turn) {
    const turn = getTurn(state, params.turn.id);
    const mergedItems = [...turn.items];
    for (const incoming of params.turn.items || []) {
      const index = mergedItems.findIndex((item) => item.id === incoming.id);
      if (index < 0) mergedItems.push(incoming);
      else mergedItems[index] = { ...mergedItems[index], ...incoming };
    }
    Object.assign(turn, params.turn, { items: mergedItems });
    workspace.activeTurnId = turn.id;
    workspace.status = 'running';
    workspace.lastError = null;
  } else if (method === 'turn/completed' && params.turn) {
    const turn = getTurn(state, params.turn.id);
    const mergedItems = [...turn.items];
    for (const incoming of params.turn.items || []) {
      const index = mergedItems.findIndex((item) => item.id === incoming.id);
      if (index < 0) mergedItems.push(incoming);
      else mergedItems[index] = { ...mergedItems[index], ...incoming };
    }
    Object.assign(turn, params.turn, { items: mergedItems });
    workspace.activeTurnId = null;
    workspace.status = turn.status === 'failed' ? 'error' : turn.status === 'interrupted' ? 'interrupted' : 'idle';
    workspace.lastError = turn.error?.message || null;
    state.pendingApprovals = [];
  } else if ((method === 'item/started' || method === 'item/completed') && params.item) {
    const item = getItem(state, { ...params, itemId: params.item.id }, params.item.type);
    Object.assign(item, params.item);
  } else if (method === 'item/agentMessage/delta') {
    const item = getItem(state, params, 'agentMessage');
    item.text = (item.text || '') + (params.delta || '');
  } else if (method === 'item/commandExecution/outputDelta') {
    const item = getItem(state, params, 'commandExecution');
    item.aggregatedOutput = (item.aggregatedOutput || '') + (params.delta || '');
  } else if (method === 'item/reasoning/summaryTextDelta') {
    const item = getItem(state, params, 'reasoning');
    item.summary ||= [];
    const index = Number.isInteger(params.summaryIndex) && params.summaryIndex >= 0 && params.summaryIndex < 1000 ? params.summaryIndex : 0;
    item.summary[index] = (item.summary[index] || '') + (params.delta || '');
  } else if (method === 'item/plan/delta') {
    const item = getItem(state, params, 'plan');
    item.text = (item.text || '') + (params.delta || '');
  } else if (method === 'turn/plan/updated') {
    getTurn(state, params.turnId).plan = params.plan;
    getTurn(state, params.turnId).planExplanation = params.explanation;
  } else if (method === 'turn/diff/updated') {
    getTurn(state, params.turnId).diff = params.diff;
  } else if (method === 'thread/tokenUsage/updated') {
    workspace.tokenUsage = params.tokenUsage;
  } else if (method === 'error') {
    workspace.lastError = params.error?.message || params.message || 'Codex reported an error';
  } else if (method === 'serverRequest/resolved') {
    state.pendingApprovals = state.pendingApprovals.filter((approval) => String(approval.requestId) !== String(params.requestId));
    if (!state.pendingApprovals.length && workspace.status === 'waiting_approval') workspace.status = 'running';
  }
}

export class WorkspaceStore extends EventEmitter {
  constructor({ dataDir, maxEvents = 4000, maxEventBytes = 8 * 1024 * 1024 }) {
    super();
    this.directory = join(dataDir, 'state');
    this.maxEvents = maxEvents;
    this.maxEventBytes = maxEventBytes;
    this.states = new Map();
    this.writes = new Map();
    this.timers = new Map();
    this.writeErrors = new Map();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json') || !WORKSPACE_ID.test(name.slice(0, -5))) continue;
      // Corrupt state is an operational error, never silently treated as a new workspace.
      const state = JSON.parse(await readFile(join(this.directory, name), 'utf8'));
      if (state.workspace.id !== name.slice(0, -5) || !Number.isSafeInteger(state.workspace.ownerId) || state.workspace.ownerId < 1 || state.workspace.ownerId > 9999999999) throw new Error('Invalid workspace state identity');
      state.eventBytes = state.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
      this.states.set(state.workspace.id, state);
      const conversations = this.projectStates(state);
      if (conversations.length > 100) throw new Error('Invalid project conversation count');
      const identities = new Set();
      for (const entry of conversations) {
        if (entry.workspace.id !== state.workspace.id || entry.workspace.ownerId !== state.workspace.ownerId || !WORKSPACE_ID.test(entry.conversation.id) || identities.has(entry.conversation.id)) throw new Error('Invalid project conversation identity');
        identities.add(entry.conversation.id);
        entry.eventBytes = entry.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
        if (!ACTIVE_STATUSES.has(entry.workspace.status)) continue;
        const turn = entry.thread?.turns?.find((value) => value.id === entry.workspace.activeTurnId);
        if (turn) turn.status = 'interrupted';
        entry.workspace.status = 'interrupted';
        entry.workspace.activeTurnId = null;
        entry.workspace.lastError = '服务已重启，任务已中断。文件和历史已保留，请检查后继续。';
        entry.pendingApprovals = [];
        this.record(entry, 'workbench/interrupted', { reason: 'service_restarted' });
        await this.persist(entry);
      }
    }
    // Load every conversation before restoring descendants, so a notification
    // about another saved conversation cannot masquerade as a child thread.
    const states = this.allStates();
    for (const state of states) {
      const foreignThreads = new Set(states.filter((entry) => entry !== state).map((entry) => entry.workspace.threadId).filter(Boolean));
      const count = state.events.length;
      state.events = state.events.filter((event) => event.method !== 'workbench/subagent/event' || !foreignThreads.has(subagentThreadId(event.params?.event)));
      let changed = state.events.length !== count;
      for (const turn of state.thread?.turns || []) {
        const itemCount = turn.items.length;
        turn.items = turn.items.filter((item) => item.type !== 'subagent' || !foreignThreads.has(item.threadId));
        if (turn.items.length !== itemCount) changed = true;
      }
      changed = restoreSubagentHistory(state) || changed;
      if (['interrupted', 'error'].includes(state.workspace.status)) {
        changed = settleSubagents(state.thread, state.workspace.status === 'error' ? 'failed' : 'interrupted') || changed;
      }
      if (changed) {
        state.eventBytes = state.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
        await this.persist(state);
      }
    }
  }

  list(ownerId) {
    return [...this.states.values()].filter((state) => state.workspace.ownerId === ownerId)
      .map((state) => {
        const active = this.projectStates(state).find((entry) => ACTIVE_STATUSES.has(entry.workspace.status));
        return this.publicWorkspace(active || state);
      }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  projectStates(state) {
    state.conversation ||= { id: state.workspace.id, name: state.workspace.preview?.slice(0, 80) || 'Conversation 1', createdAt: state.workspace.createdAt, updatedAt: state.workspace.updatedAt };
    return [state, ...Object.values(state.conversations || {})];
  }

  allStates() {
    return [...this.states.values()].flatMap((state) => this.projectStates(state));
  }

  root(state) {
    const project = this.states.get(state.workspace.id);
    if (!project) throw apiError(404, 'not_found', 'Workspace not found');
    return project;
  }

  conversations(state) {
    return this.projectStates(this.root(state)).map((entry) => ({ ...entry.conversation, archived: entry.conversation.archived === true, status: entry.workspace.status, turnCount: entry.thread?.turns?.length || 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  publicWorkspace(state) {
    const project = this.root(state);
    const entries = this.projectStates(project);
    const active = entries.find((entry) => ACTIVE_STATUSES.has(entry.workspace.status));
    return structuredClone({ ...state.workspace, name: project.workspace.name, archived: project.workspace.archived,
      updatedAt: project.workspace.updatedAt, conversationId: state.conversation.id, conversationName: state.conversation.name,
      conversationArchived: state.conversation.archived === true, conversationCount: entries.length, activeConversationId: active?.conversation.id || null });
  }

  get(ownerId, id, conversationId) {
    if (!WORKSPACE_ID.test(id)) throw apiError(404, 'not_found', 'Workspace not found');
    const state = this.states.get(id);
    if (!state || state.workspace.ownerId !== ownerId) throw apiError(404, 'not_found', 'Workspace not found');
    this.projectStates(state);
    if (!conversationId || conversationId === state.conversation.id) return state;
    if (!WORKSPACE_ID.test(conversationId)) throw apiError(404, 'conversation_not_found', 'Conversation not found');
    const conversation = state.conversations?.[conversationId];
    if (!conversation) throw apiError(404, 'conversation_not_found', 'Conversation not found');
    conversation.workspace.name = state.workspace.name;
    conversation.workspace.archived = state.workspace.archived;
    return conversation;
  }

  create(ownerId, { name, model, effort, mode, remote, host }) {
    const now = Date.now();
    const state = {
      workspace: { id: randomUUID(), ownerId, name, model, effort, mode, ...(remote ? { remote } : {}), ...(host ? { host } : {}), status: 'idle', createdAt: now, updatedAt: now, threadId: null, activeTurnId: null, archived: false, lastError: null },
      thread: null, pendingApprovals: [], events: [], cursor: 0, requests: {}, historyBytes: 0, eventBytes: 0,
    };
    this.states.set(state.workspace.id, state);
    this.projectStates(state);
    return state;
  }

  createConversation(state, name) {
    const project = this.root(state);
    const entries = this.projectStates(project);
    if (entries.length >= 100) throw apiError(409, 'conversation_limit', 'This project has reached its conversation limit');
    const now = Date.now(), id = randomUUID();
    const conversation = {
      conversation: { id, name: name || 'New conversation', customName: Boolean(name), archived: false, createdAt: now, updatedAt: now },
      workspace: { ...project.workspace, status: 'idle', threadId: null, activeTurnId: null, lastError: null, preview: '', tokenUsage: null },
      thread: null, pendingApprovals: [], events: [], cursor: 0, requests: {}, historyBytes: 0, eventBytes: 0,
    };
    project.conversations ||= {};
    project.conversations[id] = conversation;
    project.workspace.updatedAt = now;
    return conversation;
  }

  deleteConversation(state) {
    const project = this.root(state);
    if (state !== project) {
      delete project.conversations[state.conversation.id];
      return project;
    }
    // Project identity and native Codex homes are shared by its conversations.
    // Promote a surviving state itself so a live session keeps that same object.
    const remaining = Object.values(project.conversations || {}).sort((a, b) =>
      Number(a.conversation.archived === true) - Number(b.conversation.archived === true) || b.conversation.updatedAt - a.conversation.updatedAt);
    const replacement = remaining[0] || this.createConversation(project);
    const conversations = { ...project.conversations };
    delete conversations[replacement.conversation.id];
    replacement.conversations = conversations;
    replacement.workspace.name = project.workspace.name;
    replacement.workspace.archived = project.workspace.archived;
    this.states.set(project.workspace.id, replacement);
    return replacement;
  }

  record(state, method, params, extra = {}) {
    if (method === 'workbench/subagent/event') {
      const threadId = subagentThreadId(params.event);
      if (threadId && this.allStates().some((entry) => entry !== state && entry.workspace.threadId === threadId)) return null;
    }
    reduceNotification(state, method, params);
    if (method === 'turn/started') restoreSubagentHistory(state);
    state.workspace.updatedAt = Date.now();
    state.conversation.updatedAt = state.workspace.updatedAt;
    this.root(state).workspace.updatedAt = state.workspace.updatedAt;
    const event = { seq: ++state.cursor, method, params, time: state.workspace.updatedAt, ...extra };
    state.events.push(event);
    state.eventBytes = (state.eventBytes || 0) + Buffer.byteLength(JSON.stringify(event));
    while (state.events.length > this.maxEvents || (state.eventBytes > this.maxEventBytes && state.events.length > 1)) {
      state.eventBytes -= Buffer.byteLength(JSON.stringify(state.events.shift()));
    }
    this.emit(state.workspace.id, event);
    // Bounded write coalescing avoids rewriting history on every streamed token.
    if (!this.timers.has(state.workspace.id)) {
      const timer = setTimeout(() => {
        this.timers.delete(state.workspace.id);
        this.persist(state).catch((error) => { this.writeErrors.set(state.workspace.id, error); });
      }, 200);
      timer.unref?.();
      this.timers.set(state.workspace.id, timer);
    }
    return event;
  }

  async persist(state) {
    state = this.root(state);
    const id = state.workspace.id;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const contents = JSON.stringify(state);
    const old = this.writes.get(id) || Promise.resolve();
    const write = old.catch(() => {}).then(async () => {
      const temp = join(this.directory, `${id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, contents, { mode: 0o600 });
        await rename(temp, join(this.directory, `${id}.json`));
        this.writeErrors.delete(id);
      } catch (error) {
        this.writeErrors.set(id, error);
        await rm(temp, { force: true }).catch(() => {});
        throw apiError(507, 'persistence_failed', 'Workspace history could not be saved');
      }
    });
    this.writes.set(id, write);
    await write;
    if (this.writes.get(id) === write) this.writes.delete(id);
  }

  detail(state) {
    return { workspace: this.publicWorkspace(state), conversationId: state.conversation.id, conversations: this.conversations(state), queuedTurns: this.queuedTurns(state), thread: structuredClone(state.thread), pendingApprovals: structuredClone(state.pendingApprovals), events: structuredClone(state.events.slice(-100)), nextCursor: state.cursor, persistenceError: this.writeErrors.has(state.workspace.id) };
  }

  queuedTurns(state) {
    return (state.queuedTurns || []).map(({ requestId, prompt, model, group, effort, mode, createdAt, status, error }) => ({ requestId, prompt, model, group, effort, mode, createdAt, status, ...(error ? { error } : {}), ...(status === 'paused' ? { canResume: !state.requests[requestId] } : {}), conversationId: state.conversation.id }));
  }

  eventsAfter(state, after = 0) {
    const reset = after > state.cursor || (state.events.length > 0 && after < state.events[0].seq - 1);
    return { events: reset ? [] : state.events.filter((event) => event.seq > after), nextCursor: state.cursor, reset, conversationId: state.conversation.id, conversations: this.conversations(state), queuedTurns: this.queuedTurns(state), workspace: this.publicWorkspace(state), pendingApprovals: state.pendingApprovals, persistenceError: this.writeErrors.has(state.workspace.id) };
  }

  async delete(state) {
    const id = state.workspace.id;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    await this.writes.get(id)?.catch(() => {});
    await rm(join(this.directory, `${id}.json`), { force: true });
    this.states.delete(id);
    this.writeErrors.delete(id);
    this.removeAllListeners(id);
  }

  async close() {
    await Promise.all([...this.states.values()].map((state) => this.persist(state)));
  }
}
