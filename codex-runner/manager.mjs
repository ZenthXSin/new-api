import { createHash, randomUUID } from 'node:crypto';
import { CodexRpc } from './rpc.mjs';
import { ACTIVE_STATUSES, apiError } from './store.mjs';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request',
]);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceManager {
  constructor({ store, files, runtime, config }) {
    this.store = store;
    this.files = files;
    this.runtime = runtime;
    this.config = config;
    this.sessions = new Map();
    this.sessionClosures = new Map();
    this.pendingSessionCleanup = new Set();
    this.locks = new Map();
    this.starting = new Set();
    this.interruptions = new Map();
    this.closing = false;
    this.runtimeHealth = null;
    this.runningOwners = new Map();
    this.environmentOperations = new Map();
    this.environmentErrors = new Map();
  }

  async initialize() {
    await this.store.initialize();
    // Validate every stored owner mapping before touching containers or migrating
    // project files. Runtime initialization stops managed legacy/user containers;
    // no user may have an old workspace container and a new user container alive.
    const workspaces = [...this.store.states.values()].map((state) => state.workspace);
    await this.runtime.initialize(workspaces);
    await this.files.initialize(workspaces);
    this.idleTimer = setInterval(() => this.reapIdle().catch(() => {}), 15_000);
    this.idleTimer.unref?.();
  }

  sanitize(value) {
    let json = JSON.stringify(value);
    for (const secret of [this.config.apiKey, this.config.key]) {
      if (secret && secret.length > 6) json = json.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
    return JSON.parse(json);
  }

  async lock(id, action) {
    const prior = this.locks.get(id) || Promise.resolve();
    const current = prior.catch(() => {}).then(action);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  requireIdle(state) {
    if (ACTIVE_STATUSES.has(state.workspace.status)) throw apiError(409, 'workspace_busy', 'The workspace has an active task');
  }

  ownerWorkspaces(ownerId) {
    return [...this.store.states.values()].filter((state) => state.workspace.ownerId === ownerId);
  }

  activeWorkspace(ownerId) {
    return this.ownerWorkspaces(ownerId).find((state) => ACTIVE_STATUSES.has(state.workspace.status) || this.interruptions.has(state.workspace.id));
  }

  requireOwnerIdle(ownerId) {
    if (this.activeWorkspace(ownerId)) throw apiError(409, 'environment_busy', '该用户的环境正在执行任务，请先停止或等待当前任务完成。');
  }

  touchOwner(ownerId) {
    if (this.runningOwners.has(ownerId)) this.runningOwners.set(ownerId, Date.now());
  }

  async environment(ownerId) {
    let info;
    try {
      info = await this.runtime.environment(ownerId);
      if (['not_created', 'stopped'].includes(info.status) && !this.environmentOperations.has(ownerId)) this.runningOwners.delete(ownerId);
    } catch {
      // Docker diagnostics may contain host paths and operator configuration.
      info = { status: 'error', mode: 'code' };
    }
    const active = this.activeWorkspace(ownerId);
    const operation = this.environmentOperations.get(ownerId);
    const cleanupFailed = [...this.pendingSessionCleanup].some((id) => this.store.states.get(id)?.workspace.ownerId === ownerId && !this.sessionClosures.has(id));
    const lastError = info.status === 'error' ? '用户环境暂不可用，请稍后重试或检查运行服务。' : cleanupFailed ? '项目进程未能完全停止，请停止用户环境后重试。' : this.environmentErrors.get(ownerId);
    return { environment: {
      status: operation || (lastError ? 'error' : info.status),
      mode: info.mode === 'ask' ? 'ask' : 'code',
      activeWorkspaceId: active?.workspace.id || null,
      activeWorkspaceName: active?.workspace.name || null,
      projectCount: this.ownerWorkspaces(ownerId).length,
      idleSeconds: this.config.idleSeconds,
      limits: { cpus: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: info.diskLimitBytes || this.runtime.workspaceBytes || 2 * 1024 ** 3 },
      ...(lastError ? { lastError } : {}),
    } };
  }

  async closeOwnerSessions(ownerId, exceptId = null) {
    const ids = new Set([...this.sessions.keys(), ...this.sessionClosures.keys(), ...this.pendingSessionCleanup]);
    for (const id of ids) {
      if (this.store.states.get(id)?.workspace.ownerId !== ownerId) continue;
      if (id === exceptId && !this.pendingSessionCleanup.has(id)) await this.sessionClosures.get(id);
      else await this.stopSession(id);
    }
  }

  async ensureEnvironment(ownerId, mode) {
    // Every automatic start and explicit start shares this capacity reservation.
    // Counting containers also covers manually started environments with no task.
    return this.lock('environment-capacity', async () => {
      if (this.closing) throw apiError(503, 'service_stopping', 'Codex 服务正在停止，请稍后重试。');
      for (const [otherOwner] of this.runningOwners) {
        const info = await this.runtime.environment(otherOwner);
        if (['not_created', 'stopped'].includes(info.status)) this.runningOwners.delete(otherOwner);
      }
      if (!this.runningOwners.has(ownerId) && this.runningOwners.size >= this.config.maxActive) throw apiError(429, 'environment_limit', '运行中的用户环境已达到上限，请等待空闲环境休眠或停止一个环境。');
      this.environmentOperations.set(ownerId, 'starting');
      try {
        await this.runtime.startUser(ownerId, { mode });
        this.runningOwners.set(ownerId, Date.now());
        this.environmentErrors.delete(ownerId);
      } catch (error) {
        this.environmentErrors.set(ownerId, '用户环境启动失败，请稍后重试或检查运行服务。');
        throw error;
      } finally { this.environmentOperations.delete(ownerId); }
    });
  }

  async startEnvironment(ownerId) {
    this.requireOwnerIdle(ownerId);
    return this.lock(`owner:${ownerId}`, async () => {
      this.requireOwnerIdle(ownerId);
      for (const id of this.pendingSessionCleanup) {
        if (this.store.states.get(id)?.workspace.ownerId === ownerId) await this.stopSession(id);
      }
      const info = await this.runtime.environment(ownerId);
      await this.ensureEnvironment(ownerId, info.mode === 'ask' ? 'ask' : 'code');
      return this.environment(ownerId);
    });
  }

  async stopOwnerEnvironment(ownerId) {
    const ids = new Set([...this.sessions.keys(), ...this.sessionClosures.keys(), ...this.pendingSessionCleanup]);
    const owned = [...ids].filter((id) => this.store.states.get(id)?.workspace.ownerId === ownerId);
    // Stopping the whole user environment is also the recovery path for a
    // failed per-project cleanup. Wait for all attempts, then stop the container.
    await Promise.allSettled(owned.map((id) => this.stopSession(id)));
    await this.lock('environment-capacity', async () => {
      await this.runtime.stopUser(ownerId);
      for (const id of owned) this.pendingSessionCleanup.delete(id);
      this.runningOwners.delete(ownerId);
      this.environmentErrors.delete(ownerId);
    });
  }

  async stopEnvironment(ownerId) {
    // Fail promptly during a long turn/start instead of queueing a stop that
    // could surprise the user after a later task has already started.
    this.requireOwnerIdle(ownerId);
    return this.lock(`owner:${ownerId}`, async () => {
      this.requireOwnerIdle(ownerId);
      try { await this.stopOwnerEnvironment(ownerId); }
      catch (error) {
        this.environmentErrors.set(ownerId, '用户环境停止失败，请稍后重试。');
        throw error;
      }
      return this.environment(ownerId);
    });
  }

  async getStatus() {
    const status = this.status();
    if (!status.configured || !this.runtime.availability) return status;
    if (!this.runtimeHealth || Date.now() - this.runtimeHealth.time > 15_000) {
      try {
        const health = await this.runtime.availability();
        this.runtimeHealth = { ...health, time: Date.now() };
      } catch {
        this.runtimeHealth = { available: false, reason: '工作区执行环境暂不可用，请检查运行服务。', time: Date.now() };
      }
    }
    return { ...status, available: status.available && this.runtimeHealth.available, ...(this.runtimeHealth.reason ? { reason: this.runtimeHealth.reason } : {}) };
  }

  status() {
    const configured = Boolean(this.config.apiKey && this.config.apiBaseUrl && this.config.models.length);
    return {
      available: configured && !this.closing,
      configured,
      version: this.config.version || '0.160.0',
      ...(!configured ? { reason: '请先配置 Codex 工作台的模型服务与专用 API 令牌。' } : {}),
      models: this.config.models.map((model) => ({ id: model, name: model })),
      defaultModel: this.config.defaultModel,
      efforts: this.config.efforts,
      defaultEffort: this.config.defaultEffort,
      limits: { maxActive: this.config.maxActive, maxWorkspaces: this.config.maxWorkspaces, uploadBytes: 25 * 1024 * 1024, fileBytes: 1024 * 1024 },
      capabilities: { gitImport: true, zipImport: true, files: true, diff: true, approvals: true, userEnvironment: true },
    };
  }

  async create(ownerId, body) {
    return this.lock(`owner:${ownerId}`, async () => {
      this.requireOwnerIdle(ownerId);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) throw apiError(400, 'invalid_name', 'Workspace name must contain 1 to 120 characters');
      if (this.store.list(ownerId).length >= this.config.maxWorkspaces) throw apiError(409, 'workspace_limit', 'Workspace limit reached');
      if (body.repositoryUrl !== undefined && typeof body.repositoryUrl !== 'string') throw apiError(400, 'invalid_repository', 'Invalid repository URL');
      const state = this.store.create(ownerId, { name, model: this.config.defaultModel, effort: this.config.defaultEffort, mode: 'code' });
      try {
        await this.closeOwnerSessions(ownerId);
        this.runtime.registerWorkspace(state.workspace.id, ownerId);
        await this.files.create(state.workspace.id, ownerId);
        if (body.repositoryUrl) {
          await this.closeOwnerSessions(ownerId);
          await this.ensureEnvironment(ownerId, 'code');
          await this.files.clone(state.workspace.id, body.repositoryUrl, body.branch);
          this.touchOwner(ownerId);
        }
        await this.store.persist(state);
        return { workspace: this.store.publicWorkspace(state) };
      } catch (error) {
        await this.files.remove?.(state.workspace.id).catch(() => {});
        this.runtime.unregisterWorkspace(state.workspace.id);
        await this.store.delete(state);
        throw error;
      }
    });
  }

  async update(ownerId, id, body) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      if ('archived' in body) {
        if (typeof body.archived !== 'boolean') throw apiError(400, 'invalid_archive', 'Invalid archive state');
        this.requireOwnerIdle(ownerId);
      }
      if ('name' in body) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) throw apiError(400, 'invalid_name', 'Workspace name must contain 1 to 120 characters');
        state.workspace.name = body.name.trim();
      }
      if ('archived' in body) {
        state.workspace.archived = body.archived;
      }
      this.store.record(state, 'workbench/workspace/updated', { workspace: this.store.publicWorkspace(state) });
      await this.store.persist(state);
      return { workspace: this.store.publicWorkspace(state) };
    });
  }

  async delete(ownerId, id) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      this.requireOwnerIdle(ownerId);
      await this.closeOwnerSessions(ownerId);
      if (!this.files.remove) throw apiError(503, 'unsupported', 'Workspace removal is unavailable');
      await this.files.remove(id);
      await this.store.delete(state);
      this.runtime.unregisterWorkspace(id);
      this.touchOwner(ownerId);
      return { deleted: true };
    });
  }

  async ensureSession(state) {
    const id = state.workspace.id;
    if (!this.status().configured) throw apiError(503, 'not_configured', this.status().reason);
    // One live App Server per user avoids shared mount-mode changes and stray
    // processes from an old project interfering with the current project.
    await this.closeOwnerSessions(state.workspace.ownerId, id);
    let existing = this.sessions.get(id);
    const info = await this.runtime.environment(state.workspace.ownerId);
    if (existing && (existing.rpc.closed || existing.mode !== state.workspace.mode || info.status !== 'running')) {
      await this.stopSession(id);
      existing = null;
    }
    this.starting.add(id);
    try {
      await this.ensureEnvironment(state.workspace.ownerId, state.workspace.mode);
      if (existing) { existing.lastUsed = Date.now(); return existing; }
      await this.runtime.baseline?.(id);
      const child = await this.runtime.spawnAppServer(id, { env: { NEW_API_KEY: this.config.apiKey, NEW_API_BASE_URL: this.config.apiBaseUrl }, mode: state.workspace.mode });
      const rpc = new CodexRpc(child, { timeoutMs: this.config.rpcTimeoutMs || 60_000 });
      const session = { rpc, lastUsed: Date.now(), intentionalClose: false, mode: state.workspace.mode };
      this.sessions.set(id, session);
      rpc.on('message', (message) => this.onMessage(state, session, message));
      rpc.on('closed', (error) => {
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        if (session.intentionalClose) return;
        // A detached docker-exec client can leave the actual worker alive. Start
        // cleanup synchronously so the next task waits before reusing this ID.
        this.stopSession(id, session).catch(() => {});
        if (ACTIVE_STATUSES.has(state.workspace.status)) {
          const turn = state.thread?.turns?.find((value) => value.id === state.workspace.activeTurnId);
          if (turn) turn.status = 'interrupted';
          state.workspace.status = 'interrupted';
          state.workspace.activeTurnId = null;
          state.workspace.lastError = this.sanitize(error.message);
          state.pendingApprovals = [];
          this.store.record(state, 'workbench/interrupted', { reason: 'runtime_stopped', message: state.workspace.lastError });
          this.store.persist(state).catch(() => {});
        }
      });
      await rpc.initialize();
      const sandbox = 'danger-full-access';
      const cwd = this.runtime.cwd(id);
      const params = { cwd, model: state.workspace.model, modelProvider: 'newapi', approvalPolicy: 'on-request', sandbox, developerInstructions: state.workspace.mode === 'ask' ? 'This workspace is in Ask mode. The project directory is mounted read-only. Inspect files and answer questions. Do not modify project files or attempt to bypass the read-only mount.' : `This workspace is in Code mode. Work in ${cwd} and implement the administrator’s requested changes. Other projects belonging to this user share the same environment; modify only this project unless explicitly requested.` };
      const result = state.workspace.threadId
        ? await rpc.request('thread/resume', { ...params, threadId: state.workspace.threadId, excludeTurns: true })
        : await rpc.request('thread/start', params);
      if (!result?.thread?.id) throw apiError(502, 'invalid_thread', 'Codex did not create a valid thread');
      const resumedThread = this.sanitize(result.thread);
      // Recent Codex versions return summary-only/paginated turns. Preserve the
      // authoritative full item history already received over notifications.
      const savedTurns = state.thread?.turns || [];
      for (const incoming of resumedThread.turns || []) {
        const saved = savedTurns.find((turn) => turn.id === incoming.id);
        if (!saved) savedTurns.push(incoming);
        else {
          const items = [...saved.items];
          for (const item of incoming.items || []) {
            const index = items.findIndex((entry) => entry.id === item.id);
            if (index < 0) items.push(item);
            else items[index] = { ...items[index], ...item };
          }
          Object.assign(saved, incoming, { items });
        }
      }
      state.thread = { ...resumedThread, turns: savedTurns };
      state.workspace.threadId = result.thread.id;
      if ((state.historyBytes || 0) === 0) state.historyBytes = Buffer.byteLength(JSON.stringify(state.thread));
      await this.store.persist(state);
      return session;
    } catch (error) {
      await this.stopSession(id).catch(() => {});
      throw error;
    } finally { this.starting.delete(id); }
  }

  onMessage(state, session, rawMessage) {
    if (session.intentionalClose || this.sessions.get(state.workspace.id) !== session || session.historyLimitReached) return;
    const message = this.sanitize(rawMessage);
    state.historyBytes = (state.historyBytes || 0) + Buffer.byteLength(JSON.stringify(message));
    if (state.historyBytes > (this.config.historyBytes || 64 * 1024 * 1024)) {
      session.historyLimitReached = true;
      state.workspace.status = 'error';
      state.workspace.activeTurnId = null;
      state.workspace.lastError = '工作区会话已达到历史容量上限。已保留收到的内容，请导出项目并创建新工作区。';
      state.pendingApprovals = [];
      this.store.record(state, 'workbench/error', { code: 'history_limit', message: state.workspace.lastError });
      this.stopSession(state.workspace.id).catch(() => {});
      this.store.persist(state).catch(() => {});
      return;
    }
    const params = message.params || {};
    session.lastUsed = Date.now();
    this.touchOwner(state.workspace.ownerId);
    // Descendant-agent threads still produce useful native events. They do not
    // replace the root thread's active turn or authoritative conversation.
    const foreign = params.threadId && state.workspace.threadId && params.threadId !== state.workspace.threadId;
    if ('id' in message) {
      if (!APPROVAL_METHODS.has(message.method)) {
        session.rpc.reject(rawMessage.id);
        this.store.record(state, 'workbench/unsupportedRequest', { method: message.method, message: 'This Codex request is not supported by the workbench and was rejected.' });
        return;
      }
      const approval = { id: randomUUID(), requestId: rawMessage.id, method: message.method, params };
      state.pendingApprovals.push(approval);
      state.workspace.status = 'waiting_approval';
      this.store.record(state, 'workbench/approval/requested', { approval });
      this.store.persist(state).catch(() => {});
      return;
    }
    if (foreign && message.method !== 'serverRequest/resolved') {
      this.store.record(state, 'workbench/subagent/event', { event: message });
      return;
    }
    if (message.method === 'thread/started' && state.workspace.threadId && params.thread?.id !== state.workspace.threadId) {
      this.store.record(state, 'workbench/subagent/event', { event: message });
      return;
    }
    this.store.record(state, message.method, params);
    if (message.method === 'turn/started') {
      const request = Object.values(state.requests).find((entry) => entry.status === 'pending');
      if (request) { request.turnId = params.turn?.id; request.status = 'accepted'; }
    }
    if (['turn/started', 'turn/completed', 'serverRequest/resolved'].includes(message.method)) this.store.persist(state).catch(() => {});
  }

  validateTurn(body) {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 100_000) throw apiError(400, 'invalid_prompt', 'Prompt must contain 1 to 100000 characters');
    if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw apiError(400, 'invalid_request_id', 'A UUID requestId is required');
    const model = body.model || this.config.defaultModel;
    const effort = body.effort || this.config.defaultEffort;
    const mode = body.mode || 'code';
    if (!this.config.models.includes(model)) throw apiError(400, 'invalid_model', 'Model is not configured for this workbench');
    if (!this.config.efforts.includes(effort)) throw apiError(400, 'invalid_effort', 'Unsupported reasoning effort');
    if (!['code', 'ask'].includes(mode)) throw apiError(400, 'invalid_mode', 'Mode must be code or ask');
    return { prompt, model, effort, mode, requestId: body.requestId };
  }

  async turn(ownerId, id, body) {
    const input = this.validateTurn(body);
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      const fingerprint = createHash('sha256').update(JSON.stringify({ prompt: input.prompt, model: input.model, effort: input.effort, mode: input.mode })).digest('hex');
      const previous = state.requests[input.requestId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw apiError(409, 'idempotency_conflict', 'This request ID was already used for different input');
        if (previous.status === 'failed') throw apiError(previous.statusCode || 409, previous.code || 'task_not_started', previous.message || 'The prior request failed; create a new request to retry');
        return { workspace: this.store.publicWorkspace(state), turnId: previous.turnId || null, duplicate: true };
      }
      this.requireOwnerIdle(ownerId);
      if ((state.historyBytes || 0) >= (this.config.historyBytes || 64 * 1024 * 1024)) throw apiError(409, 'history_limit', 'Workspace history limit reached; export your project and create another workspace');
      if (state.workspace.archived) throw apiError(409, 'workspace_archived', 'Restore the workspace before starting a task');
      if (Object.keys(state.requests).length >= 10_000) throw apiError(409, 'turn_limit', 'This workspace has reached its task history limit; create another workspace');
      const active = [...this.store.states.values()].filter((entry) => ACTIVE_STATUSES.has(entry.workspace.status)).length;
      if (active >= this.config.maxActive) throw apiError(429, 'active_limit', 'Too many active Codex tasks; wait for a task to finish');
      state.workspace.model = input.model;
      state.workspace.effort = input.effort;
      state.workspace.mode = input.mode;
      const executionEpoch = (state.executionEpoch || 0) + 1;
      state.executionEpoch = executionEpoch;
      state.workspace.status = 'starting';
      state.workspace.lastError = null;
      state.workspace.preview = input.prompt.slice(0, 180);
      state.requests[input.requestId] = { fingerprint, status: 'pending', createdAt: Date.now(), turnId: null };
      this.store.record(state, 'workbench/task/starting', { requestId: input.requestId });
      await this.store.persist(state);
      let sent = false;
      try {
        const session = await this.ensureSession(state);
        if (state.executionEpoch !== executionEpoch) {
          await this.stopSession(id);
          throw apiError(409, 'task_interrupted', 'Task was interrupted before it started');
        }
        sent = true;
        const result = await session.rpc.request('turn/start', {
          threadId: state.workspace.threadId,
          input: [{ type: 'text', text: input.prompt }],
          model: input.model, effort: input.effort, cwd: this.runtime.cwd(id),
          approvalPolicy: 'on-request',
          sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
        });
        const record = state.requests[input.requestId];
        record.status = 'accepted';
        record.turnId = result?.turn?.id || record.turnId;
        if (state.workspace.status === 'starting' && result?.turn) this.store.record(state, 'turn/started', { threadId: state.workspace.threadId, turn: result.turn });
        await this.store.persist(state);
        return { workspace: this.store.publicWorkspace(state), turnId: record.turnId };
      } catch (error) {
        const record = state.requests[input.requestId];
        // A timeout after send is ambiguous. Retrying this ID must never start a
        // second billable task. Native turn notifications remain authoritative.
        if (sent && error.code === 'runtime_timeout') {
          record.status = record.turnId ? 'accepted' : 'uncertain';
          state.workspace.lastError = '请求确认超时，请查看任务状态。重复提交同一请求不会重新执行。';
        } else if (record.status !== 'accepted') {
          record.status = 'failed';
          record.code = error.code || 'task_start_failed';
          record.statusCode = error.statusCode || 502;
          record.message = this.sanitize(error.message);
          state.workspace.status = error.code === 'task_interrupted' ? 'interrupted' : 'error';
          state.workspace.lastError = record.message;
        }
        this.store.record(state, 'workbench/error', { message: state.workspace.lastError, code: error.code || 'task_start_failed' });
        await this.store.persist(state);
        throw error;
      }
    });
  }

  async interrupt(ownerId, id) {
    // Never queue behind turn/start; it may be waiting on a slow provider.
    const state = this.store.get(ownerId, id);
    const pending = this.interruptions.get(id);
    if (pending) return pending;
    const session = this.sessions.get(id);
    state.executionEpoch = (state.executionEpoch || 0) + 1;
    if (!ACTIVE_STATUSES.has(state.workspace.status)) return { workspace: this.store.publicWorkspace(state) };
    const task = Promise.resolve().then(async () => {
      const turnId = state.workspace.activeTurnId;
      if (session && turnId) {
        // Native cancellation alone leaves detached command sessions alive in
        // Codex 0.160.0. Give it a short chance to persist the final notification,
        // then always reap this project's App Server and its process group.
        await session.rpc.request('turn/interrupt', { threadId: state.workspace.threadId, turnId }, 3000).catch(() => {});
      }
      try { await this.stopSession(id, session); }
      catch (error) {
        state.workspace.status = 'error';
        state.workspace.activeTurnId = null;
        state.pendingApprovals = [];
        state.workspace.lastError = '项目进程未能完全停止，请停止用户环境后重试。';
        this.store.record(state, 'workbench/error', { code: 'runtime_stop_failed', message: state.workspace.lastError });
        await this.store.persist(state);
        throw error;
      }
      const turn = state.thread?.turns?.find((value) => value.id === turnId);
      if (turn && !['completed', 'failed'].includes(turn.status)) turn.status = 'interrupted';
      state.workspace.status = 'interrupted';
      state.workspace.activeTurnId = null;
      state.pendingApprovals = [];
      state.workspace.lastError = null;
      this.touchOwner(ownerId);
      this.store.record(state, 'workbench/interrupted', { reason: 'user_requested' });
      await this.store.persist(state);
      return { workspace: this.store.publicWorkspace(state) };
    });
    this.interruptions.set(id, task);
    try { return await task; }
    finally { if (this.interruptions.get(id) === task) this.interruptions.delete(id); }
  }

  async approve(ownerId, id, approvalId, body) {
    const state = this.store.get(ownerId, id);
    const approval = state.pendingApprovals.find((entry) => entry.id === approvalId);
    if (!approval) throw apiError(409, 'approval_expired', 'The approval request is no longer pending');
    const session = this.sessions.get(id);
    if (!session || session.rpc.closed) throw apiError(409, 'approval_expired', 'The Codex session is no longer connected');
    let result;
    if (approval.method === 'item/tool/requestUserInput') {
      if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) throw apiError(400, 'invalid_answers', 'Question answers are required');
      result = { answers: {} };
      for (const question of approval.params.questions || []) {
        const answers = body.answers[question.id]?.answers;
        if (!Array.isArray(answers) || !answers.length || answers.length > 20 || answers.some((answer) => typeof answer !== 'string' || answer.length > 10_000)) throw apiError(400, 'invalid_answers', 'Every question must have a valid answer');
        result.answers[question.id] = { answers };
      }
    } else {
      if (!['accept', 'decline'].includes(body.decision)) throw apiError(400, 'invalid_decision', 'Decision must be accept or decline');
      if (approval.method === 'item/permissions/requestApproval') {
        result = { permissions: body.decision === 'accept' ? (approval.params.permissions || {}) : {}, scope: 'turn' };
      } else if (approval.method === 'mcpServer/elicitation/request') {
        if (body.decision === 'accept') throw apiError(400, 'unsupported_approval', 'MCP form approval is not supported; decline this request');
        result = { action: 'decline', content: null };
      } else result = { decision: body.decision };
    }
    session.rpc.respond(approval.requestId, result);
    state.pendingApprovals = state.pendingApprovals.filter((entry) => entry.id !== approvalId);
    if (!state.pendingApprovals.length && state.workspace.status === 'waiting_approval') state.workspace.status = 'running';
    // Never store request_user_input answers here: questions may contain secrets.
    this.store.record(state, 'workbench/approval/resolved', { id: approvalId, decision: body.decision || 'answered' });
    await this.store.persist(state);
    return { workspace: this.store.publicWorkspace(state) };
  }

  async diff(ownerId, id) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      const active = this.activeWorkspace(ownerId);
      if (active && (active.workspace.id !== id || active.workspace.mode === 'ask')) this.requireOwnerIdle(ownerId);
      if (!active) {
        await this.closeOwnerSessions(ownerId);
        await this.ensureEnvironment(ownerId, state.workspace.mode);
      }
      const result = await this.files.diff(id);
      this.touchOwner(ownerId);
      return result;
    });
  }

  async export(ownerId, id) {
    return this.lock(`owner:${ownerId}`, async () => {
      this.store.get(ownerId, id);
      this.requireOwnerIdle(ownerId);
      await this.closeOwnerSessions(ownerId);
      const result = await this.files.exportZip(id);
      this.touchOwner(ownerId);
      return result;
    });
  }

  async mutateFiles(ownerId, id, action) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      this.requireOwnerIdle(ownerId);
      await this.closeOwnerSessions(ownerId);
      const result = await action(state);
      this.touchOwner(ownerId);
      this.store.record(state, 'workbench/files/updated', {});
      await this.store.persist(state);
      return result;
    });
  }

  async stopSession(id, expectedSession = null) {
    const current = this.sessions.get(id);
    if (expectedSession && current && current !== expectedSession) return;
    const pending = this.sessionClosures.get(id);
    if (pending) return pending;
    const session = current || expectedSession;
    if (session) {
      session.intentionalClose = true;
      session.rpc.close();
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    }
    // Reserve cleanup before its first asynchronous step. The next task must
    // await it so a late old-worker stop cannot kill a new project process.
    this.pendingSessionCleanup.add(id);
    const closing = Promise.resolve().then(() => this.runtime.stopAppServer(id));
    this.sessionClosures.set(id, closing);
    try { await closing; this.pendingSessionCleanup.delete(id); }
    finally { if (this.sessionClosures.get(id) === closing) this.sessionClosures.delete(id); }
  }

  async reapIdle() {
    for (const [ownerId] of this.runningOwners) {
      // Do not queue a stale idle decision behind a task currently starting.
      if (this.locks.has(`owner:${ownerId}`) || this.ownerWorkspaces(ownerId).some((state) => this.interruptions.has(state.workspace.id))) continue;
      await this.lock(`owner:${ownerId}`, async () => {
        const state = this.activeWorkspace(ownerId);
        const diskProject = state || this.ownerWorkspaces(ownerId)[0];
        if (this.runtime.enforceUserDiskLimit || diskProject && this.runtime.enforceDiskLimit) {
          try {
            if (this.runtime.enforceUserDiskLimit) await this.runtime.enforceUserDiskLimit(ownerId);
            else await this.runtime.enforceDiskLimit(diskProject.workspace.id);
          }
          catch (error) {
            await this.stopOwnerEnvironment(ownerId).catch(() => {});
            const message = '用户环境存储超限或空间不足，环境已停止。请整理项目文件后重试。';
            this.environmentErrors.set(ownerId, message);
            if (state) {
              state.workspace.status = 'error';
              state.workspace.activeTurnId = null;
              state.pendingApprovals = [];
              state.workspace.lastError = this.sanitize(error.message);
              this.store.record(state, 'workbench/error', { code: error.code, message: state.workspace.lastError });
              await this.store.persist(state);
            }
          }
        }
        if (this.runningOwners.has(ownerId) && !this.activeWorkspace(ownerId) && Date.now() - this.runningOwners.get(ownerId) > this.config.idleSeconds * 1000) await this.stopOwnerEnvironment(ownerId);
      });
    }
  }

  async close() {
    this.closing = true;
    clearInterval(this.idleTimer);
    for (const [id] of this.sessions) {
      const state = this.store.states.get(id);
      if (state && ACTIVE_STATUSES.has(state.workspace.status)) {
        const turn = state.thread?.turns?.find((entry) => entry.id === state.workspace.activeTurnId);
        if (turn) turn.status = 'interrupted';
        state.workspace.status = 'interrupted';
        state.workspace.activeTurnId = null;
        state.pendingApprovals = [];
        this.store.record(state, 'workbench/interrupted', { reason: 'service_stopped' });
      }
      await this.stopSession(id).catch(() => {});
    }
    for (const [ownerId] of this.runningOwners) await this.stopOwnerEnvironment(ownerId);
    await this.store.close();
  }
}
