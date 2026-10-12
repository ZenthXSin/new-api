import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './workspace-files.mjs';
import { UserWorkspaceLayout, assertOwnerId, assertWorkspaceId, legacyWorkspacePaths, userPaths, workspaceError } from './user-layout.mjs';
import { githubGitEnvironment } from './github-credentials.mjs';

const MANAGED_LABEL = 'new-api.codex.managed';
const OWNER_LABEL = 'new-api.codex.owner';
const VERSION_LABEL = 'new-api.codex.isolation-version';
const MODE_LABEL = 'new-api.codex.mode';
const ENVIRONMENT = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent' };
const RUNTIME_ENV_KEY = 'NEW_API_CODEX_RUNTIME_ENV';
// Keep project values out of the Docker client's environment. Only this trusted
// launcher restores them inside the non-root container, without values in argv.
const ENVIRONMENT_LAUNCHER = 'import json,os,sys; values=json.loads(os.environ.pop("NEW_API_CODEX_RUNTIME_ENV")); os.environ.update(values); os.execvpe(sys.argv[1],sys.argv[1:],os.environ)';
const STDIN_ENVIRONMENT_LAUNCHER = `import os,sys,json
header=bytearray()
while True:
 b=os.read(0,1)
 if b==b'\\n': break
 if not b or len(header)>262144: raise SystemExit(2)
 header.extend(b)
os.environ.update(json.loads(header))
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
`;
const READONLY_SCOPE_LABEL = 'new-api.codex.readonly-scope';
const RESERVED_ENVIRONMENT = /^(?:HOME|PATH|CODEX_HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|IFS|CDPATH|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|PYTHON.*|PERL.*|RUBY.*|GEM_.*|BUNDLE_.*|LD_.*|DYLD_.*|DOCKER_.*|NEW_API_.*|CODEX_.*|GH_.*|GITHUB_.*|GIT_.*|XDG_.*|NPM_CONFIG_PREFIX|NPM_CONFIG_USERCONFIG)$/;

export function validateWorkspaceEnvironment(id, configuration) {
  assertWorkspaceId(id);
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw workspaceError('Invalid workspace environment', 'invalid_environment');
  const home = `/home/codex/workspaces/${id}/environment-home`;
  if (configuration.home !== home) throw workspaceError('Workspace tool home must belong to this task', 'invalid_environment');
  if (configuration.internetAccess !== 'enabled' || !Array.isArray(configuration.allowedDomains) || configuration.allowedDomains.length) throw workspaceError('This Docker runtime supports enabled internet access without domain restrictions only', 'unsupported_network_policy');
  if (configuration.privacy !== undefined && configuration.privacy !== 'private') throw workspaceError('This Docker runtime supports private environments only', 'unsupported_privacy_policy');
  const variables = configuration.env ?? {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.keys(variables).length > 128) throw workspaceError('Invalid workspace environment variables', 'invalid_environment');
  let bytes = 0;
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || RESERVED_ENVIRONMENT.test(name.toUpperCase()) || typeof value !== 'string' || value.includes('\0') || value.length > 32768) throw workspaceError('Invalid or reserved workspace environment variable', 'invalid_environment');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (bytes > 128 * 1024) throw workspaceError('Workspace environment variables exceed the size limit', 'invalid_environment');
  return { ...variables, HOME: home, PATH: `${home}/.local/bin:${home}/bin:${ENVIRONMENT.PATH}`, XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`, npm_config_prefix: `${home}/.local`, npm_config_userconfig: `${home}/.npmrc`, PYTHONUSERBASE: `${home}/.local` };
}

export class DockerRuntime {
  #githubCredentials = new Map();
  #workspaceEnvironmentResolver;

  constructor({ dataDir, image = 'new-api:codex-user-environment-0.160.0', network = 'new-api-codex-workers', command = runCommand, spawnImpl = spawn, minFreeBytes = 1024 ** 3, workspaceBytes = 2 * 1024 ** 3, userBytes, statfs = fs.statfs, cpuPercent = 5, memoryMB = 2048, hostCpuCount = os.cpus().length }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,200}$/.test(image) || !/^new-api-codex-[a-z0-9-]+$/.test(network)) throw new Error('Invalid Codex runtime image or dedicated network');
    if (!Number.isFinite(cpuPercent) || cpuPercent <= 0 || cpuPercent > 100 || !Number.isFinite(hostCpuCount) || hostCpuCount < 1) throw new Error('Invalid Codex runtime resource percentages');
    if (!Number.isInteger(memoryMB) || memoryMB < 256 || memoryMB > 1048576) throw new Error('Invalid Codex runtime memory MB');
    const cpuQuota = Math.max(0.1, hostCpuCount * cpuPercent / 100);
    const memoryBytes = memoryMB * 1024 ** 2;
    Object.assign(this, { dataDir: path.resolve(dataDir), image, network, command, spawnImpl, minFreeBytes, workspaceBytes: userBytes || workspaceBytes, statfs, cpuPercent, memoryMB, hostCpuCount, cpuQuota, memoryBytes });
    this.readonlyScope = createHash('sha256').update(this.dataDir).digest('hex').slice(0,16);
    this.layout = new UserWorkspaceLayout(this.dataDir);
    this.locks = new Map(); this.modes = new Map(); this.cache = new Map(); this.revisions = new Map(); this.diskCache = new Map(); this.migratedHomes = new Set();
  }
  resources(ownerId) {
    const policy=this.userPolicies?.get(ownerId)||{};
    return {cpuQuota:policy.cpuPercent?Math.max(0.1,this.hostCpuCount*policy.cpuPercent/100):this.cpuQuota,cpuPercent:policy.cpuPercent||this.cpuPercent,memoryBytes:policy.memoryMB?policy.memoryMB*1024**2:this.memoryBytes,workspaceBytes:policy.diskMB?policy.diskMB*1024**2:this.workspaceBytes};
  }
  registerWorkspace(id, ownerId) { this.layout.register(id, ownerId); }
  setWorkspaceEnvironmentResolver(resolver) {
    if (typeof resolver !== 'function') throw new TypeError('Workspace environment resolver must be a function');
    this.#workspaceEnvironmentResolver = resolver;
  }
  unregisterWorkspace(id) { this.layout.unregister(id); }
  owner(id) { return this.layout.owner(id); }
  setGitHubCredential(ownerId, credential) {
    assertOwnerId(ownerId);
    if (credential?.token) this.#githubCredentials.set(ownerId, { ...credential });
    else this.#githubCredentials.delete(ownerId);
  }
  name(ownerId) { return `new-api-codex-user-${assertOwnerId(ownerId)}`; }
  cwd(id) { return this.layout.paths(id).cwd; }
  async lock(ownerId, action) {
    assertOwnerId(ownerId);
    const previous = this.locks.get(ownerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(action); this.locks.set(ownerId, current);
    try { return await current; } finally { if (this.locks.get(ownerId) === current) this.locks.delete(ownerId); }
  }
  readonlyName(ownerId, processId) { return `new-api-codex-readonly-${assertOwnerId(ownerId)}-${assertWorkspaceId(processId)}`; }
  async initialize(workspaces) {
    const leftovers = await this.command('docker', ['ps','--all','--filter',`label=${READONLY_SCOPE_LABEL}=${this.readonlyScope}`,'--format','{{.Names}}']);
    if (leftovers.code) throw workspaceError('Read-only task cleanup could not be checked','runtime_stop_failed',503);
    for (const name of leftovers.stdout.trim().split('\n').filter(Boolean)) {
      if (!/^new-api-codex-readonly-[1-9][0-9]*-[a-f0-9-]{36}$/.test(name)) throw workspaceError('Invalid read-only task identity','unsafe_container',409);
      const removed=await this.command('docker',['rm','--force',name]);
      if (removed.code) throw workspaceError('Read-only task cleanup failed','runtime_stop_failed',503);
    }
    for (const workspace of workspaces) this.registerWorkspace(workspace.id, workspace.ownerId);
    // Stop only known legacy containers after checking their exact original binds.
    for (const { id } of workspaces) {
      const name = `new-api-codex-${assertWorkspaceId(id)}`, info = await this.inspectName(name);
      if (!info) continue;
      const legacy = legacyWorkspacePaths(this.dataDir, id);
      this.validate(info, { ownerId: null, workspaceId: id, projectsPath: legacy.projectPath, homePath: legacy.homePath, destination: '/workspace' });
      if (info.State?.Running) await this.dockerStop(name);
      const result = await this.command('docker', ['rm', name], { timeoutMs: 20_000, maxBytes: 128 * 1024 });
      if (result.code) throw workspaceError('Legacy container could not be retired', 'runtime_remove_failed', 503);
    }
    const listed = await this.command('docker', ['ps', '-a', '--filter', `label=${MANAGED_LABEL}=true`, '--format', '{{.Names}}'], { maxBytes: 512 * 1024 });
    if (listed.code) throw workspaceError('Docker runtime is unavailable', 'runtime_unavailable', 503);
    for (const name of listed.stdout.trim().split('\n')) {
      if (!/^new-api-codex-user-[1-9][0-9]*$/.test(name)) continue;
      const ownerId = Number(name.slice('new-api-codex-user-'.length));
      const candidate = await this.inspectName(name);
      const expected = userPaths(this.dataDir, ownerId);
      // Independent fixture/development runners may use this Docker daemon.
      // Only this data root owns startup cleanup; direct name access still
      // rejects collisions or mismatched mounts through inspectUser.
      if (!candidate?.Mounts?.some((mount) => mount.Source === expected.projectsPath || mount.Source === expected.homePath)) continue;
      const info = this.validate(candidate, { ownerId, ...expected });
      if (info?.State?.Running) await this.stopUser(ownerId);
    }
  }
  async availability() {
    const results = await Promise.all([
      this.command('docker', ['image', 'inspect', this.image], { maxBytes: 256 * 1024, timeoutMs: 10_000 }),
      this.command('docker', ['network', 'inspect', this.network], { maxBytes: 256 * 1024, timeoutMs: 10_000 }),
    ]);
    if (results[0].code) return { available: false, reason: 'Codex user environment image is not installed' };
    let network; try { [network] = JSON.parse(results[1].stdout); } catch { return { available: false, reason: 'Dedicated Codex worker network is unavailable' }; }
    if (results[1].code || network.Driver !== 'bridge' || network.Labels?.[MANAGED_LABEL] !== 'true') return { available: false, reason: 'Dedicated Codex worker network is unavailable' };
    try { await this.checkDisk(); } catch (error) { return { available: false, reason: error.message }; }
    return { available: true };
  }
  async checkDisk() {
    const stats = await this.statfs(this.dataDir);
    if (Number(stats.bavail) * Number(stats.bsize) < this.minFreeBytes) throw workspaceError('Environment disk space is low; free space before starting a task', 'disk_space_low', 507);
  }
  async inspectName(name) {
    const result = await this.command('docker', ['inspect', '--type=container', name], { maxBytes: 512 * 1024 });
    if (result.code !== 0) { if (/No such (object|container)/i.test(result.stderr)) return null; throw workspaceError('Docker runtime is unavailable', 'runtime_unavailable', 503); }
    let info; try { [info] = JSON.parse(result.stdout); } catch { throw workspaceError('Invalid Docker runtime response', 'runtime_unavailable', 503); }
    if (!info || typeof info !== 'object') throw workspaceError('Invalid Docker runtime response', 'runtime_unavailable', 503);
    return info;
  }
  validate(info, { ownerId, workspaceId, projectsPath, homePath, destination = '/workspace/projects' }) {
    const labels = info.Config?.Labels || {}, binds = (info.Mounts || []).filter((mount) => mount.Type === 'bind'), mode = labels[MODE_LABEL];
    const networks = Object.keys(info.NetworkSettings?.Networks || {});
    const identity = ownerId ? labels[OWNER_LABEL] === String(ownerId) && labels[VERSION_LABEL] === '2' : labels['new-api.codex.workspace'] === workspaceId;
    if (labels[MANAGED_LABEL] !== 'true' || !identity || !['code', 'ask'].includes(mode) || info.Config.User !== '1000:1000' || info.HostConfig?.NetworkMode !== this.network || networks.length !== 1 || networks[0] !== this.network || info.HostConfig.Privileged || ['host'].includes(info.HostConfig.PidMode) || ['host'].includes(info.HostConfig.IpcMode) || ['host'].includes(info.HostConfig.UTSMode) || info.HostConfig.CapAdd?.length || info.HostConfig.Devices?.length || !info.HostConfig.ReadonlyRootfs || !info.HostConfig.CapDrop?.includes('ALL') || !info.HostConfig.SecurityOpt?.some((value) => value.startsWith('no-new-privileges')) || (info.Mounts || []).some((mount) => mount.Type !== 'bind' && !(mount.Type === 'tmpfs' && ['/tmp', '/run'].includes(mount.Destination))) || binds.length !== 2 || !binds.some((mount) => mount.Source === projectsPath && mount.Destination === destination && mount.RW === (mode === 'code')) || !binds.some((mount) => mount.Source === homePath && mount.Destination === '/home/codex' && mount.RW === true)) throw workspaceError('Existing container does not match this user isolation policy', 'unsafe_container', 409);
    return info;
  }
  async inspectUser(ownerId) {
    const info = await this.inspectName(this.name(ownerId));
    if (!info) return null;
    return this.validate(info, { ownerId, ...userPaths(this.dataDir, ownerId) });
  }
  inspect(id) { return this.inspectUser(this.owner(id)); }
  invalidate(ownerId) { this.cache.delete(ownerId); this.revisions.set(ownerId, (this.revisions.get(ownerId) || 0) + 1); }
  async environment(ownerId) {
    assertOwnerId(ownerId);
    const revision = this.revisions.get(ownerId) || 0;
    const cached = this.cache.get(ownerId); if (cached && Date.now() - cached.time < 3000) return { ...cached.value };
    const info = await this.inspectUser(ownerId);
    let diskBytes = this.diskCache.get(ownerId)?.bytes || 0;
    if (!this.diskCache.has(ownerId) || Date.now() - this.diskCache.get(ownerId).time > 30000) {
      try { diskBytes = (await this.userDiskUsage(ownerId)).bytes; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.diskCache.set(ownerId, { bytes: diskBytes, time: Date.now() });
    }
    const resources=this.resources(ownerId);
    const value = { container: this.name(ownerId), status: info ? info.State?.Running ? 'running' : 'stopped' : 'not_created', mode: info?.Config?.Labels?.[MODE_LABEL] || this.modes.get(ownerId) || 'code', diskBytes, diskLimitBytes: resources.workspaceBytes, cpu: info?.HostConfig?.NanoCpus ? info.HostConfig.NanoCpus/1e9 : resources.cpuQuota, cpuPercent: resources.cpuPercent, memoryBytes: info?.HostConfig?.Memory || resources.memoryBytes, idleSeconds: 600, runtime: 'docker', network: { mode: 'bridge', internetAccess: 'enabled', policyEditable: false }, persistentStorage: true, filesystemIsolation: 'user' };
    if (revision !== (this.revisions.get(ownerId) || 0)) return this.environment(ownerId);
    this.cache.set(ownerId, { time: Date.now(), value }); return { ...value };
  }
  start(id) { return this.startUser(this.owner(id)); }
  setMode(id, mode) { return this.startUser(this.owner(id), { mode }); }
  async startUser(ownerId, { mode } = {}) {
    if (mode !== undefined && !['code', 'ask'].includes(mode)) throw workspaceError('Invalid environment mode', 'invalid_mode');
    const resources=this.resources(ownerId);
    assertOwnerId(ownerId); this.invalidate(ownerId);
    try { return await this.lock(ownerId, async () => {
      await this.checkDisk();
      const user = await this.layout.ensureUser(ownerId);
      let existing = await this.inspectUser(ownerId);
      const desired = mode || existing?.Config?.Labels?.[MODE_LABEL] || this.modes.get(ownerId) || 'code';
      const expectedNanoCpus = Math.round(resources.cpuQuota * 1e9);
      const resourcesChanged = existing && (existing.HostConfig?.NanoCpus !== expectedNanoCpus || existing.HostConfig?.Memory !== resources.memoryBytes || existing.HostConfig?.MemorySwap !== resources.memoryBytes);
      const homeChanged = existing && !existing.Config.Env?.includes('CODEX_HOME=/home/codex/user/.codex');
      if (existing && (existing.Config.Labels[MODE_LABEL] !== desired || resourcesChanged || homeChanged)) {
        if (existing.State?.Running) await this.dockerStop(this.name(ownerId));
        const removal = await this.command('docker', ['rm', this.name(ownerId)], { timeoutMs: 20_000, maxBytes: 128 * 1024 });
        if (removal.code) throw workspaceError(resourcesChanged ? 'Environment resource limits could not be updated' : 'Environment mode could not be changed', 'runtime_remove_failed', 503);
        existing = null;
      }
      this.modes.set(ownerId, desired); this.cache.delete(ownerId);
      if (existing?.State?.Running) return { ownerId, container: this.name(ownerId), running: true, mode: desired };
      if (!existing) {
        const network = await this.command('docker', ['network', 'inspect', this.network], { maxBytes: 256 * 1024 });
        let details; try { [details] = JSON.parse(network.stdout); } catch { throw workspaceError('Dedicated Codex worker network is unavailable', 'runtime_unavailable', 503); }
        if (network.code || details.Driver !== 'bridge' || details.Labels?.[MANAGED_LABEL] !== 'true') throw workspaceError('Codex requires a dedicated managed worker bridge', 'unsafe_network', 503);
        const result = await this.command('docker', [
          'create', '--name', this.name(ownerId), '--label', `${MANAGED_LABEL}=true`, '--label', `${OWNER_LABEL}=${ownerId}`, '--label', `${VERSION_LABEL}=2`, '--label', `${MODE_LABEL}=${desired}`,
          '--user', '1000:1000', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
          '--cpus', String(resources.cpuQuota), '--memory', String(resources.memoryBytes), '--memory-swap', String(resources.memoryBytes), '--pids-limit', '256', '--ulimit', 'nofile=4096:4096',
          '--network', this.network, '--dns', '1.1.1.1', '--dns', '8.8.8.8', '--ipc', 'private',
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/run:rw,nosuid,nodev,noexec,size=16m',
          '--mount', `type=bind,src=${user.projectsPath},dst=/workspace/projects${desired === 'ask' ? ',readonly' : ''}`, '--mount', `type=bind,src=${user.homePath},dst=/home/codex`,
          '--workdir', '/workspace/projects', '--env', 'HOME=/home/codex/user', '--env', 'CODEX_HOME=/home/codex/user/.codex', '--env', 'LANG=C.UTF-8', '--env', 'NODE_OPTIONS=--max-old-space-size=1024',
          '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2', '--stop-timeout', '10', this.image, 'sleep', 'infinity',
        ], { timeoutMs: 30_000, maxBytes: 128 * 1024 });
        if (result.code) { this.cache.delete(ownerId); throw workspaceError('User environment could not be created', 'runtime_unavailable', 503); }
      }
      const result = await this.command('docker', ['start', this.name(ownerId)], { timeoutMs: 30_000, maxBytes: 128 * 1024 });
      if (result.code) { this.cache.delete(ownerId); throw workspaceError('User environment could not be started', 'runtime_unavailable', 503); }
      await this.inspectUser(ownerId);
      this.cache.delete(ownerId);
      return { ownerId, container: this.name(ownerId), running: true, mode: desired };
    }); } finally { this.invalidate(ownerId); }
  }
  projectEnv(id) { const paths = this.layout.paths(id); return { HOME: '/home/codex/user', CODEX_HOME: paths.codexHome, NEW_API_CODEX_PROJECT_DIR: paths.cwd, NEW_API_CODEX_PROJECT_HOME: `/home/codex/workspaces/${id}` }; }
  async taskEnvironment(id, configuration) {
    const supplied = configuration === undefined ? await this.#workspaceEnvironmentResolver?.(id) : configuration;
    if (supplied === undefined || supplied === null) return null;
    const environment = validateWorkspaceEnvironment(id, supplied);
    const paths = await this.layout.check(id);
    // A tool home is never the shared user home, Codex's credential/history
    // directory, a sibling task, or a link into any of those directories.
    const directory = path.join(paths.workspaceHomePath, 'environment-home');
    const stat = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') throw workspaceError('Workspace tool home is not prepared', 'environment_not_ready', 409); throw error; });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw workspaceError('Workspace tool home is unsafe', 'unsafe_path');
    return environment;
  }
  async exec(id, argv, { input, timeoutMs = 100_000, maxBytes = 4 * 1024 * 1024, env = {}, workspaceEnvironment } = {}) {
    const taskEnv = await this.taskEnvironment(id, workspaceEnvironment);
    const projectEnv = this.projectEnv(id);
    const mergedEnv = taskEnv ? { ...taskEnv, ...env, ...projectEnv, HOME: taskEnv.HOME, PATH: taskEnv.PATH } : { ...projectEnv, ...env };
    for (const [name, value] of Object.entries(mergedEnv)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) throw workspaceError('Invalid runtime environment variable');
    await this.layout.check(id); await this.start(id);
    const arguments_ = ['exec', '-i', '--user', '1000:1000', '--workdir', this.cwd(id), '--env', RUNTIME_ENV_KEY];
    arguments_.push(this.name(this.owner(id)), '/usr/bin/python3', '-I', '-c', ENVIRONMENT_LAUNCHER, '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, ...argv);
    return this.command('docker', arguments_, { input, env: { ...ENVIRONMENT, [RUNTIME_ENV_KEY]: JSON.stringify(mergedEnv) }, timeoutMs: timeoutMs + 10_000, maxBytes });
  }
  async gitOperation(id, operation, args = {}) {
    const result = await this.exec(id, ['python3', '-I', '/opt/new-api-codex/workspace-git.py'], { input: JSON.stringify({ operation, ...args }), env: operation === 'clone' ? githubGitEnvironment(this.#githubCredentials.get(this.owner(id))) : {}, timeoutMs: operation === 'clone' ? 105_000 : 45_000, maxBytes: 5 * 1024 * 1024 });
    let response; try { response = JSON.parse(result.stdout); } catch { throw workspaceError('Git operation could not be completed', 'git_failed', 500); }
    if (!response.ok) throw workspaceError(response.error || 'Git operation failed', 'git_failed', 400);
    return response.result;
  }
  baseline(id) { return this.gitOperation(id, 'baseline'); }
  diff(id) { return this.gitOperation(id, 'diff'); }
  clone(id, repository) { return this.gitOperation(id, 'clone', repository); }
  async spawnAppServer(id, { env = {}, mode = 'code', workspaceEnvironment, processId = id } = {}) {
    const apiKey = env.NEW_API_KEY;
    let baseUrl; try { baseUrl = new URL(env.NEW_API_BASE_URL); } catch { throw workspaceError('Model provider is not configured', 'model_not_configured', 503); }
    if (!apiKey || typeof apiKey !== 'string' || /[\r\n\x00]/.test(apiKey) || !['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw workspaceError('Model provider configuration is invalid', 'model_not_configured', 503);
    const taskEnv = await this.taskEnvironment(id, workspaceEnvironment);
    await this.setMode(id, 'code'); await this.layout.check(id);
    if (!this.migratedHomes.has(id)) {
      const result = await this.exec(id, ['/usr/bin/python3', '-I', '/opt/new-api-codex/migrate-codex-home.py', id], { maxBytes: 1024 * 1024, workspaceEnvironment: null });
      if (result.code) throw workspaceError('Codex history migration failed; the original files are preserved', 'history_migration_failed', 503);
      this.migratedHomes.add(id);
    }
    const provider = `{name="New API",base_url=${JSON.stringify(baseUrl.href.replace(/\/$/, ''))},env_key="NEW_API_KEY",wire_api="responses",request_max_retries=2,stream_max_retries=2}`;
    const projectEnv = { ...taskEnv, ...this.projectEnv(id), ...(taskEnv ? { HOME: taskEnv.HOME, PATH: taskEnv.PATH } : {}), ...githubGitEnvironment(this.#githubCredentials.get(this.owner(id))) };
    const command = ['/usr/bin/python3', '-I', '/opt/new-api-codex/workspace-process.py', 'run', assertWorkspaceId(processId),
      '/usr/local/bin/codex', '-c', 'model_provider="newapi"', '-c', `model_providers.newapi=${provider}`, '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="on-request"', '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', 'app-server', '--listen', 'stdio://'];
    const values = JSON.stringify({ ...projectEnv, NEW_API_KEY: apiKey });
    if (mode === 'ask') {
      const owner = this.owner(id), user = userPaths(this.dataDir,owner), resources = this.resources(owner);
      const args = ['run','--rm','-i','--name',this.readonlyName(owner,processId),'--label',`${READONLY_SCOPE_LABEL}=${this.readonlyScope}`,
        '--user','1000:1000','--workdir',this.cwd(id),'--network',this.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','256','--cpus',String(resources.cpuQuota),'--memory',String(resources.memoryBytes),'--memory-swap',String(resources.memoryBytes),
        '--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777','--tmpfs','/run:rw,nosuid,nodev,noexec,size=16m',
        '--mount',`type=bind,src=${user.projectsPath},dst=/workspace/projects,readonly`,'--mount',`type=bind,src=${user.homePath},dst=/home/codex`,
        this.image,'/usr/bin/python3','-I','-c',STDIN_ENVIRONMENT_LAUNCHER,...command];
      const child = this.spawnImpl('docker',args,{stdio:['pipe','pipe','pipe'],env:ENVIRONMENT});
      // Never store model/GitHub secrets in Docker config or command arguments.
      child.stdin.write(values+'\n');
      return child;
    }
    const args = ['exec', '-i', '--user', '1000:1000', '--workdir', this.cwd(id), '--env', RUNTIME_ENV_KEY,
      this.name(this.owner(id)), '/usr/bin/python3', '-I', '-c', ENVIRONMENT_LAUNCHER,...command];
    return this.spawnImpl('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENVIRONMENT, [RUNTIME_ENV_KEY]:values } });
  }

  async stopAppServer(id, { processId = id } = {}) {
    const ownerId = this.owner(id);
    const readonlyName = this.readonlyName(ownerId, processId), readonly = await this.inspectName(readonlyName);
    if (readonly) {
      if (readonly.Config?.Labels?.[READONLY_SCOPE_LABEL] !== this.readonlyScope) throw workspaceError('Read-only task identity changed','unsafe_container',409);
      const result = await this.command('docker',['rm','--force',readonlyName]);
      if (result.code) throw workspaceError('Read-only task could not stop','runtime_stop_failed',503);
      return {stopped:true};
    }
    const info = await this.inspectUser(ownerId);
    if (!info?.State?.Running) return { stopped: true };
    const result = await this.command('docker', ['exec', '--user', '1000:1000', this.name(ownerId), '/usr/bin/python3', '-I', '/opt/new-api-codex/workspace-process.py', 'stop', processId], { timeoutMs: 15_000, maxBytes: 128 * 1024 });
    if (result.code) throw workspaceError('Project process could not be stopped', 'runtime_stop_failed', 503);
    return { stopped: true };
  }
  async userDiskUsage(ownerId) {
    const { root } = userPaths(this.dataDir, ownerId); await fs.lstat(root);
    // Builds and package installs can remove files while du scans them. Retry
    // a failed scan instead of treating one transient failure as a full disk.
    // Never accept a partial measurement or bypass the actual storage quota.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.command('du', ['--summarize', '--bytes', '--one-file-system', '--', root], { timeoutMs: 10_000, maxBytes: 4096 });
      const bytes = Number.parseInt(result.stdout, 10);
      if (!result.code && Number.isSafeInteger(bytes) && bytes >= 0) return { bytes, limit: this.resources(ownerId).workspaceBytes };
    }
    throw workspaceError('Environment storage could not be measured', 'storage_unavailable', 503);
  }
  diskUsage(id) { return this.userDiskUsage(this.owner(id)); }
  enforceDiskLimit(id) { return this.enforceUserDiskLimit(this.owner(id)); }
  async enforceUserDiskLimit(ownerId) {
    const usage = await this.userDiskUsage(ownerId);
    try { await this.checkDisk(); } catch (error) { await this.stopUser(ownerId); throw error; }
    if (usage.bytes > usage.limit) { await this.stopUser(ownerId); throw workspaceError('User environment exceeded its shared storage limit and has been stopped', 'workspace_storage_limit', 507); }
    return usage;
  }
  async dockerStop(name) { const result = await this.command('docker', ['stop', '--time', '10', name], { timeoutMs: 20_000, maxBytes: 128 * 1024 }); if (result.code) throw workspaceError('User environment could not be stopped', 'runtime_stop_failed', 503); }
  stop(id) { return this.stopUser(this.owner(id)); }
  async stopUser(ownerId) { this.invalidate(assertOwnerId(ownerId)); try { return await this.lock(ownerId, async () => { const info = await this.inspectUser(ownerId); if (info?.State?.Running) await this.dockerStop(this.name(ownerId)); return { stopped: true }; }); } finally { this.invalidate(ownerId); } }
  async removeUser(ownerId) {
    return this.lock(ownerId, async () => {
      const info = await this.inspectUser(ownerId); if (!info) return { removed: true };
      if (info.State?.Running) await this.dockerStop(this.name(ownerId));
      const result = await this.command('docker', ['rm', this.name(ownerId)], { timeoutMs: 20_000, maxBytes: 128 * 1024 });
      if (result.code) throw workspaceError('User environment could not be removed', 'runtime_remove_failed', 503);
      this.cache.delete(ownerId); return { removed: true };
    });
  }
}
