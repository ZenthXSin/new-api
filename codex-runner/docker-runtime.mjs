import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './workspace-files.mjs';
import { UserWorkspaceLayout, assertOwnerId, assertWorkspaceId, legacyWorkspacePaths, userPaths, workspaceError } from './user-layout.mjs';

const MANAGED_LABEL = 'new-api.codex.managed';
const OWNER_LABEL = 'new-api.codex.owner';
const VERSION_LABEL = 'new-api.codex.isolation-version';
const MODE_LABEL = 'new-api.codex.mode';
const ENVIRONMENT = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent' };

export class DockerRuntime {
  constructor({ dataDir, image = 'new-api:codex-user-environment-0.160.0', network = 'new-api-codex-workers', command = runCommand, spawnImpl = spawn, minFreeBytes = 1024 ** 3, workspaceBytes = 2 * 1024 ** 3, userBytes, statfs = fs.statfs }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,200}$/.test(image) || !/^new-api-codex-[a-z0-9-]+$/.test(network)) throw new Error('Invalid Codex runtime image or dedicated network');
    Object.assign(this, { dataDir: path.resolve(dataDir), image, network, command, spawnImpl, minFreeBytes, workspaceBytes: userBytes || workspaceBytes, statfs });
    this.layout = new UserWorkspaceLayout(this.dataDir);
    this.locks = new Map(); this.modes = new Map(); this.cache = new Map(); this.revisions = new Map(); this.diskCache = new Map(); this.migratedHomes = new Set();
  }
  registerWorkspace(id, ownerId) { this.layout.register(id, ownerId); }
  unregisterWorkspace(id) { this.layout.unregister(id); }
  owner(id) { return this.layout.owner(id); }
  name(ownerId) { return `new-api-codex-user-${assertOwnerId(ownerId)}`; }
  cwd(id) { return this.layout.paths(id).cwd; }
  async lock(ownerId, action) {
    assertOwnerId(ownerId);
    const previous = this.locks.get(ownerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(action); this.locks.set(ownerId, current);
    try { return await current; } finally { if (this.locks.get(ownerId) === current) this.locks.delete(ownerId); }
  }
  async initialize(workspaces) {
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
    const value = { container: this.name(ownerId), status: info ? info.State?.Running ? 'running' : 'stopped' : 'not_created', mode: info?.Config?.Labels?.[MODE_LABEL] || this.modes.get(ownerId) || 'code', diskBytes, diskLimitBytes: this.workspaceBytes, cpu: 2, memoryBytes: 2 * 1024 ** 3, idleSeconds: 600 };
    if (revision !== (this.revisions.get(ownerId) || 0)) return this.environment(ownerId);
    this.cache.set(ownerId, { time: Date.now(), value }); return { ...value };
  }
  start(id) { return this.startUser(this.owner(id)); }
  setMode(id, mode) { return this.startUser(this.owner(id), { mode }); }
  async startUser(ownerId, { mode } = {}) {
    if (mode !== undefined && !['code', 'ask'].includes(mode)) throw workspaceError('Invalid environment mode', 'invalid_mode');
    assertOwnerId(ownerId); this.invalidate(ownerId);
    try { return await this.lock(ownerId, async () => {
      await this.checkDisk();
      const user = await this.layout.ensureUser(ownerId);
      let existing = await this.inspectUser(ownerId);
      const desired = mode || existing?.Config?.Labels?.[MODE_LABEL] || this.modes.get(ownerId) || 'code';
      if (existing && existing.Config.Labels[MODE_LABEL] !== desired) {
        if (existing.State?.Running) await this.dockerStop(this.name(ownerId));
        const removal = await this.command('docker', ['rm', this.name(ownerId)], { timeoutMs: 20_000, maxBytes: 128 * 1024 });
        if (removal.code) throw workspaceError('Environment mode could not be changed', 'runtime_remove_failed', 503);
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
          '--cpus', '2', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '256', '--ulimit', 'nofile=4096:4096',
          '--network', this.network, '--dns', '1.1.1.1', '--dns', '8.8.8.8', '--ipc', 'private',
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', '/run:rw,nosuid,nodev,noexec,size=16m',
          '--mount', `type=bind,src=${user.projectsPath},dst=/workspace/projects${desired === 'ask' ? ',readonly' : ''}`, '--mount', `type=bind,src=${user.homePath},dst=/home/codex`,
          '--workdir', '/workspace/projects', '--env', 'HOME=/home/codex/user', '--env', 'LANG=C.UTF-8', '--env', 'NODE_OPTIONS=--max-old-space-size=1024',
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
  async exec(id, argv, { input, timeoutMs = 100_000, maxBytes = 4 * 1024 * 1024, env = {} } = {}) {
    await this.layout.check(id); await this.start(id);
    const mergedEnv = { ...this.projectEnv(id), ...env };
    const arguments_ = ['exec', '-i', '--user', '1000:1000', '--workdir', this.cwd(id)];
    for (const name of Object.keys(mergedEnv)) { if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw workspaceError('Invalid runtime environment variable'); arguments_.push('--env', name); }
    arguments_.push(this.name(this.owner(id)), '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`, ...argv);
    return this.command('docker', arguments_, { input, env: { ...ENVIRONMENT, ...mergedEnv }, timeoutMs: timeoutMs + 10_000, maxBytes });
  }
  async gitOperation(id, operation, args = {}) {
    const result = await this.exec(id, ['python3', '-I', '/opt/new-api-codex/workspace-git.py'], { input: JSON.stringify({ operation, ...args }), timeoutMs: operation === 'clone' ? 105_000 : 45_000, maxBytes: 5 * 1024 * 1024 });
    let response; try { response = JSON.parse(result.stdout); } catch { throw workspaceError('Git operation could not be completed', 'git_failed', 500); }
    if (!response.ok) throw workspaceError(response.error || 'Git operation failed', 'git_failed', 400);
    return response.result;
  }
  baseline(id) { return this.gitOperation(id, 'baseline'); }
  diff(id) { return this.gitOperation(id, 'diff'); }
  clone(id, repository) { return this.gitOperation(id, 'clone', repository); }
  async spawnAppServer(id, { env = {}, mode = 'code' } = {}) {
    const apiKey = env.NEW_API_KEY;
    let baseUrl; try { baseUrl = new URL(env.NEW_API_BASE_URL); } catch { throw workspaceError('Model provider is not configured', 'model_not_configured', 503); }
    if (!apiKey || typeof apiKey !== 'string' || /[\r\n\x00]/.test(apiKey) || !['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw workspaceError('Model provider configuration is invalid', 'model_not_configured', 503);
    await this.setMode(id, mode); await this.layout.check(id);
    if (!this.migratedHomes.has(id)) {
      const result = await this.exec(id, ['python3', '-I', '/opt/new-api-codex/migrate-codex-home.py', id], { maxBytes: 1024 * 1024 });
      if (result.code) throw workspaceError('Codex history migration failed; the original files are preserved', 'history_migration_failed', 503);
      this.migratedHomes.add(id);
    }
    const provider = `{name="New API",base_url=${JSON.stringify(baseUrl.href.replace(/\/$/, ''))},env_key="NEW_API_KEY",wire_api="responses",request_max_retries=2,stream_max_retries=2}`;
    const projectEnv = this.projectEnv(id), args = ['exec', '-i', '--user', '1000:1000', '--workdir', this.cwd(id), '--env', 'NEW_API_KEY'];
    for (const name of Object.keys(projectEnv)) args.push('--env', name);
    args.push(this.name(this.owner(id)), 'python3', '-I', '/opt/new-api-codex/workspace-process.py', 'run', id,
      'codex', '-c', 'model_provider="newapi"', '-c', `model_providers.newapi=${provider}`, '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="on-request"', '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false', 'app-server', '--listen', 'stdio://');
    return this.spawnImpl('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENVIRONMENT, ...projectEnv, NEW_API_KEY: apiKey } });
  }
  async stopAppServer(id) {
    const ownerId = this.owner(id), info = await this.inspectUser(ownerId);
    if (!info?.State?.Running) return { stopped: true };
    const result = await this.command('docker', ['exec', '--user', '1000:1000', this.name(ownerId), 'python3', '-I', '/opt/new-api-codex/workspace-process.py', 'stop', id], { timeoutMs: 15_000, maxBytes: 128 * 1024 });
    if (result.code) throw workspaceError('Project process could not be stopped', 'runtime_stop_failed', 503);
    return { stopped: true };
  }
  async userDiskUsage(ownerId) {
    const { root } = userPaths(this.dataDir, ownerId); await fs.lstat(root);
    const result = await this.command('du', ['--summarize', '--bytes', '--one-file-system', '--', root], { timeoutMs: 10_000, maxBytes: 4096 });
    const bytes = Number.parseInt(result.stdout, 10);
    if (result.code || !Number.isSafeInteger(bytes)) throw workspaceError('Environment storage could not be measured', 'storage_unavailable', 503);
    return { bytes, limit: this.workspaceBytes };
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
