import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { RemoteRuntime } from './remote-runtime.mjs';
import { runCommand } from './workspace-files.mjs';

// Keep credentials in stdin, never in systemd unit arguments or environment
// properties. The launcher consumes precisely one line before handing the
// original operation/JSON-RPC stream to the checked helper.
const HOST_LAUNCHER = `import os,sys,json
header=bytearray()
while True:
 b=os.read(0,1)
 if b==b'\\n': break
 if not b or len(header)>262144: raise SystemExit(2)
 header.extend(b)
os.environ.clear()
os.environ.update(json.loads(header))
os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
`;

// Reuse the checked file operations and per-conversation process cleanup. The
// transport starts processes on the runner host; it never invokes Docker/SSH.
export class HostRuntime extends RemoteRuntime {
  constructor({ dataDir, command = runCommand, spawnImpl = spawn, home = os.homedir(), systemd = false, ...options }) {
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' };
    const prefix = `new-api-codex-host-${createHash('sha256').update(dataDir).digest('hex').slice(0,12)}-`;
    const connections = {
      initialize: async () => {},
      get: async () => ({ id: 'host' }),
      exec: (_owner, _connection, argv, settings = {}) => {
        if (!systemd) return command(argv[0], argv.slice(1), { ...settings, env: { ...env, ...settings.env } });
        return command('/usr/bin/systemd-run', ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--unit=${prefix}${randomUUID()}`, '--property=KillMode=control-group', '/usr/bin/python3', '-I', '-c', HOST_LAUNCHER, ...argv], {
          ...settings, env,
          input: Buffer.concat([Buffer.from(JSON.stringify({...env,...settings.env})+'\n'), Buffer.from(settings.input || '')]),
        });
      },
      spawn: async (_owner, _connection, argv) => {
        if (!systemd) return spawnImpl(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
        const child = spawnImpl('/usr/bin/systemd-run', ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--unit=${prefix}${randomUUID()}`, '--property=KillMode=control-group', '/usr/bin/python3', '-I', '-c', HOST_LAUNCHER, ...argv], {env,stdio:['pipe','pipe','pipe']});
        child.stdin.write(JSON.stringify(env)+'\n');
        return child;
      },
    };
    super({ dataDir, command, connections, ...options });
    this.systemd = systemd;
    this.unitPrefix = prefix;
  }
  registerWorkspace(id, ownerId, host) {
    super.registerWorkspace(id, ownerId, { connectionId: 'host', path: host.path });
  }
  async initialize(workspaces) {
    if (this.systemd) {
      const result = await this.command('/usr/bin/systemctl',['list-units','--all','--type=service','--plain','--no-legend',`${this.unitPrefix}*.service`]);
      if (result.code) throw new Error('Host process cleanup could not be checked');
      for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
        const unit = line.trim().split(/\s+/)[0];
        if (!unit.startsWith(this.unitPrefix) || !/^[a-z0-9-]+\.service$/.test(unit)) throw new Error('Invalid host task identity');
        const stopped = await this.command('/usr/bin/systemctl',['stop',unit],{timeoutMs:20_000});
        if (stopped.code) throw new Error('A previous host process could not be stopped');
      }
    }
    for (const workspace of workspaces) this.registerWorkspace(workspace.id, workspace.ownerId, workspace.host);
  }
  async create(id) {
    await this.prepare(id);
    // Check the chosen existing directory before recording a project.
    await this.list(id);
    return { id, host: { path: this.cwd(id) } };
  }
}
