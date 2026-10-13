import { AccountTools, accountDynamicTools } from './account-tools.mjs';
import { PortForwardManager } from './port-forwards.mjs';
import { PortTools, portDynamicTools } from './port-tools.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { installWorkbenchExtensions } from './workbench-extensions.mjs';
import { CodexRpc } from './rpc.mjs';
import { executionPolicy } from './execution-policy.mjs';
import modelCapabilities from './model-capabilities.json' with { type: 'json' };
import { ACTIVE_STATUSES, apiError } from './store.mjs';
import { GitHubCredentials } from './github-credentials.mjs';
import { prepareConversationReplay, persistConversationReplay } from './branching.mjs';
import { workspaceRepository } from './repository.mjs';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request',
]);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Conversations share project files, but never share a live App Server or cancellation key.
function sessionKey(state) {
 return state.conversation.id === state.workspace.id ? state.workspace.id : `${state.workspace.id}:${state.conversation.id}`;
}
function sessionProjectId(key) { return key.split(':')[0]; }
function sessionProcessId(key) { return key.split(':')[1] || key; }

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
    this.githubCredentials = new GitHubCredentials();
    this.githubCredentialCleanup = new Set();
    this.modelCredentials = new Map();
    this.modelSecrets = new Set();
    this.accountTools = new AccountTools(this);
    this.ports = new PortForwardManager({ dataDir: config.dataDir, runtime: runtime.local || runtime, configFile: config.frpConfigFile });
    this.portTools = new PortTools(this);
    this.queueCredentials = new Map();
    this.queueDrains = new Map();
    this.queuePriorities = new Map();
    this.queueSequence = 0;
    installWorkbenchExtensions(this);
  }

  async initialize() {
    await this.store.initialize();
    // Validate every stored owner mapping before touching containers or migrating
    // project files. Runtime initialization stops managed legacy/user containers;
    // no user may have an old workspace container and a new user container alive.
    const workspaces = [...this.store.states.values()].map((state) => state.workspace);
    await this.runtime.initialize(workspaces);
    await this.files.initialize(workspaces);
    await this.cloud.initialize();
    await this.ports.initialize();
    for (const state of this.store.allStates()) {
      for (const entry of state.queuedTurns || []) {
        this.queueSequence = Math.max(this.queueSequence, entry.sequence || 0);
        entry.status = 'paused';
        entry.error = 'The service restarted. Your queued message was preserved. Resume the queue to authorize again.';
      }
      if (state.queuedTurns?.length) await this.store.persist(state);
    }
    this.idleTimer = setInterval(() => this.reapIdle().catch(() => {}), 15_000);
    this.idleTimer.unref?.();
  }

  sanitize(value) {
    let json = JSON.stringify(value);
    for (const secret of [this.config.apiKey, this.config.key]) {
      if (secret && secret.length > 6) json = json.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
    for (const secret of this.modelSecrets) json = json.split(secret).join('[REDACTED]');
    return JSON.parse(this.cloud.sanitizeJSON(this.githubCredentials.sanitizeJSON(json)));
  }

  githubEnvironment(ownerId) { return this.githubCredentials.environment(ownerId); }

  async syncGitHubCredentials(ownerId, headers) {
    const credential = this.githubCredentials.parse(headers);
    return this.lock(`owner:${ownerId}`, async () => {
      const result = this.githubCredentials.update(ownerId, credential);
      this.runtime.setGitHubCredential?.(ownerId, result.credential);
      if (result.changed) this.githubCredentialCleanup.add(ownerId);
      if (!this.githubCredentialCleanup.has(ownerId)) return;
      const states = this.ownerWorkspaces(ownerId);
      for (const state of states) {
        state.executionEpoch = (state.executionEpoch || 0) + 1;
        if (!ACTIVE_STATUSES.has(state.workspace.status)) continue;
        const turn = state.thread?.turns?.find((entry) => entry.id === state.workspace.activeTurnId);
        if (turn) turn.status = 'interrupted';
        state.workspace.status = 'interrupted';
        state.workspace.activeTurnId = null;
        state.pendingApprovals = [];
        this.store.record(state, 'workbench/interrupted', { reason: 'github_authorization_changed' });
        await this.store.persist(state);
      }
      // Try every project even when one remote server is unreachable. Stopping
      // Docker also kills processes that deliberately detached from App Server.
      const stops = await Promise.allSettled(states.map((state) => this.stopSession(sessionKey(state))));
      await this.runtime.stopUser(ownerId);
      this.runningOwners.delete(ownerId);
      if (stops.some((result) => result.status === 'rejected')) {
        throw apiError(503, 'github_cleanup_failed', 'GitHub authorization changed, but some project processes could not be stopped; retry disconnection');
      }
      this.githubCredentialCleanup.delete(ownerId);
    });
  }

  async disconnectGitHub(ownerId, headers) {
    const credential = this.githubCredentials.parse(headers);
    if (!credential || credential.token) throw apiError(400, 'invalid_github_credentials', 'GitHub disconnection requires a cleared authorization generation');
    this.githubCredentialCleanup.add(ownerId);
    await this.syncGitHubCredentials(ownerId, headers);
    return { disconnected: true };
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
    return this.store.allStates().filter((state) => state.workspace.ownerId === ownerId);
  }

  activeWorkspace(ownerId) {
    return this.ownerWorkspaces(ownerId).find((state) => ACTIVE_STATUSES.has(state.workspace.status) || this.interruptions.has(sessionKey(state)));
  }

  requireOwnerIdle(ownerId) {
    if (this.activeWorkspace(ownerId)) throw apiError(409, 'environment_busy', '该用户的环境正在执行任务，请先停止或等待当前任务完成。');
  }

  touchOwner(ownerId) {
    if (this.runningOwners.has(ownerId)) this.runningOwners.set(ownerId, Date.now());
  }

  queueKey(state, requestId) { return `${state.workspace.id}:${state.conversation.id}:${requestId}`; }

  clearQueuedTurn(state, requestId) {
    state.queuedTurns = (state.queuedTurns || []).filter((entry) => entry.requestId !== requestId);
    this.queueCredentials.delete(this.queueKey(state, requestId));
  }

  async failQueuedTurn(ownerId, state, entry, error) {
    return this.lock(`owner:${ownerId}`, async () => {
      if (!(state.queuedTurns || []).includes(entry) || !this.store.states.has(state.workspace.id)) return false;
      const request = state.requests[entry.requestId];
      const capacityBlocked = ['active_limit', 'environment_limit', 'environment_busy', 'queue_preempted'].includes(error.code);
      if (request && ['accepted', 'uncertain'].includes(request.status)) {
        this.clearQueuedTurn(state, entry.requestId);
      } else {
        entry.status = capacityBlocked ? 'queued' : 'paused';
        entry.error = this.sanitize(error.message || 'Queued message could not start. Resume the queue to retry.');
        if (request?.status === 'failed' && !request.sent) delete state.requests[entry.requestId];
        else if (request) entry.error = 'The previous start result is unknown. Check the conversation, then cancel this queued message before sending again.';
      }
      this.store.record(state, 'workbench/queue/updated', {});
      await this.store.persist(state);
      return capacityBlocked;
    });
  }

  processQueue(ownerId) {
    if (this.queueDrains.has(ownerId)) {
      const pending = this.queueDrains.get(ownerId);
      return pending.then(() => this.queueDrains.has(ownerId) && this.queueDrains.get(ownerId) !== pending ? this.processQueue(ownerId) : undefined);
    }
    let capacityBlocked = false;
    const task = Promise.resolve().then(async () => {
      while (!this.closing) {
        await this.locks.get(`owner:${ownerId}`)?.catch(() => {});
        if (this.queuePriorities.has(ownerId)) return;
        const next = this.ownerWorkspaces(ownerId).filter((state) => !ACTIVE_STATUSES.has(state.workspace.status) && !this.interruptions.has(sessionKey(state))).flatMap((state) => (state.queuedTurns || []).filter((entry) => entry.status === 'queued').map((entry) => ({ state, entry }))).sort((a, b) => a.entry.sequence - b.entry.sequence)[0];
        if (!next) return;
        const { state, entry } = next, key = this.queueKey(state, entry.requestId);
        const authorization = this.queueCredentials.get(key);
        try {
          if (!this.queueCredentials.has(key)) throw apiError(409, 'queue_authorization_required', 'Queued message needs authorization. Resume the queue to continue.');
          if (authorization?.token) {
            let expires;
            try { expires = JSON.parse(Buffer.from(authorization.token.split('.')[1], 'base64url').toString('utf8')).exp; } catch {}
            if (typeof expires === 'number' && expires * 1000 <= Date.now()) throw apiError(401, 'queue_authorization_expired', 'Queued message authorization expired. Resume the queue to authorize again.');
          }
          await this.turn(ownerId, state.workspace.id, entry, authorization, state.conversation.id, 'queued');
        } catch (error) {
          capacityBlocked = await this.failQueuedTurn(ownerId, state, entry, error);
          if (capacityBlocked) return;
        }
      }
    }).finally(() => {
      if (this.queueDrains.get(ownerId) === task) this.queueDrains.delete(ownerId);
      if (!capacityBlocked && !this.closing && !this.queuePriorities.has(ownerId) && this.ownerWorkspaces(ownerId).some((state) => !ACTIVE_STATUSES.has(state.workspace.status) && !this.interruptions.has(sessionKey(state)) && state.queuedTurns?.some((entry) => entry.status === 'queued'))) this.processQueue(ownerId).catch(() => {});
    });
    this.queueDrains.set(ownerId, task);
    return task.then(() => this.queueDrains.has(ownerId) ? this.processQueue(ownerId) : undefined);
  }

  async cancelQueuedTurn(ownerId, id, requestId, conversationId) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id, conversationId);
      const entry = state.queuedTurns?.find((value) => value.requestId === requestId);
      if (!entry) {
        if (state.requests[requestId]?.code === 'request_cancelled') return { cancelled: true, requestId, workspace: this.store.publicWorkspace(state), queuedTurns: this.store.queuedTurns(state) };
        throw apiError(404, 'queue_not_found', 'Queued message not found');
      }
      if (state.requests[requestId] && state.requests[requestId].status !== 'failed' && ACTIVE_STATUSES.has(state.workspace.status)) throw apiError(409, 'queue_already_started', 'Message has started. Stop the current task instead.');
      this.clearQueuedTurn(state, requestId);
      state.requests[requestId] = { fingerprint: entry.fingerprint, status: 'failed', code: 'request_cancelled', statusCode: 409, message: 'This queued request was cancelled', createdAt: entry.createdAt, turnId: null };
      this.store.record(state, 'workbench/queue/updated', {});
      await this.store.persist(state);
      return { cancelled: true, requestId, workspace: this.store.publicWorkspace(state), queuedTurns: this.store.queuedTurns(state) };
    });
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
    const cleanupFailed = [...this.pendingSessionCleanup].some((id) => this.store.states.get(sessionProjectId(id))?.workspace.ownerId === ownerId && !this.sessionClosures.has(id));
    const lastError = info.status === 'error' ? '用户环境暂不可用，请稍后重试或检查运行服务。' : cleanupFailed ? '项目进程未能完全停止，请停止用户环境后重试。' : this.environmentErrors.get(ownerId);
    return { environment: {
      status: operation || (lastError ? 'error' : info.status),
      mode: info.mode === 'ask' ? 'ask' : 'code',
      activeWorkspaceId: active?.workspace.id || null,
      activeWorkspaceName: active?.workspace.name || null,
      projectCount: [...this.store.states.values()].filter((state) => state.workspace.ownerId === ownerId).length,
      activeConversationId: active?.conversation.id || null,
      activeTasks: this.ownerWorkspaces(ownerId).filter((state) => ACTIVE_STATUSES.has(state.workspace.status)).map((state) => ({ workspaceId: state.workspace.id, conversationId: state.conversation.id, status: state.workspace.status })),
      idleSeconds: this.policy(ownerId).idleSeconds || this.config.idleSeconds,
      runtime:info.runtime,network:info.network,persistentStorage:info.persistentStorage,filesystemIsolation:info.filesystemIsolation,
      limits: { cpus: info.cpu || this.runtime.cpuQuota || 0.1, cpuPercent: info.cpuPercent || this.runtime.cpuPercent || 5, memoryBytes: info.memoryBytes || this.runtime.memoryBytes || 256 * 1024 ** 2, diskBytes: info.diskLimitBytes || this.runtime.workspaceBytes || 2 * 1024 ** 3 },
      ...(lastError ? { lastError } : {}),
    } };
  }

  async closeOwnerSessions(ownerId, exceptId = null) {
    const ids = new Set([...this.sessions.keys(), ...this.sessionClosures.keys(), ...this.pendingSessionCleanup]);
    for (const id of ids) {
      if (this.store.states.get(sessionProjectId(id))?.workspace.ownerId !== ownerId) continue;
      if (id === exceptId && !this.pendingSessionCleanup.has(id)) await this.sessionClosures.get(id);
      else await this.stopSession(id);
    }
  }

  async ensureEnvironment(ownerId, mode) {
    this.requireExecution(ownerId, false);
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
        await this.runtime.startUser(ownerId, { mode: 'code' });
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
        if (this.store.states.get(sessionProjectId(id))?.workspace.ownerId === ownerId) await this.stopSession(id);
      }
      const info = await this.runtime.environment(ownerId);
      await this.ensureEnvironment(ownerId, info.mode === 'ask' ? 'ask' : 'code');
      return this.environment(ownerId);
    });
  }

  async stopOwnerEnvironment(ownerId) {
    const ids = new Set([...this.sessions.keys(), ...this.sessionClosures.keys(), ...this.pendingSessionCleanup]);
    const owned = [...ids].filter((id) => this.store.states.get(sessionProjectId(id))?.workspace.ownerId === ownerId);
    // Stopping the whole user environment is also the recovery path for a
    // failed per-project cleanup. Wait for all attempts, then stop the container.
    await Promise.allSettled(owned.map((id) => this.stopSession(id)));
    await this.lock('environment-capacity', async () => {
      await this.runtime.stopUser(ownerId);
      for (const id of owned) this.pendingSessionCleanup.delete(id);
      this.runningOwners.delete(ownerId);
      this.environmentErrors.delete(ownerId);
    });
    for (const owner of new Set(this.store.allStates().filter((state) => state.queuedTurns?.some((entry) => entry.status === 'queued')).map((state) => state.workspace.ownerId))) this.processQueue(owner).catch(() => {});
  }

  async stopEnvironment(ownerId) {
    // Fail promptly during a long turn/start instead of queueing a stop that
    // could surprise the user after a later task has already started.
    this.requireOwnerIdle(ownerId);
    return this.lock(`owner:${ownerId}`, async () => {
      this.requireOwnerIdle(ownerId);
      for (const state of this.ownerWorkspaces(ownerId)) {
        for (const queued of state.queuedTurns || []) { queued.status = 'paused'; queued.error = 'The environment is asleep. Your queued message was preserved. Resume the queue to continue.'; }
        if (state.queuedTurns?.length) { this.store.record(state, 'workbench/queue/updated', {}); await this.store.persist(state); }
      }
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
      models: this.config.models.map((model) => {
        const native = modelCapabilities.models[model];
        return { id: model, name: native?.name || model, efforts: this.config.efforts.filter((effort) => !native || native.efforts.includes(effort)), defaultEffort: native?.defaultEffort || this.config.defaultEffort };
      }),
      defaultModel: this.config.defaultModel,
      efforts: this.config.efforts,
      defaultEffort: this.config.defaultEffort,
      limits: { maxActive: this.config.maxActive, maxWorkspaces: this.config.maxWorkspaces, uploadBytes: 25 * 1024 * 1024, fileBytes: 1024 * 1024 },
      capabilities: { ssh: Boolean(this.runtime.remote), gitImport: true, zipImport: true, files: true, diff: true, approvals: true, userEnvironment: true },
    };
  }

  sshConnections() {
    if (!this.runtime.remote) throw apiError(503, 'ssh_unavailable', 'SSH remote development is unavailable');
    return this.runtime.remote.connections;
  }

  async createSshConnection(ownerId, body) {
    return this.lock(`owner:${ownerId}`, async () => {
      this.requireOwnerIdle(ownerId);
      return { connection: await this.sshConnections().create(ownerId, body) };
    });
  }

  async deleteSshConnection(ownerId, connectionId) {
    return this.lock(`owner:${ownerId}`, async () => {
      this.requireOwnerIdle(ownerId);
      if (this.ownerWorkspaces(ownerId).some((state) => state.workspace.remote?.connectionId === connectionId)) throw apiError(409, 'ssh_connection_in_use', 'This SSH connection is used by a project. Delete its workbench projects first; remote files will be preserved.');
      await this.sshConnections().remove(ownerId, connectionId);
      return { deleted: true };
    });
  }

  async create(ownerId, body) {
    this.requireExecution(ownerId, Boolean(body.remote), Boolean(body.host));
    return this.lock(`owner:${ownerId}`, async () => {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) throw apiError(400, 'invalid_name', 'Workspace name must contain 1 to 120 characters');
      if (this.store.list(ownerId).length >= (this.policy(ownerId).maxProjects || this.config.maxWorkspaces)) throw apiError(409, 'workspace_limit', 'Workspace limit reached');
      if (body.repositoryUrl !== undefined && typeof body.repositoryUrl !== 'string') throw apiError(400, 'invalid_repository', 'Invalid repository URL');
      let host;
      if (body.host !== undefined) {
        if (body.remote !== undefined || !body.host || typeof body.host !== 'object' || Array.isArray(body.host) || Object.keys(body.host).some(key => key !== 'path')) throw apiError(400, 'invalid_host', 'Specify a host project directory');
        host = { path: body.host.path };
      }
      let remote;
      if (body.remote !== undefined) {
        if (!this.runtime.remote || !body.remote || typeof body.remote !== 'object' || Array.isArray(body.remote)) throw apiError(400, 'invalid_remote', 'Invalid SSH project connection');
        const connection = await this.runtime.remote.connections.get(ownerId, body.remote.connectionId);
        remote = { connectionId: connection.id, path: body.remote.path, host: connection.host, username: connection.username };
      }
      const state = this.store.create(ownerId, { name, model: this.policy(ownerId).defaultModel || this.config.defaultModel, effort: this.policy(ownerId).defaultEffort || this.config.defaultEffort, mode: host ? 'full-access' : 'code', remote, host });
      try {
        this.runtime.registerWorkspace(state.workspace.id, ownerId, remote, host);
        await this.files.create(state.workspace.id, ownerId);
        if (body.repositoryUrl) {
          if (!remote && !host) await this.ensureEnvironment(ownerId, 'code');
          await this.files.clone(state.workspace.id, body.repositoryUrl, body.branch);
          state.workspace.repositoryUrl = body.repositoryUrl;
          if (body.branch) state.workspace.branch = body.branch;
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
        if (body.archived && this.store.projectStates(state).some((entry) => entry.queuedTurns?.length)) throw apiError(409, 'conversation_queue_pending', 'Cancel queued messages before archiving this project.');
      }
      if ('name' in body) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) throw apiError(400, 'invalid_name', 'Workspace name must contain 1 to 120 characters');
        state.workspace.name = body.name.trim();
      }
      if ('archived' in body) {
        state.workspace.archived = body.archived;
      }
      for (const entry of this.store.projectStates(state)) { entry.workspace.name = state.workspace.name; entry.workspace.archived = state.workspace.archived; }
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
      await this.cloud.removeWorkspaceBinding(ownerId,id);
      await this.files.remove(id);
      for (const entry of this.store.projectStates(state)) for (const queued of entry.queuedTurns || []) this.queueCredentials.delete(this.queueKey(entry, queued.requestId));
      await this.store.delete(state);
      this.runtime.unregisterWorkspace(id);
      this.touchOwner(ownerId);
      return { deleted: true };
    });
  }

  async createConversation(ownerId, id, body) {
    return this.lock(`owner:${ownerId}`, async () => {
      const project = this.store.get(ownerId, id);
      if (project.workspace.archived) throw apiError(409, 'workspace_archived', 'Restore the project before creating a conversation');
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120)) throw apiError(400, 'invalid_name', 'Conversation name must contain 1 to 120 characters');
      const state = this.store.createConversation(project, body.name?.trim());
      this.store.record(state, 'workbench/conversation/created', {});
      await this.store.persist(state);
      return this.store.detail(state);
    });
  }

  async renameConversation(ownerId, id, conversationId, body) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id, conversationId);
      if (!('name' in body) && !('archived' in body)) throw apiError(400, 'invalid_conversation_update', 'A conversation name or archive state is required');
      if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120)) throw apiError(400, 'invalid_name', 'Conversation name must contain 1 to 120 characters');
      if ('archived' in body) {
        if (typeof body.archived !== 'boolean') throw apiError(400, 'invalid_archive', 'Invalid archive state');
        this.requireIdle(state);
        if (this.interruptions.has(sessionKey(state))) throw apiError(409, 'workspace_busy', 'The workspace is stopping a task');
        if (body.archived && state.queuedTurns?.length) throw apiError(409, 'conversation_queue_pending', 'Cancel queued messages before archiving this conversation.');
      }
      if ('name' in body) {
        state.conversation.name = body.name.trim();
        state.conversation.customName = true;
      }
      if ('archived' in body) state.conversation.archived = body.archived;
      this.store.record(state, 'workbench/conversation/updated', { name: state.conversation.name, archived: state.conversation.archived === true });
      await this.store.persist(state);
      return this.store.detail(state);
    });
  }

  async deleteConversation(ownerId, id, conversationId) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id, conversationId);
      this.requireIdle(state);
      if (this.interruptions.has(sessionKey(state))) throw apiError(409, 'workspace_busy', 'The workspace is stopping a task');
      const key = sessionKey(state);
      const session = this.sessions.get(key);
      if (session || this.pendingSessionCleanup.has(key)) await this.stopSession(key);
      for (const queued of state.queuedTurns || []) this.queueCredentials.delete(this.queueKey(state, queued.requestId));
      const replacement = this.store.deleteConversation(state);
      this.store.record(replacement, 'workbench/conversation/deleted', { conversationId });
      await this.store.persist(replacement);
      return { deleted: true, conversationId: replacement.conversation.id, workspace: this.store.publicWorkspace(replacement), conversations: this.store.conversations(replacement) };
    });
  }

  async deleteMessage(ownerId, id, turnId, role, conversationId) {
    if (!['user', 'assistant'].includes(role)) throw apiError(400, 'invalid_message', 'Invalid message role');
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id, conversationId);
      this.requireOwnerIdle(ownerId);
      const turn = state.thread?.turns?.find((entry) => entry.id === turnId);
      if (!turn) throw apiError(404, 'message_not_found', 'Message not found');
      const roles = new Set(turn.deletedRoles || []);
      roles.add(role);
      turn.deletedRoles = [...roles];
      state.messageDeletions ||= {};
      state.messageDeletions[turnId] = turn.deletedRoles;
      this.store.record(state, 'workbench/message/deleted', { turnId, role });
      await this.store.persist(state);
      return this.store.detail(state);
    });
  }

  async ensureSession(state) {
    const id = state.workspace.id, key = sessionKey(state);
    if (!this.status().configured) throw apiError(503, 'not_configured', this.status().reason);
    // Finish cleanup for this conversation before reusing its process identity.
    await this.sessionClosures.get(key);
    if (this.pendingSessionCleanup.has(key)) await this.stopSession(key);
    let existing = this.sessions.get(key);
    const remote = Boolean(state.workspace.remote), host = Boolean(state.workspace.host);
    this.requireExecution(state.workspace.ownerId, remote, host);
    const info = remote || host ? { status: 'running' } : await this.runtime.environment(state.workspace.ownerId);
    const authorization = this.modelCredentials.get(key);
    if (existing && (existing.rpc.closed || existing.conversationId !== state.conversation.id || existing.mode !== state.workspace.mode || existing.modelCredential !== authorization?.token || existing.cloudRevision !== this.cloud.workspaceRevision(state.workspace.ownerId,id) || info.status !== 'running')) {
      await this.stopSession(key);
      existing = null;
    }
    this.starting.add(key);
    try {
      if (!remote && !host) await this.ensureEnvironment(state.workspace.ownerId, state.workspace.mode);
      if (host && this.accountTools.credentials.has(state.workspace.ownerId)) {
        const catalog = await this.accountTools.catalog(state.workspace.ownerId);
        if (catalog.data.allowHost !== true) throw apiError(403, 'host_admin_required', 'Host execution is available only to current administrators');
      }
      if (existing) { existing.lastUsed = Date.now(); return existing; }
      await this.runtime.baseline?.(id);
      const policy = executionPolicy(state.workspace.mode, remote, host);
      const child = await this.runtime.spawnAppServer(id, { processId: state.conversation.id, env: { NEW_API_KEY: authorization?.token || this.config.apiKey, NEW_API_BASE_URL: this.config.apiBaseUrl, ...this.githubEnvironment(state.workspace.ownerId) }, mode: policy.mountMode, workspaceEnvironment:this.cloud.workspaceEnvironment(state.workspace.ownerId,id) });
      const rpc = new CodexRpc(child, { timeoutMs: this.config.rpcTimeoutMs || 60_000 });
      const session = { toolAbort: new AbortController(), cloudRevision:this.cloud.workspaceRevision(state.workspace.ownerId,id), rpc, state, conversationId: state.conversation.id, lastUsed: Date.now(), intentionalClose: false, mode: state.workspace.mode, modelCredential: authorization?.token };
      this.sessions.set(key, session);
      rpc.on('message', (message) => this.onMessage(state, session, message));
      rpc.on('closed', (error) => {
        if (this.sessions.get(key) === session) this.sessions.delete(key);
        if (session.intentionalClose) return;
        // A detached docker-exec client can leave the actual worker alive. Start
        // cleanup synchronously so the next task waits before reusing this ID.
        this.stopSession(key, session).catch(() => {});
        if (ACTIVE_STATUSES.has(state.workspace.status)) {
          const turn = state.thread?.turns?.find((value) => value.id === state.workspace.activeTurnId);
          if (turn) turn.status = 'interrupted';
          state.workspace.status = 'interrupted';
          state.workspace.activeTurnId = null;
          state.workspace.lastError = this.sanitize(error.message);
          state.pendingApprovals = [];
          this.store.record(state, 'workbench/interrupted', { reason: 'runtime_stopped', message: state.workspace.lastError });
          this.store.persist(state).catch(() => {});
          this.processQueue(state.workspace.ownerId).catch(() => {});
        }
      });
      await rpc.initialize();
      const sandbox = policy.sandbox;
      const cwd = this.runtime.cwd(id);
      const params = { cwd, model: state.workspace.model, modelProvider: 'newapi', approvalPolicy: policy.approvalPolicy, sandbox, developerInstructions: remote ? (state.workspace.mode === 'ask' ? `This is an SSH remote project in Ask mode at ${cwd}. Inspect files and answer questions without modifying files or bypassing the read-only sandbox.` : `This is an SSH remote project at ${cwd}. Changes and commands run directly on the administrator-authorized remote server. Work only inside this project unless explicitly requested; do not modify unrelated server files or the workbench control directory.`) : state.workspace.mode === 'ask' ? 'This conversation is in read-only mode. Inspect files and answer questions without modifying files or bypassing the read-only project mount.' : `This workspace is in Code mode. Work in ${cwd} and implement the administrator’s requested changes. Other projects belonging to this user share the same environment; modify only this project unless explicitly requested.` };
      if (state.workspace.mode === 'full-access') params.developerInstructions = `This task has full access to the ${host ? 'administrator-authorized host' : remote ? 'authorized SSH account' : 'user Docker environment'}. Implement the user's request using the available files, commands, and network without requesting command or file-change approval. Ask the user when essential task information is missing.`;
      if (host && state.workspace.mode !== 'full-access') params.developerInstructions = `This is an administrator-authorized host project at ${cwd}. Commands run directly on the host. Respect the selected approval policy and read-only mode when selected. Implement the user's request and preserve unrelated server services.`;
      const instructions=this.cloud.workspaceInstructions(state.workspace.ownerId,id);
      if(instructions) params.developerInstructions += `\nEnvironment start instructions:\n${instructions}`;
      if (this.accountTools.credentials.has(state.workspace.ownerId) && !state.workspace.threadId) params.dynamicTools = [...accountDynamicTools, ...(this.ports.enabled ? portDynamicTools : [])];
      params.developerInstructions += '\nUse newapi_list_tools and newapi_call_tool when available to manage the current user’s New API account. Read the discovered schema first. Only change settings the user requested; browser interaction links require the user to finish that existing flow.';
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
      for (const turn of savedTurns) { if (state.messageDeletions?.[turn.id]) turn.deletedRoles = state.messageDeletions[turn.id]; }
      state.thread = { ...resumedThread, turns: savedTurns };
      state.workspace.threadId = result.thread.id;
      if ((state.historyBytes || 0) === 0) state.historyBytes = Buffer.byteLength(JSON.stringify(state.thread));
      await this.store.persist(state);
      return session;
    } catch (error) {
      await this.stopSession(key).catch(() => {});
      throw error;
    } finally { this.starting.delete(key); }
  }

  onMessage(state, session, rawMessage) {
    if (session.intentionalClose || this.sessions.get(sessionKey(state)) !== session || session.historyLimitReached) return;
    if ('id' in rawMessage && rawMessage.method === 'item/tool/call') {
      const handler = this.portTools.accepts(rawMessage.params?.tool) ? this.portTools : this.accountTools;
      handler.handle(state, session, rawMessage).catch(() => {});
      return;
    }
    if (['item/started', 'item/completed'].includes(rawMessage.method) && rawMessage.params?.item?.type === 'dynamicToolCall') {
      rawMessage = { ...rawMessage, params: { ...rawMessage.params, item: { ...rawMessage.params.item, arguments: '[omitted]' } } };
    }
    if (rawMessage.method === 'thread/started' && rawMessage.params?.thread?.id === session.forkedThreadId) return;
    // A fork may emit thread/started before its RPC reply. Defer notifications
    // until its durable conversation identity is selected, so the new root is
    // never mistaken for a subagent of the preserved original branch.
    if (session.branchNotifications) { session.branchNotifications.push(rawMessage); return; }
    if (typeof rawMessage.params?.delta === 'string') {
      const stream = `${sessionKey(state)}:${rawMessage.method}:${rawMessage.params.threadId || ''}:${rawMessage.params.turnId || ''}:${rawMessage.params.itemId || ''}:${rawMessage.params.summaryIndex || 0}`;
      rawMessage = { ...rawMessage, params: { ...rawMessage.params, delta: this.githubCredentials.sanitizeDelta(stream, rawMessage.params.delta, rawMessage) } };
    }
    if (['item/completed', 'turn/completed'].includes(rawMessage.method)) {
      for (const pending of this.githubCredentials.flushDeltaStreams(sessionKey(state), rawMessage.method === 'item/completed' ? rawMessage.params?.item?.id : undefined)) {
        const safePending = this.sanitize(pending);
        this.store.record(state, safePending.method, safePending.params);
      }
    }
    const message = this.sanitize(rawMessage);
    state.historyBytes = (state.historyBytes || 0) + Buffer.byteLength(JSON.stringify(message));
    if (this.store.projectStates(this.store.root(state)).reduce((sum, entry) => sum + (entry.historyBytes || 0), 0) > (this.config.historyBytes || 64 * 1024 * 1024)) {
      session.historyLimitReached = true;
      state.workspace.status = 'error';
      state.workspace.activeTurnId = null;
      state.workspace.lastError = '工作区会话已达到历史容量上限。已保留收到的内容，请导出项目并创建新工作区。';
      state.pendingApprovals = [];
      this.store.record(state, 'workbench/error', { code: 'history_limit', message: state.workspace.lastError });
      this.stopSession(sessionKey(state)).catch(() => {});
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
      if (['auto', 'full-access'].includes(state.workspace.mode) && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(message.method)) {
        const result = message.method === 'item/permissions/requestApproval'
          ? { permissions: rawMessage.params?.permissions || {}, scope: 'turn' }
          : { decision: 'accept' };
        session.rpc.respond(rawMessage.id, result);
        this.store.record(state, 'workbench/approval/autoApproved', { method: message.method, params });
        this.store.persist(state).catch(() => {});
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
    if (message.method === 'turn/started') {
      for (const queued of state.queuedTurns || []) if (state.requests[queued.requestId]?.status === 'accepted') this.clearQueuedTurn(state, queued.requestId);
    }
    if (['turn/started', 'turn/completed', 'serverRequest/resolved'].includes(message.method)) this.store.persist(state).catch(() => {});
    if (message.method === 'turn/completed') {
      for (const owner of new Set(this.store.allStates().filter((entry) => entry.queuedTurns?.length).map((entry) => entry.workspace.ownerId))) this.processQueue(owner).catch(() => {});
    }
  }

  validateTurn(body, authorization = null) {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 100_000) throw apiError(400, 'invalid_prompt', 'Prompt must contain 1 to 100000 characters');
    if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) throw apiError(400, 'invalid_request_id', 'A UUID requestId is required');
    const model = body.model || authorization?.model || this.config.defaultModel;
    const group = body.group || authorization?.group || '';
    const effort = body.effort || this.config.defaultEffort;
    const mode = body.mode || 'code';
    if (authorization ? authorization.model !== model || authorization.group !== group : !this.config.models.includes(model) || group) throw apiError(400, 'invalid_model', 'Model is not authorized for this workbench');
    if (!this.config.efforts.includes(effort) || modelCapabilities.models[model] && !modelCapabilities.models[model].efforts.includes(effort)) throw apiError(400, 'invalid_effort', 'Unsupported reasoning effort for this model');
    executionPolicy(mode);
    return { prompt, model, effort, mode, group, requestId: body.requestId };
  }

  async turn(ownerId, id, body, authorization = null, conversationId, queuedExecution = null) {
    this.requireExecution(ownerId,Boolean(this.store.get(ownerId,id).workspace.remote),Boolean(this.store.get(ownerId,id).workspace.host));
    const input = this.validateTurn(body, authorization);
    const replayTurnId = body.replayTurnId;
    if (replayTurnId !== undefined && (typeof replayTurnId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(replayTurnId))) throw apiError(400, 'invalid_turn', 'Invalid task turn');
    if (body.busyAction !== undefined && !['queue', 'interrupt'].includes(body.busyAction)) throw apiError(400, 'invalid_busy_action', 'Choose queue or interrupt for a busy conversation');
    if (body.busyAction && replayTurnId) throw apiError(400, 'invalid_queue', 'Conversation replay cannot be queued or interrupt another task');
    const fingerprint = createHash('sha256').update(JSON.stringify({ prompt: input.prompt, model: input.model, effort: input.effort, mode: input.mode, ...(input.group ? { group: input.group } : {}), ...(replayTurnId ? { replayTurnId } : {}) })).digest('hex');
    if (body.busyAction === 'interrupt' && !queuedExecution) {
      const state = this.store.get(ownerId, id, conversationId);
      const previous = state.requests[input.requestId], queued = state.queuedTurns?.find((entry) => entry.requestId === input.requestId);
      if (previous || queued) {
        if ((previous || queued).fingerprint !== fingerprint) throw apiError(409, 'idempotency_conflict', 'This request ID was already used for different input');
        if (previous) return this.turn(ownerId, id, { ...body, busyAction: undefined }, authorization, conversationId);
      }
      if (state.workspace.archived || state.conversation.archived) throw apiError(409, 'conversation_archived', 'Restore the project and conversation before starting a task');
      this.queuePriorities.set(ownerId, (this.queuePriorities.get(ownerId) || 0) + 1);
      try {
        if (ACTIVE_STATUSES.has(state.workspace.status) || this.interruptions.has(sessionKey(state))) await this.interrupt(ownerId, id, state.conversation.id);
        return await this.turn(ownerId, id, { ...body, busyAction: undefined }, authorization, conversationId, 'priority');
      } catch (error) {
        if (queued) await this.failQueuedTurn(ownerId, state, queued, error);
        throw error;
      } finally {
        const priorities = this.queuePriorities.get(ownerId) - 1;
        if (priorities) this.queuePriorities.set(ownerId, priorities); else this.queuePriorities.delete(ownerId);
        this.processQueue(ownerId).catch(() => {});
      }
    }
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id, conversationId);
      if (queuedExecution === 'queued' && this.queuePriorities.has(ownerId)) throw apiError(409, 'queue_preempted', 'Priority message is starting. Your queued message will follow.');
      const queued = state.queuedTurns?.find((entry) => entry.requestId === input.requestId);
      if (queued && queued.fingerprint !== fingerprint) throw apiError(409, 'idempotency_conflict', 'This request ID was already used for different input');
      const previous = state.requests[input.requestId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw apiError(409, 'idempotency_conflict', 'This request ID was already used for different input');
        if (previous.status === 'failed') {
          // The browser keeps this ID with its draft. Initialization can be
          // retried after fixing the environment only when no task was sent.
          if (previous.code !== 'remote_operation_failed' || previous.sent || previous.turnId || replayTurnId) throw apiError(previous.statusCode || 409, previous.code || 'task_not_started', previous.message || 'The prior request failed; create a new request to retry');
        } else {
          if (queued && queuedExecution) {
            if (previous.status === 'pending') throw apiError(409, 'queue_state_uncertain', 'The previous start result is unknown. Check the conversation, then cancel this queued message before sending again.');
            this.clearQueuedTurn(state, input.requestId);
            await this.store.persist(state);
          }
          return { workspace: this.store.publicWorkspace(state), turnId: previous.turnId || null, duplicate: true };
        }
      }
      if (queued && !queuedExecution || body.busyAction === 'queue') {
        if (state.workspace.archived) throw apiError(409, 'workspace_archived', 'Restore the workspace before starting a task');
        if (state.conversation.archived) throw apiError(409, 'conversation_archived', 'Restore the conversation before starting a task');
        if (Object.keys(state.requests).length >= 10_000) throw apiError(409, 'turn_limit', 'This workspace has reached its task history limit; create another workspace');
        if (!queued && this.ownerWorkspaces(ownerId).reduce((sum, entry) => sum + (entry.queuedTurns?.length || 0), 0) >= 20) throw apiError(409, 'queue_limit', 'Queue is full (20 messages). Cancel a queued message to continue.');
        const entry = queued || { ...input, fingerprint, createdAt: Date.now(), sequence: ++this.queueSequence };
        entry.status = 'queued'; delete entry.error;
        state.queuedTurns ||= [];
        if (!queued) state.queuedTurns.push(entry);
        this.queueCredentials.set(this.queueKey(state, input.requestId), authorization);
        if (authorization) { this.modelSecrets.add(authorization.token); this.githubCredentials.addRedaction(authorization.token); }
        this.store.record(state, 'workbench/queue/updated', {});
        await this.store.persist(state);
        this.processQueue(ownerId).catch(() => {});
        return { workspace: this.store.publicWorkspace(state), queued: true, requestId: input.requestId, turnId: null, ...(queued ? { duplicate: true } : {}) };
      }
      this.requireIdle(state);
      if (this.interruptions.has(sessionKey(state))) throw apiError(409, 'workspace_busy', 'The conversation is stopping a task');
      const replay = replayTurnId ? prepareConversationReplay(this.store, state, replayTurnId, this.config.historyBytes || 64 * 1024 * 1024) : null;
      if (this.store.projectStates(this.store.root(state)).reduce((sum, entry) => sum + (entry.historyBytes || 0), 0) >= (this.config.historyBytes || 64 * 1024 * 1024)) throw apiError(409, 'history_limit', 'Workspace history limit reached; export your project and create another workspace');
      if (state.workspace.archived) throw apiError(409, 'workspace_archived', 'Restore the workspace before starting a task');
      if (state.conversation.archived) throw apiError(409, 'conversation_archived', 'Restore the conversation before starting a task');
      if (Object.keys(state.requests).length >= 10_000) throw apiError(409, 'turn_limit', 'This workspace has reached its task history limit; create another workspace');
      const active = this.store.allStates().filter((entry) => ACTIVE_STATUSES.has(entry.workspace.status)).length;
      if (active >= this.config.maxActive) throw apiError(429, 'active_limit', 'Too many active Codex tasks; wait for a task to finish');
      state.workspace.model = input.model;
      state.workspace.group = input.group;
      if (authorization) {
        this.modelCredentials.set(sessionKey(state), authorization);
        this.modelSecrets.add(authorization.token);
        this.githubCredentials.addRedaction(authorization.token);
      } else this.modelCredentials.delete(sessionKey(state));
      state.workspace.effort = input.effort;
      state.workspace.mode = input.mode;
      const executionEpoch = (state.executionEpoch || 0) + 1;
      state.executionEpoch = executionEpoch;
      state.workspace.status = 'starting';
      state.workspace.lastError = null;
      state.workspace.preview = input.prompt.slice(0, 180);
      if (!state.conversation.customName && !state.thread?.turns?.length) state.conversation.name = input.prompt.replace(/\s+/g, ' ').slice(0, 80);
      state.requests[input.requestId] = { fingerprint, status: 'pending', createdAt: Date.now(), turnId: null };
      if (queued) queued.status = 'starting';
      this.store.record(state, 'workbench/task/starting', { requestId: input.requestId });
      await this.store.persist(state);
      let sent = false;
      try {
        const session = await this.ensureSession(state);
        if (state.executionEpoch !== executionEpoch) {
          await this.stopSession(sessionKey(state));
          throw apiError(409, 'task_interrupted', 'Task was interrupted before it started');
        }
        if (replay) {
          session.branchNotifications = [];
          try {
            const fork = await session.rpc.request('thread/fork', {
              threadId: replay.source.workspace.threadId, beforeTurnId: replayTurnId,
              excludeTurns: true, deferGoalContinuation: true,
            });
            if (state.executionEpoch !== executionEpoch) throw apiError(409, 'task_interrupted', 'Task was interrupted before it started');
            session.forkedThreadId = fork?.thread?.id;
            const original = await persistConversationReplay(this.store, state, replay, this.sanitize(fork?.thread || null));
            state.requests[input.requestId].originalConversationId = original.conversation.id;
          } finally {
            const notifications = session.branchNotifications;
            delete session.branchNotifications;
            for (const message of notifications) {
              const threadId = message.params?.threadId || message.params?.thread?.id;
              if (threadId && threadId !== state.workspace.threadId) continue;
              // The fork response and our saved full item prefix are already
              // authoritative. A summary-only started event must not erase it.
              if (message.method !== 'thread/started') this.onMessage(state, session, message);
            }
          }
        }
        if (state.executionEpoch !== executionEpoch) {
          await this.stopSession(sessionKey(state));
          throw apiError(409, 'task_interrupted', 'Task was interrupted before it started');
        }
        sent = true;
        state.requests[input.requestId].sent = true;
        const result = await session.rpc.request('turn/start', {
          threadId: state.workspace.threadId,
          input: [{ type: 'text', text: input.prompt }],
          model: input.model, effort: input.effort, cwd: this.runtime.cwd(id),
          approvalPolicy: executionPolicy(input.mode).approvalPolicy,
          sandboxPolicy: executionPolicy(input.mode, Boolean(state.workspace.remote), Boolean(state.workspace.host)).sandboxPolicy,
        });
        const record = state.requests[input.requestId];
        record.status = 'accepted';
        record.turnId = result?.turn?.id || record.turnId;
        if (queued) this.clearQueuedTurn(state, input.requestId);
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

  async interrupt(ownerId, id, conversationId) {
    // Never queue behind turn/start; it may be waiting on a slow provider.
    const state = this.store.get(ownerId, id, conversationId);
    const key = sessionKey(state);
    const pending = this.interruptions.get(key);
    if (pending) return pending;
    const session = this.sessions.get(sessionKey(state));
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
      try { await this.stopSession(key, session); }
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
    this.interruptions.set(key, task);
    try { return await task; }
    finally {
      if (this.interruptions.get(key) === task) this.interruptions.delete(key);
      this.processQueue(ownerId).catch(() => {});
    }
  }

  async approve(ownerId, id, approvalId, body, conversationId) {
    const state = this.store.get(ownerId, id, conversationId);
    const approval = state.pendingApprovals.find((entry) => entry.id === approvalId);
    if (!approval) throw apiError(409, 'approval_expired', 'The approval request is no longer pending');
    const session = this.sessions.get(sessionKey(state));
    if (!session || session.rpc.closed || session.conversationId !== state.conversation.id) throw apiError(409, 'approval_expired', 'The Codex session is no longer connected');
    let result;
    if (['workbench/newapi/approval', 'workbench/ports/approval'].includes(approval.method)) {
      if (!['accept', 'decline'].includes(body.decision)) throw apiError(400, 'invalid_decision', 'Decision must be accept or decline');
      if (approval.method === 'workbench/ports/approval' && body.decision === 'accept' && state.workspace.mode === 'ask') throw apiError(403, 'read_only', 'Public ports cannot be changed in read-only mode');
      const handler = approval.method === 'workbench/ports/approval' ? this.portTools : this.accountTools;
      const value = body.decision === 'accept'
        ? await handler.execute(ownerId, approval.params.name, approval.params.arguments, session.toolAbort.signal)
        : { success: false, message: 'The user declined this change' };
      result = { success: value.success === true, contentItems: [{ type: 'inputText', text: JSON.stringify(this.sanitize(value)) }] };
    } else if (approval.method === 'item/tool/requestUserInput') {
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
        if (!state.workspace.remote && !state.workspace.host) await this.ensureEnvironment(ownerId, state.workspace.mode);
      }
      const result = await this.files.diff(id);
      this.touchOwner(ownerId);
      return result;
    });
  }

  async repository(ownerId, id) {
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      const active = this.activeWorkspace(ownerId);
      if (!state.workspace.remote && !state.workspace.host && (!active || active.workspace.id !== id)) {
        const info = await this.runtime.environment(ownerId);
        if (info.status !== 'running') {
          this.requireOwnerIdle(ownerId);
          await this.ensureEnvironment(ownerId, state.workspace.mode);
        }
      }
      const repository = await workspaceRepository(this.runtime, id);
      for (const entry of this.store.projectStates(this.store.root(state))) {
        entry.workspace.branch = repository.branch;
        entry.workspace.repositoryUrl = repository.remotes.find((remote) => remote.name === 'origin')?.url || repository.remotes.find((remote) => remote.url)?.url || null;
      }
      await this.store.persist(state);
      return { repository };
    });
  }

  async checkoutBranch(ownerId, id, body) {
    if (!body || typeof body !== 'object' || typeof body.branch !== 'string' || !body.branch || body.branch.length > 200 || body.remote !== undefined && (typeof body.remote !== 'string' || !body.remote || body.remote.length > 200)) {
      throw apiError(400, 'invalid_branch', 'Choose a valid repository branch');
    }
    this.requireOwnerIdle(ownerId);
    return this.lock(`owner:${ownerId}`, async () => {
      const state = this.store.get(ownerId, id);
      this.requireOwnerIdle(ownerId);
      if (state.workspace.archived) throw apiError(409, 'workspace_archived', 'Restore the project before switching branches');
      if (this.ownerWorkspaces(ownerId).some((entry) => entry.queuedTurns?.length)) throw apiError(409, 'repository_queue_pending', 'Cancel queued messages before switching project branches');
      await this.closeOwnerSessions(ownerId);
      if (!state.workspace.remote && !state.workspace.host) await this.ensureEnvironment(ownerId, 'code');
      const repository = await workspaceRepository(this.runtime, id, 'checkout', { branch: body.branch, ...(body.remote ? { remote: body.remote } : {}) });
      const project = this.store.root(state);
      for (const entry of this.store.projectStates(project)) {
        entry.workspace.branch = repository.branch;
        entry.workspace.repositoryUrl = repository.remotes.find((remote) => remote.name === 'origin')?.url || repository.remotes.find((remote) => remote.url)?.url || null;
      }
      this.touchOwner(ownerId);
      this.store.record(state, 'workbench/repository/updated', { repository });
      await this.store.persist(state);
      return { repository, workspace: this.store.publicWorkspace(state) };
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
    this.githubCredentials.clearDeltaStreams(id);
    const pending = this.sessionClosures.get(id);
    if (pending) return pending;
    const session = current || expectedSession;
    if (session) {
      session.intentionalClose = true;
      session.toolAbort?.abort();
      session.rpc.close();
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    }
    // Reserve cleanup before its first asynchronous step. The next task must
    // await it so a late old-worker stop cannot kill a new project process.
    this.pendingSessionCleanup.add(id);
    const closing = Promise.resolve().then(() => this.runtime.stopAppServer(sessionProjectId(id), { processId: sessionProcessId(id) }));
    this.sessionClosures.set(id, closing);
    try { await closing; this.pendingSessionCleanup.delete(id); }
    finally { if (this.sessionClosures.get(id) === closing) this.sessionClosures.delete(id); }
  }

  async reapIdle() {
    if (this.ports.enabled) await this.ports.lock(() => this.ports.reconcile());
    for (const [id, session] of this.sessions) {
      const state = session.state;
      if ((state?.workspace.remote || state?.workspace.host) && !this.activeWorkspace(state.workspace.ownerId) && !this.locks.has(`owner:${state.workspace.ownerId}`) && Date.now() - session.lastUsed > (this.policy(state.workspace.ownerId).idleSeconds || this.config.idleSeconds) * 1000) await this.stopSession(id);
    }
    for (const [ownerId] of this.runningOwners) {
      // Do not queue a stale idle decision behind a task currently starting.
      if (this.locks.has(`owner:${ownerId}`) || this.ownerWorkspaces(ownerId).some((state) => this.interruptions.has(sessionKey(state)))) continue;
      await this.lock(`owner:${ownerId}`, async () => {
        const state = this.activeWorkspace(ownerId);
        const diskProject = this.ownerWorkspaces(ownerId).find(entry => !entry.workspace.remote && !entry.workspace.host && ACTIVE_STATUSES.has(entry.workspace.status)) || this.ownerWorkspaces(ownerId).find(entry => !entry.workspace.remote && !entry.workspace.host);
        const dockerRunning = !diskProject && (await this.runtime.environment(ownerId)).status === 'running';
        if ((diskProject || dockerRunning) && (this.runtime.enforceUserDiskLimit || this.runtime.enforceDiskLimit)) {
          try {
            if (this.runtime.enforceUserDiskLimit) await this.runtime.enforceUserDiskLimit(ownerId);
            else await this.runtime.enforceDiskLimit(diskProject.workspace.id);
          }
          catch (error) {
            for (const entry of this.ownerWorkspaces(ownerId)) {
              for (const queued of entry.queuedTurns || []) { queued.status = 'paused'; queued.error = this.sanitize(error.message || 'Queued message could not start. Resume the queue to retry.'); }
              if (entry.queuedTurns?.length) { this.store.record(entry, 'workbench/queue/updated', {}); await this.store.persist(entry); }
            }
            await this.stopOwnerEnvironment(ownerId).catch(() => {});
            const message = '用户环境存储超限或空间不足，环境已停止。请整理项目文件后重试。';
            this.environmentErrors.set(ownerId, message);
            for (const entry of this.ownerWorkspaces(ownerId).filter((entry) => ACTIVE_STATUSES.has(entry.workspace.status))) {
              const turn = entry.thread?.turns?.find((value) => value.id === entry.workspace.activeTurnId);
              if (turn) turn.status = 'failed';
              entry.workspace.status = 'error';
              entry.workspace.activeTurnId = null;
              entry.pendingApprovals = [];
              entry.workspace.lastError = this.sanitize(error.message);
              this.store.record(entry, 'workbench/error', { code: error.code, message: entry.workspace.lastError });
              await this.store.persist(entry);
            }
          }
        }
        if (this.runningOwners.has(ownerId) && !this.activeWorkspace(ownerId) && Date.now() - this.runningOwners.get(ownerId) > (this.policy(ownerId).idleSeconds || this.config.idleSeconds) * 1000) await this.stopOwnerEnvironment(ownerId);
      });
    }
    for (const ownerId of new Set(this.store.allStates().filter((state) => state.queuedTurns?.some((entry) => entry.status === 'queued')).map((state) => state.workspace.ownerId))) this.processQueue(ownerId).catch(() => {});
  }

  async close() {
    this.closing = true;
    clearInterval(this.idleTimer);
    await Promise.allSettled(this.queueDrains.values());
    for (const [id, session] of this.sessions) {
      const state = session.state;
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
    await this.ports.close();
    await this.store.close();
  }
}
