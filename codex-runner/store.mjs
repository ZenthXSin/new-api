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
  return turn;
}

function getItem(state, params, type) {
  const turn = getTurn(state, params.turnId || state.workspace.activeTurnId);
  let item = turn.items.find((value) => value.id === params.itemId);
  if (!item) { item = { id: params.itemId, type }; turn.items.push(item); }
  return item;
}

// Store the same public thread shape as App Server, including partial output.
export function reduceNotification(state, method, params) {
  const workspace = state.workspace;
  if (method === 'thread/started' && params.thread) {
    workspace.threadId = params.thread.id;
    state.thread = { ...params.thread, turns: params.thread.turns || state.thread?.turns || [] };
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
      if (ACTIVE_STATUSES.has(state.workspace.status)) {
        const turn = state.thread?.turns?.find((value) => value.id === state.workspace.activeTurnId);
        if (turn) turn.status = 'interrupted';
        state.workspace.status = 'interrupted';
        state.workspace.activeTurnId = null;
        state.workspace.lastError = '服务已重启，任务已中断。文件和历史已保留，请检查后继续。';
        state.pendingApprovals = [];
        this.record(state, 'workbench/interrupted', { reason: 'service_restarted' });
        await this.persist(state);
      }
    }
  }

  list(ownerId) {
    return [...this.states.values()].filter((state) => state.workspace.ownerId === ownerId)
      .map((state) => this.publicWorkspace(state)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  publicWorkspace(state) {
    return structuredClone(state.workspace);
  }

  get(ownerId, id) {
    if (!WORKSPACE_ID.test(id)) throw apiError(404, 'not_found', 'Workspace not found');
    const state = this.states.get(id);
    if (!state || state.workspace.ownerId !== ownerId) throw apiError(404, 'not_found', 'Workspace not found');
    return state;
  }

  create(ownerId, { name, model, effort, mode }) {
    const now = Date.now();
    const state = {
      workspace: { id: randomUUID(), ownerId, name, model, effort, mode, status: 'idle', createdAt: now, updatedAt: now, threadId: null, activeTurnId: null, archived: false, lastError: null },
      thread: null, pendingApprovals: [], events: [], cursor: 0, requests: {}, historyBytes: 0, eventBytes: 0,
    };
    this.states.set(state.workspace.id, state);
    return state;
  }

  record(state, method, params, extra = {}) {
    reduceNotification(state, method, params);
    state.workspace.updatedAt = Date.now();
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
    return { workspace: this.publicWorkspace(state), thread: structuredClone(state.thread), pendingApprovals: structuredClone(state.pendingApprovals), events: structuredClone(state.events.slice(-100)), nextCursor: state.cursor, persistenceError: this.writeErrors.has(state.workspace.id) };
  }

  eventsAfter(state, after = 0) {
    const reset = after > state.cursor || (state.events.length > 0 && after < state.events[0].seq - 1);
    return { events: reset ? [] : state.events.filter((event) => event.seq > after), nextCursor: state.cursor, reset, workspace: this.publicWorkspace(state), pendingApprovals: state.pendingApprovals, persistenceError: this.writeErrors.has(state.workspace.id) };
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
