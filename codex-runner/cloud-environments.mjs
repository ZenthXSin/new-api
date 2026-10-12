import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES, apiError } from './store.mjs';
import { assertOwnerId, assertWorkspaceId, workspacePaths } from './user-layout.mjs';
import { runCommand } from './workspace-files.mjs';
import { CloudSnapshots } from './cloud-snapshots.mjs';
import { prepareCloudWorkspace } from './cloud-setup.mjs';

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESERVED_ENVIRONMENT = /^(?:HOME|PATH|CODEX_HOME|NEW_API(?:_|$)|CODEX(?:_|$)|GH(?:_|$)|GITHUB(?:_|$)|GIT|DOCKER|LD_|DYLD_|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|CDPATH$|IFS$|NODE_OPTIONS$|NODE_PATH$|PYTHON|RUBY|PERL|XDG|NPM_CONFIG_PREFIX$|NPM_CONFIG_USERCONFIG$|NPM_CONFIG_GLOBALCONFIG$)/i;
const CAPABILITIES = Object.freeze({
  runtime: 'docker',
  internetModes: ['enabled'],
  networkSecrets: false,
  sharingModes: ['private'],
  snapshotScope: 'project_and_user_tools',
  systemPackageInstall: false,
  limits: { maxRepositories: 10, maxEnvironmentVariables: 128 },
  unsupportedReasons: {
    internetAccess: 'This Docker runtime uses its configured managed network; per-environment network restrictions are unavailable.',
    networkSecrets: 'Host-scoped network secret injection is unavailable in this runtime.',
    sharing: 'Environment sharing is unavailable in this runtime.',
    systemPackageInstall: 'The container root filesystem is read-only. Install tools into the environment home or project.',
  },
});

// Only the task tools directory is created, relative to checked descriptors.
// Never create a path through a project-controlled symlink as the host runner.
const ENSURE_TOOLS_HOME = String.raw`
import json,os,stat,sys
r=json.load(sys.stdin)
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
fd=os.open('/',flags)
try:
 for part in r['workspaceHomePath'].split('/'):
  if not part:continue
  child=os.open(part,flags,dir_fd=fd);os.close(fd);fd=child
 uid=1000 if os.geteuid()==0 else os.geteuid()
 if os.fstat(fd).st_uid!=uid:raise ValueError('Unsafe environment tools directory')
 try:os.mkdir('environment-home',0o700,dir_fd=fd)
 except FileExistsError:pass
 target=os.open('environment-home',flags,dir_fd=fd)
 try:
  info=os.fstat(target)
  if info.st_uid not in (uid,os.geteuid()):raise ValueError('Unsafe environment tools directory')
  if os.geteuid()==0:os.fchown(target,1000,1000)
  os.fchmod(target,0o700)
 finally:os.close(target)
 print(json.dumps({'ok':True}))
finally:os.close(fd)
`;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError(400, 'invalid_environment', `${label} must be an object`);
  return value;
}

function text(value, label, maximum, { empty = true, trim = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) throw apiError(400, 'invalid_environment', `${label} must be text`);
  const result = trim ? value.trim() : value;
  if ((!empty && !result) || result.length > maximum) throw apiError(400, 'invalid_environment', `${label} must contain ${empty ? '0' : '1'} to ${maximum} characters`);
  return result;
}

function environmentId(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_ID.test(value)) throw apiError(404, 'environment_not_found', 'Cloud environment not found');
  return value;
}

function normalizeRepositories(value) {
  if (!Array.isArray(value) || value.length > 10) throw apiError(400, 'invalid_repositories', 'Select up to 10 repositories');
  const repositories = value.map((entry) => {
    object(entry, 'Repository');
    let url;
    try { url = new URL(entry.url); } catch { throw apiError(400, 'invalid_repository', 'Use an HTTPS repository URL without credentials'); }
    if (typeof entry.url !== 'string' || entry.url.length > 2048 || /[\x00-\x20\x7f]/.test(entry.url) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443' || url.pathname === '/') throw apiError(400, 'invalid_repository', 'Use an HTTPS repository URL without credentials');
    const branch = entry.branch === undefined ? '' : text(entry.branch, 'Repository branch', 200);
    if (branch && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock'))) throw apiError(400, 'invalid_branch', 'Invalid repository branch');
    const fallback = value.length === 1 ? '.' : url.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '');
    const location = entry.path === undefined || entry.path === '' ? fallback : entry.path;
    if (typeof location !== 'string' || location.length > 200 || location !== '.' && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(location) || location.split('/').some((part) => !part || ['.', '..', '.git', '.codex'].includes(part))) || location === '.' && value.length !== 1) throw apiError(400, 'invalid_repository_path', 'Repositories need separate relative project directories');
    return { url: url.href, branch, path: location };
  });
  for (const [index, repository] of repositories.entries()) {
    if (repositories.slice(0, index).some((previous) => previous.path === repository.path || previous.path.startsWith(`${repository.path}/`) || repository.path.startsWith(`${previous.path}/`))) throw apiError(400, 'invalid_repository_path', 'Repository directories must not overlap');
  }
  return repositories;
}

function normalizeVariables(value, previous) {
  if (!Array.isArray(value) || value.length > 128) throw apiError(400, 'invalid_environment_variables', 'Use up to 128 environment variables');
  const names = new Set();
  let bytes = 0;
  return value.map((entry) => {
    object(entry, 'Environment variable');
    if (typeof entry.name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(entry.name) || RESERVED_ENVIRONMENT.test(entry.name)) throw apiError(400, 'invalid_environment_variable', 'Environment variable names must be uppercase and cannot override runtime or credential settings');
    if (names.has(entry.name)) throw apiError(400, 'invalid_environment_variable', 'Environment variable names must be unique');
    names.add(entry.name);
    if (entry.secret !== undefined && typeof entry.secret !== 'boolean') throw apiError(400, 'invalid_environment_variable', 'The secret flag must be a boolean');
    const secret = entry.secret === true;
    let supplied = entry.value;
    if (supplied === undefined) {
      const existing = previous.find((variable) => variable.name === entry.name);
      if (!secret || !existing?.secret) throw apiError(400, 'environment_variable_value_required', 'Provide a value for a new environment variable');
      supplied = existing.value;
    }
    const variableValue = text(supplied, 'Environment variable value', 65536);
    bytes += Buffer.byteLength(entry.name) + Buffer.byteLength(variableValue);
    if (bytes > 128 * 1024) throw apiError(413, 'environment_variables_too_large', 'Environment variables exceed the size limit');
    return { name: entry.name, value: variableValue, secret };
  });
}

function normalizeConfig(value = {}, previous = {}) {
  object(value, 'Environment configuration');
  const allowed = new Set(['repositories', 'installScript', 'startSkill', 'internetAccess', 'allowedDomains', 'networkSecrets', 'environmentVariables', 'privacy', 'advanced']);
  if (Object.keys(value).some((name) => !allowed.has(name))) throw apiError(400, 'unsupported_environment_configuration', 'This environment configuration is not supported by the runtime');
  const merged = { ...previous, ...value };
  const internetAccess = merged.internetAccess ?? 'enabled';
  if (internetAccess !== 'enabled') throw apiError(400, 'unsupported_internet_access', CAPABILITIES.unsupportedReasons.internetAccess);
  if (!Array.isArray(merged.allowedDomains ?? []) || (merged.allowedDomains ?? []).length) throw apiError(400, 'unsupported_network_restrictions', CAPABILITIES.unsupportedReasons.internetAccess);
  if (!Array.isArray(merged.networkSecrets ?? []) || (merged.networkSecrets ?? []).length) throw apiError(400, 'unsupported_network_secrets', CAPABILITIES.unsupportedReasons.networkSecrets);
  const privacy = merged.privacy ?? 'private';
  if (privacy !== 'private') throw apiError(400, 'unsupported_environment_sharing', CAPABILITIES.unsupportedReasons.sharing);
  const advanced = { ...(previous.advanced || {}), ...(value.advanced === undefined ? {} : object(value.advanced, 'Advanced configuration')) };
  if (Object.keys(advanced).some((name) => name !== 'setupTimeoutSeconds')) throw apiError(400, 'unsupported_environment_configuration', 'Advanced runtime options are not supported');
  const setupTimeoutSeconds = advanced.setupTimeoutSeconds ?? 900;
  if (!Number.isInteger(setupTimeoutSeconds) || setupTimeoutSeconds < 60 || setupTimeoutSeconds > 1800) throw apiError(400, 'invalid_setup_timeout', 'Setup timeout must be between 60 and 1800 seconds');
  return {
    repositories: normalizeRepositories(merged.repositories ?? []),
    installScript: text(merged.installScript ?? '', 'Install script', 65536),
    startSkill: text(merged.startSkill ?? '', 'Start skill', 32768),
    internetAccess, allowedDomains: [], networkSecrets: [],
    environmentVariables: normalizeVariables(merged.environmentVariables ?? [], previous.environmentVariables ?? []),
    privacy,
    advanced: { setupTimeoutSeconds },
  };
}

function preparationConfig(config) {
  const { startSkill, ...preparation } = config;
  return JSON.stringify(preparation);
}

function statusFor(record) {
  if (['preparing', 'publishing', 'error'].includes(record.status)) return record.status;
  if (record.published) return record.published.draftRevision === record.draftRevision ? 'published' : 'changes_pending';
  return record.preparedRevision === record.draftRevision ? 'ready' : 'draft';
}

export class CloudEnvironments {
  constructor({ dataDir, store, files, runtime, config = {}, githubEnvironment = () => ({}) }) {
    this.dataDir = path.resolve(dataDir || config.dataDir || path.dirname(store.directory));
    this.directory = path.join(this.dataDir, 'cloud-environments');
    Object.assign(this, { store, files, runtime, config, githubEnvironment });
    this.snapshots = new CloudSnapshots({ dataDir: this.dataDir, ...(config.cloudSnapshotBytes ? { maxSnapshotBytes: config.cloudSnapshotBytes } : {}) });
    this.owners = new Map();
    this.locks = new Map();
    this.redactions = new Set();
  }

  async privateDirectory(location) {
    await fs.mkdir(location, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(location);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (process.getuid?.() ?? info.uid) || info.mode & 0o077) throw apiError(503, 'unsafe_environment_storage', 'Cloud environment storage permissions are unsafe');
  }

  async initialize() {
    await this.privateDirectory(this.directory);
    await this.snapshots.initialize();
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!/^[1-9][0-9]{0,15}$/.test(entry.name)) continue;
      const ownerId = Number(entry.name);
      assertOwnerId(ownerId);
      const ownerDirectory = path.join(this.directory, entry.name);
      await this.privateDirectory(ownerDirectory);
      let handle;
      try { handle = await fs.open(path.join(ownerDirectory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let state;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.uid !== (process.getuid?.() ?? info.uid) || info.mode & 0o077 || info.size > MAX_STATE_BYTES) throw apiError(503, 'unsafe_environment_storage', 'Cloud environment storage is invalid');
        state = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      this.validateStoredState(ownerId, state);
      this.owners.set(ownerId, state);
      this.rememberSecrets(state);
      let interrupted = false;
      for (const record of Object.values(state.environments)) {
        if (!['preparing', 'publishing'].includes(record.status)) continue;
        if (record.pendingVersion && record.pendingVersion > (record.published?.version || 0)) {
          await this.snapshots.removeVersion?.({ ownerId, environmentId: record.id, version: record.pendingVersion });
          record.pendingVersion = null;
        }
        record.status = 'error';
        record.lastError = 'Environment preparation was interrupted by a service restart. Review the setup workspace and try again.';
        record.updatedAt = Date.now();
        interrupted = true;
      }
      if (interrupted) await this.persist(ownerId, state);
    }
  }

  validateStoredState(ownerId, state) {
    if (!state || state.schemaVersion !== SCHEMA_VERSION || state.ownerId !== ownerId || !state.environments || !state.bindings || Array.isArray(state.environments) || Array.isArray(state.bindings)) throw apiError(503, 'invalid_environment_storage', 'Cloud environment data could not be validated');
    for (const [id, record] of Object.entries(state.environments)) {
      if (!ENVIRONMENT_ID.test(id) || record.id !== id || record.ownerId !== ownerId || !ENVIRONMENT_ID.test(record.setupWorkspaceId) || !Number.isSafeInteger(record.draftRevision) || record.draftRevision < 1) throw apiError(503, 'invalid_environment_storage', 'Cloud environment ownership or revision is invalid');
      normalizeConfig(record.config);
      if (record.published) {
        if (!Number.isSafeInteger(record.published.version) || record.published.version < 1) throw apiError(503, 'invalid_environment_storage', 'Cloud environment version is invalid');
        normalizeConfig(record.published.config);
      }
    }
    for (const [id, binding] of Object.entries(state.bindings)) {
      if (!ENVIRONMENT_ID.test(id) || !ENVIRONMENT_ID.test(binding.environmentId) || !['setup', 'task'].includes(binding.kind)) throw apiError(503, 'invalid_environment_storage', 'Cloud workspace binding is invalid');
      if (binding.kind === 'setup' && state.environments[binding.environmentId]?.setupWorkspaceId !== id) throw apiError(503, 'invalid_environment_storage', 'Cloud setup binding is invalid');
      if (binding.kind === 'task') {
        if (!Number.isSafeInteger(binding.version) || binding.version < 1) throw apiError(503, 'invalid_environment_storage', 'Cloud task version is invalid');
        normalizeConfig(binding.config);
      }
      const workspace = this.store.states?.get(id)?.workspace;
      if (workspace && workspace.ownerId !== ownerId) throw apiError(503, 'invalid_environment_storage', 'Cloud workspace ownership is invalid');
    }
  }

  async lock(ownerId, action) {
    assertOwnerId(ownerId);
    const previous = this.locks.get(ownerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.locks.set(ownerId, current);
    try { return await current; }
    finally { if (this.locks.get(ownerId) === current) this.locks.delete(ownerId); }
  }

  ownerState(ownerId) {
    assertOwnerId(ownerId);
    return this.owners.get(ownerId) || { schemaVersion: SCHEMA_VERSION, ownerId, environments: {}, bindings: {} };
  }

  record(ownerId, id, state = this.ownerState(ownerId)) {
    const record = state.environments[environmentId(id)];
    if (!record) throw apiError(404, 'environment_not_found', 'Cloud environment not found');
    return record;
  }

  rememberSecrets(state) {
    const configurations = [
      ...Object.values(state.environments).flatMap((record) => [record.config, record.published?.config]),
      ...Object.values(state.bindings).map((binding) => binding.config),
    ];
    for (const config of configurations) for (const variable of config?.environmentVariables || []) if (variable.secret && variable.value) this.redactions.add(variable.value);
  }

  redact(value, additional = []) {
    let result = String(value);
    const secrets = [...new Set([...this.redactions, ...additional].filter((secret) => typeof secret === 'string' && secret))].sort((left, right) => right.length - left.length);
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  }

  sanitizeJSON(json) {
    const redactValue = (value) => typeof value === 'string' ? this.redact(value) : Array.isArray(value) ? value.map(redactValue) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item)])) : value;
    return JSON.stringify(redactValue(JSON.parse(json)));
  }

  async persist(ownerId, state) {
    const contents = JSON.stringify(state);
    if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw apiError(413, 'environment_storage_limit', 'Cloud environment metadata exceeds the storage limit');
    await this.privateDirectory(this.directory);
    const directory = path.join(this.directory, String(assertOwnerId(ownerId)));
    await this.privateDirectory(directory);
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, path.join(directory, 'state.json'));
      this.owners.set(ownerId, structuredClone(state));
      this.rememberSecrets(state);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  publicConfig(config) {
    return {
      repositories: config.repositories.map(({ url, branch, path: location }) => ({ url, branch, path: location })),
      installScript: this.redact(config.installScript), startSkill: this.redact(config.startSkill),
      internetAccess: config.internetAccess, allowedDomains: [], networkSecrets: [], privacy: config.privacy,
      environmentVariables: config.environmentVariables.map(({ name, secret, value }) => ({ name, secret, hasValue: Boolean(value), ...(secret ? {} : { value: this.redact(value) }) })),
      advanced: { setupTimeoutSeconds: config.advanced.setupTimeoutSeconds },
    };
  }

  publicEnvironment(record) {
    const published = record.published;
    return {
      id: record.id, name: this.redact(record.name), description: this.redact(record.description),
      createdAt: record.createdAt, updatedAt: record.updatedAt, setupWorkspaceId: record.setupWorkspaceId,
      draftRevision: record.draftRevision, preparedRevision: record.preparedRevision,
      publishedVersion: published?.version || null, publishedAt: published?.createdAt || null,
      status: statusFor(record), lastError: record.lastError ? this.redact(record.lastError) : null,
      setupLog: this.redact(record.setupLog || ''),
      config: this.publicConfig(record.config),
      published: published ? {
        version: published.version, createdAt: published.createdAt,
        snapshot: { bytes: published.snapshot.bytes, files: published.snapshot.files },
        config: this.publicConfig(published.config),
      } : null,
    };
  }

  list(ownerId) {
    return { environments: Object.values(this.ownerState(ownerId).environments).sort((left, right) => right.updatedAt - left.updatedAt).map((record) => this.publicEnvironment(record)), capabilities: structuredClone(CAPABILITIES) };
  }

  get(ownerId, id) { return { environment: this.publicEnvironment(this.record(ownerId, id)), capabilities: structuredClone(CAPABILITIES) }; }

  requireIdle(ownerId) {
    if ((this.store.allStates?.() || []).some((state) => state.workspace.ownerId === ownerId && ACTIVE_STATUSES.has(state.workspace.status))) throw apiError(409, 'environment_busy', 'Stop the current task before preparing or publishing an environment');
  }

  async workspacePaths(ownerId, workspaceId, { createTools = false } = {}) {
    assertWorkspaceId(workspaceId);
    const state = this.store.get(ownerId, workspaceId);
    if (state.workspace.remote) throw apiError(400, 'unsupported_cloud_runtime', 'Published cloud environments require a Docker workspace');
    const localFiles = this.files.local || this.files;
    const backend = this.runtime.backend?.(workspaceId) || this.runtime;
    if (!localFiles.check || !backend.exec) throw apiError(503, 'cloud_runtime_unavailable', 'Cloud environment preparation requires the Docker workspace runtime');
    const checked = await localFiles.check(workspaceId);
    const expected = workspacePaths(this.dataDir, workspaceId, ownerId);
    if (checked.projectPath !== expected.projectPath || checked.workspaceHomePath !== expected.workspaceHomePath) throw apiError(409, 'unsafe_cloud_workspace', 'Cloud workspace directories do not match their owner');
    const toolsPath = path.join(expected.workspaceHomePath, 'environment-home');
    if (createTools) {
      const result = await runCommand('python3', ['-I', '-c', ENSURE_TOOLS_HOME], { input: JSON.stringify({ workspaceHomePath: expected.workspaceHomePath }), maxBytes: 8192 });
      if (result.code) throw apiError(409, 'unsafe_environment_home', 'Environment tools directory could not be prepared safely');
    }
    return { ...expected, toolsPath };
  }

  async create(ownerId, body, setupWorkspace) {
    return this.lock(ownerId, async () => {
      this.requireIdle(ownerId);
      object(body, 'Environment');
      const state = structuredClone(this.ownerState(ownerId));
      if (Object.keys(state.environments).length >= (this.config.maxCloudEnvironments || 50)) throw apiError(409, 'cloud_environment_limit', 'Cloud environment limit reached');
      const name = text(body.name, 'Environment name', 120, { empty: false, trim: true });
      const description = text(body.description ?? '', 'Environment description', 2000);
      const config = normalizeConfig(body.config ?? {});
      const setupWorkspaceId = setupWorkspace?.id || setupWorkspace?.workspace?.id;
      if (state.bindings[setupWorkspaceId]) throw apiError(409, 'workspace_already_bound', 'This workspace is already bound to an environment');
      await this.workspacePaths(ownerId, setupWorkspaceId, { createTools: true });
      const now = Date.now(), id = randomUUID();
      const record = { id, ownerId, name, description, config, setupWorkspaceId, createdAt: now, updatedAt: now, draftRevision: 1, preparedRevision: null, preparedRepositories: [], published: null, status: 'draft', lastError: null, setupLog: '' };
      state.environments[id] = record;
      state.bindings[setupWorkspaceId] = { kind: 'setup', environmentId: id };
      await this.persist(ownerId, state);
      return { environment: this.publicEnvironment(record) };
    });
  }

  async update(ownerId, id, body) {
    return this.lock(ownerId, async () => {
      object(body, 'Environment');
      const state = structuredClone(this.ownerState(ownerId)), record = this.record(ownerId, id, state);
      if (['preparing', 'publishing'].includes(record.status)) throw apiError(409, 'environment_busy', 'Wait for the current environment operation');
      if (body.expectedRevision !== undefined && body.expectedRevision !== record.draftRevision) throw apiError(409, 'environment_conflict', 'This environment changed. Reload it before saving.');
      if (body.name !== undefined) record.name = text(body.name, 'Environment name', 120, { empty: false, trim: true });
      if (body.description !== undefined) record.description = text(body.description, 'Environment description', 2000);
      if (body.config !== undefined) {
        const next = normalizeConfig(body.config, record.config);
        if (JSON.stringify(next) !== JSON.stringify(record.config)) {
          const reusable = record.preparedRevision === record.draftRevision && preparationConfig(next) === preparationConfig(record.config);
          record.config = next;
          record.draftRevision += 1;
          record.preparedRevision = reusable ? record.draftRevision : null;
        }
      }
      record.status = 'draft'; record.lastError = null; record.updatedAt = Date.now();
      await this.persist(ownerId, state);
      return { environment: this.publicEnvironment(record) };
    });
  }

  bindingConfig(ownerId, workspaceId) {
    const state = this.ownerState(ownerId), binding = state.bindings[workspaceId];
    if (!binding) return undefined;
    this.store.get(ownerId, workspaceId);
    return binding.kind === 'task' ? binding.config : this.record(ownerId, binding.environmentId, state).config;
  }

  workspaceEnvironment(ownerId, workspaceId) {
    const config = this.bindingConfig(ownerId, workspaceId);
    if (!config) return undefined;
    return {
      home: `/home/codex/workspaces/${assertWorkspaceId(workspaceId)}/environment-home`,
      env: Object.fromEntries(config.environmentVariables.map(({ name, value }) => [name, value])),
      internetAccess: config.internetAccess, allowedDomains: [...config.allowedDomains],
    };
  }

  workspaceInstructions(ownerId, workspaceId) { return this.bindingConfig(ownerId, workspaceId)?.startSkill; }

  workspaceRevision(ownerId, workspaceId) {
    const state = this.ownerState(ownerId), binding = state.bindings[workspaceId];
    if (!binding) return undefined;
    this.store.get(ownerId, workspaceId);
    return `${binding.environmentId}:${binding.kind}:${binding.kind === 'task' ? binding.version : this.record(ownerId, binding.environmentId, state).draftRevision}`;
  }

  secretsForWorkspace(ownerId, workspaceId) { return this.bindingConfig(ownerId, workspaceId)?.environmentVariables.filter((variable) => variable.secret && variable.value).map((variable) => variable.value) || []; }

  async setup(ownerId, id) {
    return this.lock(ownerId, async () => {
      this.requireIdle(ownerId);
      const state = structuredClone(this.ownerState(ownerId)), record = this.record(ownerId, id, state);
      if (['preparing', 'publishing'].includes(record.status)) throw apiError(409, 'environment_busy', 'Wait for the current environment operation');
      await this.workspacePaths(ownerId, record.setupWorkspaceId, { createTools: true });
      record.status = 'preparing'; record.preparedRevision = null; record.lastError = null; record.setupLog = ''; record.updatedAt = Date.now();
      await this.persist(ownerId, state);
      const githubEnvironment = this.githubEnvironment(ownerId) || {};
      const transientSecrets = [githubEnvironment.GH_TOKEN, githubEnvironment.GITHUB_TOKEN, this.config.apiKey].filter(Boolean);
      for (const secret of transientSecrets) this.redactions.add(secret);
      try {
        const prepared = await prepareCloudWorkspace({
          runtime: this.runtime, workspaceId: record.setupWorkspaceId,
          repositories: record.config.repositories, previousRepositories: record.preparedRepositories,
          installScript: record.config.installScript,
          workspaceEnvironment: this.workspaceEnvironment(ownerId, record.setupWorkspaceId),
          githubEnvironment, timeoutSeconds: record.config.advanced.setupTimeoutSeconds,
        });
        record.preparedRepositories = structuredClone(record.config.repositories);
        record.repositoryRevisions = prepared.repositories;
        record.setupLog = this.redact(prepared.output || '', transientSecrets).slice(-128 * 1024);
        record.preparedRevision = record.draftRevision;
        record.status = 'ready'; record.lastError = null; record.updatedAt = Date.now();
        await this.persist(ownerId, state);
        return { environment: this.publicEnvironment(record), workspace: this.store.publicWorkspace(this.store.get(ownerId, record.setupWorkspaceId)) };
      } catch (error) {
        record.status = 'error'; record.lastError = this.redact(error.message || 'Environment preparation failed', transientSecrets).slice(0, 4096);
        record.setupLog = this.redact(error.output || '', transientSecrets).slice(-128 * 1024);
        record.updatedAt = Date.now();
        await this.persist(ownerId, state);
        throw apiError(error.statusCode || 409, error.code || 'environment_setup_failed', record.lastError);
      }
    });
  }

  async publish(ownerId, id) {
    return this.lock(ownerId, async () => {
      this.requireIdle(ownerId);
      const state = structuredClone(this.ownerState(ownerId)), record = this.record(ownerId, id, state);
      if (['preparing', 'publishing'].includes(record.status)) throw apiError(409, 'environment_busy', 'Wait for the current environment operation');
      if (record.preparedRevision !== record.draftRevision) throw apiError(409, 'environment_setup_required', 'Prepare this environment revision before publishing');
      const paths = await this.workspacePaths(ownerId, record.setupWorkspaceId);
      const version = (record.published?.version || 0) + 1;
      record.status = 'publishing'; record.lastError = null; record.pendingVersion = version; record.updatedAt = Date.now();
      await this.persist(ownerId, state);
      let captured = false;
      try {
        // Detached children can outlive the App Server. A stopped Docker user
        // container gives the snapshot a stable project and tools filesystem.
        if (!this.runtime.stopUser) throw apiError(503, 'cloud_runtime_unavailable', 'Cloud environment snapshots require a stoppable Docker runtime');
        await this.runtime.stopUser(ownerId);
        const github = this.githubEnvironment(ownerId) || {};
        const forbiddenSecrets = [...new Set([...this.secretsForWorkspace(ownerId, record.setupWorkspaceId), github.GH_TOKEN, github.GITHUB_TOKEN, this.config.apiKey].filter(Boolean))];
        const snapshot = await this.snapshots.capture({ ownerId, environmentId: id, version, projectPath: paths.projectPath, toolsPath: paths.toolsPath, forbiddenSecrets });
        captured = true;
        record.published = { version, createdAt: Date.now(), draftRevision: record.draftRevision, config: structuredClone(record.config), snapshot };
        record.status = 'published'; record.pendingVersion = null; record.lastError = null; record.updatedAt = Date.now();
        await this.persist(ownerId, state);
        return { environment: this.publicEnvironment(record) };
      } catch (error) {
        if (captured) await this.snapshots.removeVersion?.({ ownerId, environmentId: id, version }).catch(() => {});
        const old = this.record(ownerId, id);
        record.published = structuredClone(old.published);
        record.status = 'error'; record.pendingVersion = null;
        record.lastError = this.redact(error.message || 'Environment publication failed').slice(0, 4096); record.updatedAt = Date.now();
        await this.persist(ownerId, state);
        throw apiError(error.statusCode || 409, error.code || 'environment_publish_failed', record.lastError);
      }
    });
  }

  async materialize(ownerId, id, targetWorkspaceId) {
    return this.lock(ownerId, async () => {
      const target = this.store.get(ownerId, targetWorkspaceId);
      if (this.store.projectStates(this.store.root(target)).some((entry) => ACTIVE_STATUSES.has(entry.workspace.status))) throw apiError(409, 'workspace_busy', 'Cloud task destination must be idle');
      const state = structuredClone(this.ownerState(ownerId)), record = this.record(ownerId, id, state);
      if (!record.published) throw apiError(409, 'environment_not_published', 'Publish this environment before starting a task');
      if (state.bindings[targetWorkspaceId]) throw apiError(409, 'workspace_already_bound', 'Create a new workspace for each cloud task');
      const paths = await this.workspacePaths(ownerId, targetWorkspaceId, { createTools: true });
      // Restoring a new, empty destination uses checked descriptors and atomic
      // root replacement. A sibling task does not need to stop for this copy.
      if ((await fs.readdir(paths.projectPath)).length || (await fs.readdir(paths.toolsPath)).length) throw apiError(409, 'workspace_not_empty', 'Cloud tasks require an empty project and tools directory');
      const published = record.published;
      await this.snapshots.restore({ ownerId, environmentId: id, version: published.version, projectPath: paths.projectPath, toolsPath: paths.toolsPath });
      state.bindings[targetWorkspaceId] = { kind: 'task', environmentId: id, environmentName: record.name, version: published.version, config: structuredClone(published.config), createdAt: Date.now() };
      await this.persist(ownerId, state);
      return { environment: { id, name: this.redact(record.name), version: published.version }, workspaceEnvironment: this.workspaceEnvironment(ownerId, targetWorkspaceId) };
    });
  }

  setupEnvironment(ownerId, workspaceId) {
    const binding = this.ownerState(ownerId).bindings[workspaceId];
    return binding?.kind === 'setup' ? binding.environmentId : undefined;
  }

  async removeWorkspaceBinding(ownerId, workspaceId) {
    return this.lock(ownerId, async () => {
      const state = structuredClone(this.ownerState(ownerId)), binding = state.bindings[workspaceId];
      if (!binding) return;
      if (binding.kind === 'setup') throw apiError(409, 'environment_workspace_in_use', 'Delete the cloud environment before deleting its setup workspace');
      delete state.bindings[workspaceId];
      await this.persist(ownerId, state);
    });
  }

  async remove(ownerId, id) {
    return this.lock(ownerId, async () => {
      this.requireIdle(ownerId);
      const state = structuredClone(this.ownerState(ownerId)), record = this.record(ownerId, id, state);
      if (['preparing', 'publishing'].includes(record.status)) throw apiError(409, 'environment_busy', 'Wait for the current environment operation');
      await this.snapshots.remove(ownerId, id);
      delete state.bindings[record.setupWorkspaceId];
      delete state.environments[id];
      await this.persist(ownerId, state);
      return { deleted: true };
    });
  }
}
