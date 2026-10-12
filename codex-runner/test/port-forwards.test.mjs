import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PortForwardManager } from '../port-forwards.mjs';
import { PortTools } from '../port-tools.mjs';
import { AccountTools } from '../account-tools.mjs';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-frp-test-'));
  const token = 'a'.repeat(64), tokenFile = path.join(dataDir, 'token'), configFile = path.join(dataDir, 'config.json');
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(configFile, JSON.stringify({ publicHost: 'preview.example', publicBindAddr: '203.0.113.10', serverHost: '172.31.240.1', serverPort: 7430, adminPort: 7401, portStart: 34000, portEnd: 34100, frpc: path.join(dataDir, 'frpc'), tokenFile }), { mode: 0o600 });
  const units = new Set(), calls = [], running = new Map([[1, true], [2, true]]);
  let firewallPorts = [], failReload = false;
  const command = async (program, args, options = {}) => {
    calls.push({ program, args, options });
    if (program.endsWith('/systemctl')) {
      if (args[0] === 'list-units') return { code: 0, stdout: [...units].map(unit => `${unit} loaded active running`).join('\n') };
      if (args[0] === 'show') return { code: 0, stdout: units.has(args[1]) ? 'loaded' : 'not-found' };
      if (args[0] === 'stop') { units.delete(args[1]); return { code: 0, stdout: '' }; }
      if (args[0] === 'is-active') return { code: units.has(args[1]) ? 0 : 3, stdout: units.has(args[1]) ? 'active' : 'inactive' };
    }
    if (program.endsWith('/systemd-run')) {
      const unit = args.find(arg => arg.startsWith('--unit='));
      if (unit) units.add(unit.slice(7));
      if (args.includes('reload') && failReload) { failReload = false; return { code: 1, stderr: token, stdout: '' }; }
      return { code: 0, stdout: '{"ready":true}' };
    }
    if (program.endsWith('/iptables-restore')) firewallPorts = [...options.input.matchAll(/--dport (\d+)/g)].map(match => Number(match[1]));
    return { code: 0, stdout: '', stderr: '' };
  };
  const runtime = { inspectUser: async owner => ({ Id: `owned-container-${owner}`, State: { Running: running.get(owner), Pid: owner + 100 } }) };
  const create = () => new PortForwardManager({ dataDir, configFile, runtime, command, portAvailable: async port => port !== 34000 });
  const ports = create(); await ports.initialize();
  t.after(async () => { await ports.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, ports, create, calls, running, token, firewallPorts: () => firewallPorts, failNextReload: () => { failReload = true; } };
}

test('public allocations are unique across containers, capped at ten and idempotent for the same local port', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.ports.open(1, { localPort: 3000 }), f.ports.open(2, { localPort: 3000 })]);
  assert.notEqual(first.port.remotePort, second.port.remotePort);
  assert.notEqual(first.port.remotePort, 34000);
  const same = await f.ports.open(1, { localPort: 3000 });
  assert.equal(same.port.id, first.port.id);
  for (const localPort of [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009]) await f.ports.open(1, { localPort });
  await assert.rejects(f.ports.open(1, { localPort: 3010 }), { code: 'port_quota_exceeded' });
  assert.equal((await f.ports.list(1)).used, 10);
  assert.equal((await f.ports.list(2)).used, 1);
  await f.ports.remove(1, first.port.id);
  assert.equal((await f.ports.open(1, { localPort: 3010 })).used, 10);
});

test('only the owner can close a mapping and credentials never appear in tool results or process arguments', async t => {
  const f = await fixture(t);
  const first = await f.ports.open(1, { localPort: 8080, label: 'Preview' });
  await assert.rejects(f.ports.remove(2, first.port.id), { code: 'port_forward_not_found' });
  const result = await f.ports.list(1);
  assert.equal(result.ports[0].label, 'Preview');
  assert.equal(JSON.stringify(result).includes(f.token), false);
  assert.equal(JSON.stringify(f.calls.map(call => call.args)).includes(f.token), false);
  for (const input of [{ localPort: 7401 }, { localPort: 0 }, { localPort: 65536 }, { localPort: 80, ownerId: 2 }, { localPort: 80, localIP: '127.0.0.1' }, { localPort: 80, label: '\nprivate' }]) await assert.rejects(f.ports.open(1, input), { code: 'invalid_port_forward' });
  assert.deepEqual(f.firewallPorts(), [first.port.remotePort]);
});

test('a failed proxy reload rolls back the new allocation and firewall, preserving the existing public service', async t => {
  const f = await fixture(t);
  const existing = await f.ports.open(1, { localPort: 3000 });
  f.failNextReload();
  await assert.rejects(f.ports.open(1, { localPort: 8080 }), { code: 'port_forward_unavailable' });
  const result = await f.ports.list(1);
  assert.equal(result.used, 1);
  assert.equal(result.ports[0].id, existing.port.id);
  assert.equal(result.ports[0].status, 'running');
  assert.deepEqual(f.firewallPorts(), [existing.port.remotePort]);
});

test('allocations survive a runner restart and stopping the container removes firewall access while retaining configuration', async t => {
  const f = await fixture(t);
  const existing = await f.ports.open(1, { localPort: 3000 });
  const restarted = f.create(); await restarted.initialize();
  assert.equal((await restarted.list(1)).ports[0].id, existing.port.id);
  f.running.set(1, false); await restarted.reconcile();
  const stopped = await restarted.list(1);
  assert.equal(stopped.used, 1); assert.equal(stopped.ports[0].status, 'stopped');
  assert.deepEqual(f.firewallPorts(), []);
  await restarted.remove(1, existing.port.id);
  assert.equal((await restarted.list(1)).used, 0);
});

test('native port tools respect approval modes and recheck live Docker authorization before changing ports', async t => {
  const f = await fixture(t), responses = [], events = [];
  let allowDocker = true;
  const manager = { config: { apiBaseUrl: 'https://api.example/v1' }, modelSecrets: new Set(), ports: f.ports, sanitize: value => value, store: { record: (_state, type) => events.push(type), persist: async () => {} } };
  manager.accountTools = new AccountTools(manager, { fetchImpl: async () => new Response(JSON.stringify({ success: true, data: { tools: [], allowDocker } })) });
  manager.accountTools.accept(1, 'nact_fixture');
  const tools = new PortTools(manager), session = { rpc: { respond: (_id, value) => responses.push(value) }, toolAbort: new AbortController() };
  const state = { workspace: { ownerId: 1, mode: 'ask' }, pendingApprovals: [] };
  const message = { id: 1, params: { tool: 'codex_open_port', arguments: { localPort: 3000 } } };
  await tools.handle(state, session, message);
  assert.equal(JSON.parse(responses[0].contentItems[0].text).code, 'read_only');
  state.workspace.mode = 'code'; await tools.handle(state, session, { ...message, id: 2 });
  assert.equal(state.pendingApprovals[0].method, 'workbench/ports/approval');
  assert.equal((await f.ports.list(1)).used, 0);
  state.workspace.mode = 'auto'; await tools.handle(state, session, { ...message, id: 3 });
  assert.equal((await f.ports.list(1)).used, 1);
  allowDocker = false;
  await assert.rejects(tools.execute(1, 'codex_close_port', { id: (await f.ports.list(1)).ports[0].id }), { code: 'execution_disabled' });
  assert.equal((await f.ports.list(1)).used, 1);
  assert.ok(events.includes('workbench/ports/completed'));
});
