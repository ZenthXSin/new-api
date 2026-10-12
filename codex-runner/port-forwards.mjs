import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { runCommand } from './workspace-files.mjs';
import { assertOwnerId } from './user-layout.mjs';
import { apiError } from './store.mjs';

export const PORT_LIMIT = 10;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATUS = `import base64,json,time,urllib.request,sys
r=json.load(sys.stdin)
expected=set(r['names'])
for attempt in range(30):
 try:
  req=urllib.request.Request('http://127.0.0.1:'+str(r['port'])+'/api/status')
  req.add_header('Authorization','Basic '+base64.b64encode(('codex:'+r['password']).encode()).decode())
  with urllib.request.urlopen(req,timeout=1) as response: data=json.load(response)
  running={p['name'] for p in data.get('tcp',[]) if p.get('status')=='running'}
  if running==expected:
   print(json.dumps({'ready':True}));raise SystemExit(0)
 except Exception: pass
 time.sleep(0.15)
print(json.dumps({'ready':False}));raise SystemExit(1)
`;

export class PortForwardManager {
  constructor({ dataDir, runtime, configFile = '', command = runCommand, portAvailable } = {}) {
    this.directory = path.join(dataDir, 'ports');
    this.runtime = runtime;
    this.configFile = configFile;
    this.command = command;
    this.portAvailable = portAvailable || (port => new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
    }));
    this.prefix = `new-api-codex-frpc-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}-`;
    this.mappings = [];
    this.online = new Map();
    this.tail = Promise.resolve();
  }
  get enabled() { return Boolean(this.config); }
  lock(action) {
    const next = this.tail.catch(() => {}).then(action);
    this.tail = next;
    return next;
  }
  async checked(command, args, options) {
    const result = await this.command(command, args, options);
    if (result.code) throw apiError(503, 'port_forward_unavailable', 'The port forwarding service is unavailable');
    return result;
  }
  unit(owner) { return `${this.prefix}${assertOwnerId(owner)}.service`; }
  async initialize() {
    if (!this.configFile) return;
    const info = await fs.stat(this.configFile);
    if (info.mode & 0o022 || info.size > 8192 || info.uid !== process.getuid()) throw new Error('Unsafe FRP configuration');
    const config = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
    if (!net.isIPv4(config.serverHost) || !/^[a-zA-Z0-9.-]{1,253}$/.test(config.publicHost) || !Number.isInteger(config.serverPort) || config.serverPort < 1024 || config.serverPort > 65535 || !Number.isInteger(config.adminPort) || config.adminPort < 1024 || config.adminPort > 65535 || !Number.isInteger(config.portStart) || !Number.isInteger(config.portEnd) || config.portStart < 1024 || config.portEnd > 65535 || config.portEnd < config.portStart || config.portEnd - config.portStart > 20000 || [config.frpc, config.tokenFile].some(value => typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => ['.', '..'].includes(part)))) throw new Error('Invalid FRP configuration');
    if (!net.isIPv4(config.publicBindAddr)) throw new Error('Invalid FRP public bind address');
    this.config = config;
    const tokenInfo = await fs.stat(config.tokenFile);
    if (tokenInfo.mode & 0o077 || tokenInfo.size > 256 || tokenInfo.uid !== process.getuid()) throw new Error('Unsafe FRP credential');
    this.token = (await fs.readFile(config.tokenFile, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('Invalid FRP credential');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.suspendAll();
    try {
      const stat = await fs.stat(path.join(this.directory, 'state.json'));
      if (stat.size > 2 * 1024 * 1024 || stat.mode & 0o077) throw new Error('Unsafe port forwarding state');
      const state = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.mappings)) throw new Error('Invalid port forwarding state');
      const ports = new Set(), ids = new Set(), owners = new Map(), localPorts = new Set();
      for (const mapping of state.mappings) {
        assertOwnerId(mapping.ownerId);
        this.validateOpen({ localPort: mapping.localPort, label: mapping.label });
        if (!UUID.test(mapping.id) || ids.has(mapping.id) || ports.has(mapping.remotePort) || localPorts.has(`${mapping.ownerId}:${mapping.localPort}`) || !Number.isInteger(mapping.remotePort) || mapping.remotePort < config.portStart || mapping.remotePort > config.portEnd || !Number.isFinite(mapping.createdAt)) throw new Error('Invalid port forwarding allocation');
        localPorts.add(`${mapping.ownerId}:${mapping.localPort}`);
        ids.add(mapping.id); ports.add(mapping.remotePort);
        owners.set(mapping.ownerId, (owners.get(mapping.ownerId) || 0) + 1);
        if (owners.get(mapping.ownerId) > PORT_LIMIT) throw new Error('Port forwarding quota exceeded');
      }
      this.mappings = state.mappings;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.reconcile();
  }
  validateOpen(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['localPort', 'label'].includes(k)) || !Number.isInteger(input.localPort) || input.localPort < 1 || input.localPort > 65535 || input.localPort === this.config.adminPort || input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 80 || /[\x00-\x1f\x7f]/.test(input.label))) throw apiError(400, 'invalid_port_forward', 'Supply a local TCP port between 1 and 65535 and an optional label; the internal FRP administration port is reserved');
  }
  async persist() {
    const temporary = path.join(this.directory, `state-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify({ version: 1, mappings: this.mappings }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(this.directory, 'state.json'));
  }
  async firewall() {
    const { portStart, portEnd } = this.config;
    await this.command('/usr/sbin/iptables', ['-w', '-N', 'NEWAPI_CODEX_FRP']);
    const jump = ['INPUT', '-d', this.config.publicBindAddr, '-p', 'tcp', '--dport', `${portStart}:${portEnd}`, '-j', 'NEWAPI_CODEX_FRP'];
    const exists = await this.command('/usr/sbin/iptables', ['-w', '-C', ...jump]);
    if (exists.code) await this.checked('/usr/sbin/iptables', ['-w', '-I', 'INPUT', '1', ...jump.slice(1)]);
    // One atomic transaction replaces only our chain. Unallocated ports remain
    // denied; Docker, SSH and site firewall rules are never flushed.
    const rules = ['*filter', ':NEWAPI_CODEX_FRP - [0:0]', '-F NEWAPI_CODEX_FRP'];
    for (const entry of this.mappings) if (this.online.has(entry.ownerId)) rules.push(`-A NEWAPI_CODEX_FRP -p tcp --dport ${entry.remotePort} -m comment --comment codex-frp-${entry.ownerId} -j ACCEPT`);
    rules.push('-A NEWAPI_CODEX_FRP -p tcp -j REJECT --reject-with tcp-reset', 'COMMIT', '');
    await this.checked('/usr/sbin/iptables-restore', ['-w', '--noflush'], { input: rules.join('\n') });
  }
  async stop(owner) {
    const loaded = await this.checked('/usr/bin/systemctl', ['show', this.unit(owner), '--property=LoadState', '--value']);
    if (loaded.stdout.trim() !== 'not-found') await this.checked('/usr/bin/systemctl', ['stop', this.unit(owner)]);
    this.online.delete(owner);
  }
  async suspendAll() {
    const units = await this.checked('/usr/bin/systemctl', ['list-units', '--all', '--type=service', '--plain', '--no-legend', `${this.prefix}*.service`]);
    for (const line of units.stdout.trim().split('\n').filter(Boolean)) {
      const unit = line.trim().split(/\s+/)[0];
      if (!unit.startsWith(this.prefix) || !/^[a-z0-9-]+\.service$/.test(unit)) throw new Error('Invalid FRP unit identity');
      await this.checked('/usr/bin/systemctl', ['stop', unit]);
    }
    this.online.clear();
    await this.firewall();
  }
  async apply(owner, entries) {
    const container = await this.runtime.inspectUser(owner);
    const running = container?.State?.Running && Number.isInteger(container.State.Pid) && container.State.Pid > 1;
    if (!running || !entries.length) {
      await this.stop(owner);
      return;
    }
    const identity = `${container.Id}:${container.State.Pid}`;
    const directory = path.join(this.directory, String(owner));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const passwordFile = path.join(directory, 'admin-secret');
    let password;
    try { password = (await fs.readFile(passwordFile, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; password = randomBytes(32).toString('hex'); await fs.writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' }); }
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid FRP administration credential');
    const proxies = entries.map(entry => ({ name: `codex-${owner}-${entry.id}`, type: 'tcp', localIP: '127.0.0.1', localPort: entry.localPort, remotePort: entry.remotePort }));
    const configuration = { serverAddr: this.config.serverHost, serverPort: this.config.serverPort, auth: { method: 'token', token: this.token, additionalScopes: ['HeartBeats', 'NewWorkConns'] }, transport: { tls: { enable: true } }, webServer: { addr: '127.0.0.1', port: this.config.adminPort, user: 'codex', password }, log: { to: 'console', level: 'warn' }, proxies };
    const file = path.join(directory, 'frpc.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    const namespace = `NetworkNamespacePath=/proc/${container.State.Pid}/ns/net`;
    const active = await this.command('/usr/bin/systemctl', ['is-active', this.unit(owner)]);
    if (this.online.get(owner) === identity && !active.code) {
      await this.checked('/usr/bin/systemd-run', ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--property=${namespace}`, this.config.frpc, 'reload', '-c', file]);
    } else {
      await this.stop(owner);
      await this.checked('/usr/bin/systemd-run', ['--quiet', '--collect', '--service-type=exec', `--unit=${this.unit(owner)}`, `--property=${namespace}`, '--property=KillMode=control-group', '--property=Restart=on-failure', '--property=RestartSec=3', '--property=ProtectSystem=strict', '--property=ProtectHome=yes', '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes', '--property=MemoryMax=96M', '--property=CPUQuota=25%', '--property=TasksMax=64', this.config.frpc, '-c', file]);
    }
    await this.checked('/usr/bin/systemd-run', ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--property=${namespace}`, '/usr/bin/python3', '-I', '-c', STATUS], { input: JSON.stringify({ password, port: this.config.adminPort, names: proxies.map(proxy => proxy.name) }), timeoutMs: 40_000, maxBytes: 8192 });
    this.online.set(owner, identity);
  }
  public(entry) {
    return { id: entry.id, localPort: entry.localPort, remotePort: entry.remotePort, publicHost: this.config.publicHost, address: `${this.config.publicHost}:${entry.remotePort}`, protocol: 'tcp', label: entry.label || '', status: this.online.has(entry.ownerId) ? 'running' : 'stopped', createdAt: entry.createdAt };
  }
  async list(owner) {
    assertOwnerId(owner);
    return this.lock(async () => {
      if (!this.enabled) return { available: false, limit: PORT_LIMIT, used: 0, ports: [] };
      await this.reconcileOwner(owner);
      const entries = this.mappings.filter(entry => entry.ownerId === owner);
      return { available: true, limit: PORT_LIMIT, used: entries.length, ports: entries.map(entry => this.public(entry)) };
    });
  }
  async open(owner, input, signal) {
    assertOwnerId(owner);
    return this.lock(async () => {
      if (!this.enabled) throw apiError(503, 'port_forward_unavailable', 'FRP port forwarding is not configured');
      this.validateOpen(input);
      if (signal?.aborted) throw apiError(409, 'operation_canceled', 'The port request was canceled');
      const container = await this.runtime.inspectUser(owner);
      if (!container?.State?.Running) throw apiError(409, 'environment_stopped', 'Start your Docker environment before opening ports');
      const entries = this.mappings.filter(entry => entry.ownerId === owner);
      const duplicate = entries.find(entry => entry.localPort === input.localPort);
      if (duplicate) { await this.reconcileOwner(owner); return { port: this.public(duplicate), limit: PORT_LIMIT, used: entries.length }; }
      if (entries.length >= PORT_LIMIT) throw apiError(409, 'port_quota_exceeded', 'Each Docker container can expose at most 10 ports; close a port before opening another');
      const taken = new Set(this.mappings.map(entry => entry.remotePort));
      let remotePort;
      for (let port = this.config.portStart; port <= this.config.portEnd; port++) if (!taken.has(port) && await this.portAvailable(port)) { remotePort = port; break; }
      if (!remotePort) throw apiError(503, 'port_pool_exhausted', 'No public ports are currently available');
      const entry = { id: randomUUID(), ownerId: owner, localPort: input.localPort, remotePort, label: input.label || '', createdAt: Date.now() };
      const previous = this.mappings;
      this.mappings = [...previous, entry];
      try {
        await this.persist();
        await this.apply(owner, [...entries, entry]);
        if (signal?.aborted) throw apiError(409, 'operation_canceled', 'The port request was canceled');
        await this.firewall();
      } catch (error) {
        this.mappings = previous;
        await this.persist();
        await this.apply(owner, entries).catch(async () => { this.online.delete(owner); await this.command('/usr/bin/systemctl', ['stop', this.unit(owner)]); });
        await this.firewall();
        throw error;
      }
      return { port: this.public(entry), limit: PORT_LIMIT, used: entries.length + 1 };
    });
  }
  async remove(owner, id) {
    assertOwnerId(owner);
    if (typeof id !== 'string' || !UUID.test(id)) throw apiError(400, 'invalid_port_forward', 'Supply a port mapping id');
    return this.lock(async () => {
      if (!this.enabled) throw apiError(503, 'port_forward_unavailable', 'FRP port forwarding is not configured');
      const entry = this.mappings.find(entry => entry.ownerId === owner && entry.id === id);
      if (!entry) throw apiError(404, 'port_forward_not_found', 'Port mapping not found');
      const previous = this.mappings;
      this.mappings = previous.filter(mapping => mapping !== entry);
      try {
        await this.persist();
        await this.apply(owner, this.mappings.filter(mapping => mapping.ownerId === owner));
        await this.firewall();
      } catch (error) {
        this.mappings = previous; await this.persist();
        await this.apply(owner, previous.filter(mapping => mapping.ownerId === owner)).catch(async () => { this.online.delete(owner); await this.command('/usr/bin/systemctl', ['stop', this.unit(owner)]); });
        await this.firewall(); throw error;
      }
      return { closed: true, id, limit: PORT_LIMIT, used: this.mappings.filter(mapping => mapping.ownerId === owner).length };
    });
  }
  async reconcileOwner(owner) {
    const entries = this.mappings.filter(entry => entry.ownerId === owner);
    const container = await this.runtime.inspectUser(owner);
    const identity = container?.State?.Running ? `${container.Id}:${container.State.Pid}` : null;
    const active = this.online.has(owner) ? await this.command('/usr/bin/systemctl', ['is-active', this.unit(owner)]) : { code: 1 };
    if (identity !== this.online.get(owner) || active.code && entries.length) {
      await this.apply(owner, entries);
      await this.firewall();
    }
  }
  async reconcile() {
    if (!this.enabled) return;
    for (const owner of new Set(this.mappings.map(entry => entry.ownerId))) {
      try { await this.reconcileOwner(owner); }
      catch {
        await this.stop(owner);
        await this.firewall();
        console.warn(`Port forwarding unavailable for container owner ${owner}`);
      }
    }
  }
  async close() { if (this.enabled) await this.lock(() => this.suspendAll()); }
}
