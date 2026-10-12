import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SshConnections } from '../ssh-connections.mjs';
import { runCommand } from '../workspace-files.mjs';

const realSshAvailable = process.getuid?.() === 0 && existsSync('/usr/sbin/sshd') && existsSync('/usr/bin/ssh-keygen') && existsSync('/run/sshd');
const realSshOptions = { skip: !realSshAvailable && 'Isolated SSH integration tests need sshd, ssh-keygen, /run/sshd and root', timeout: 30_000 };

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ssh-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await readFiles(filename));
    else if (entry.isFile()) result.push({ filename, content: await fs.readFile(filename), mode: (await fs.stat(filename)).mode & 0o777 });
  }
  return result;
}

async function waitForSsh(port, daemon, getErrors) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`Isolated sshd exited: ${getErrors()}`);
    const connected = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(20);
  }
  throw new Error(`Isolated sshd did not start: ${getErrors()}`);
}

async function assertTemporaryCredentialsRemoved(dataDir) {
  const directory = path.join(dataDir, 'ssh-connections', 'operations');
  const deadline = Date.now() + 2000;
  let entries;
  do {
    entries = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    if (entries.length === 0) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.deepEqual(entries, [], 'SSH operation credentials must be removed after the process finishes');
}

async function sshFixture(t) {
  const directory = await temporaryDirectory(t);
  const dataDir = path.join(directory, 'state');
  const keys = {};
  for (const name of ['host', 'replacement-host', 'client', 'unauthorized-client']) {
    keys[name] = path.join(directory, name);
    const generated = await runCommand('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `codex-isolated-${name}`, '-f', keys[name]]);
    assert.equal(generated.code, 0, generated.stderr);
  }
  const authorizedKeys = path.join(directory, 'authorized_keys');
  await fs.copyFile(`${keys.client}.pub`, authorizedKeys);
  await fs.chmod(authorizedKeys, 0o600);
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const configFile = path.join(directory, 'sshd_config');
  let daemon;
  const stop = async () => {
    if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
    const finished = once(daemon, 'close');
    try { process.kill(-daemon.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await finished;
  };
  t.after(stop);
  const start = async (hostKey = keys.host) => {
    await fs.writeFile(configFile, [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`,
      `PidFile ${path.join(directory, 'sshd.pid')}`, `AuthorizedKeysFile ${authorizedKeys}`,
      'PermitRootLogin yes', 'PubkeyAuthentication yes', 'PasswordAuthentication no',
      // The fixture keeps its root-owned credentials beneath /tmp, whose sticky
      // world-writable parent fails sshd StrictModes despite the private leaf.
      'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'AllowUsers root',
      'AllowTcpForwarding no', 'AllowAgentForwarding no', 'X11Forwarding no',
      'PrintMotd no', 'PrintLastLog no', 'LogLevel ERROR',
    ].join('\n') + '\n', { mode: 0o600 });
    let errors = '';
    daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', configFile], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    await waitForSsh(port, daemon, () => errors);
  };
  await start();
  const calls = [];
  const spawnCalls = [];
  const command = async (program, args, options) => {
    calls.push({ program, args: [...args], options });
    return runCommand(program, args, options);
  };
  const connections = new SshConnections({ dataDir, allowPrivate: true, command, spawnImpl: (program, args, options) => {
    spawnCalls.push({ program, args: [...args], options });
    return spawn(program, args, options);
  } });
  await connections.initialize();
  const privateKey = await fs.readFile(keys.client, 'utf8');
  const publicKey = await fs.readFile(`${keys.host}.pub`, 'utf8');
  const fingerprintResult = await runCommand('/usr/bin/ssh-keygen', ['-lf', `${keys.host}.pub`, '-E', 'sha256']);
  assert.equal(fingerprintResult.code, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.trim().split(/\s+/)[1];
  const profileInput = { name: '隔离 SSH 测试', host: '127.0.0.1', port, username: 'root', authType: 'key', privateKey, fingerprint };
  return { directory, dataDir, keys, publicKey, connections, profileInput, privateKey, calls, spawnCalls, restart: async () => { await stop(); await start(keys['replacement-host']); } };
}

test('SSH discovery rejects private or mixed DNS targets before contacting them', async (t) => {
  const dataDir = await temporaryDirectory(t);
  const commands = [];
  const connections = new SshConnections({ dataDir, command: async (...args) => { commands.push(args); throw new Error('Blocked hosts must never reach SSH'); }, lookup: async (host) => host === 'mixed.example.com' ? [{ address: '1.1.1.1', family: 4 }, { address: '10.20.30.40', family: 4 }] : [{ address: '127.0.0.1', family: 4 }] });
  await connections.initialize();
  for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '172.16.1.2', '192.168.0.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'mixed.example.com', 'private.example.com']) {
    await assert.rejects(connections.probe({ host, port: 22 }), { code: 'invalid_ssh_host', statusCode: 400 }, host);
  }
  assert.equal(commands.length, 0);
});

test('SSH profiles persist encrypted credentials, survive restart and enforce ownership', realSshOptions, async (t) => {
  const f = await sshFixture(t);
  const discovered = await f.connections.probe({ host: f.profileInput.host, port: f.profileInput.port });
  assert.deepEqual(discovered.addresses, ['127.0.0.1']);
  assert.ok(discovered.keys.some((key) => key.fingerprint === f.profileInput.fingerprint));
  const profile = await f.connections.create(901001, f.profileInput);
  assert.equal(profile.name, '隔离 SSH 测试');
  assert.equal(profile.fingerprint, f.profileInput.fingerprint);
  assert.equal(profile.authType, 'key');
  for (const exposed of [profile, await f.connections.get(901001, profile.id), ...(await f.connections.list(901001))]) {
    assert.equal(Object.hasOwn(exposed, 'privateKey'), false);
    assert.equal(Object.hasOwn(exposed, 'password'), false);
    assert.equal(JSON.stringify(exposed).includes(f.privateKey), false);
  }
  assert.deepEqual(await f.connections.list(901002), []);
  for (const operation of ['get', 'remove', 'test']) {
    await assert.rejects(Promise.resolve().then(() => f.connections[operation](901002, profile.id)), { code: 'not_found', statusCode: 404 });
  }
  await assert.rejects(f.connections.exec(901002, profile.id, ['true']), { code: 'not_found', statusCode: 404 });
  await assertTemporaryCredentialsRemoved(f.dataDir);
  const privateBody = f.privateKey.split('\n')[1];
  const persistedFiles = await readFiles(f.dataDir);
  assert.ok(persistedFiles.length > 0);
  for (const file of persistedFiles) {
    assert.equal(file.content.includes(Buffer.from(f.privateKey)), false, 'Private key must not persist as plaintext');
    assert.equal(file.content.includes(Buffer.from(privateBody)), false, 'Private key material must not persist as plaintext');
    assert.equal(file.mode & 0o077, 0, 'Persistent SSH credentials must be owner-only');
  }
  const restarted = new SshConnections({ dataDir: f.dataDir, allowPrivate: true });
  await restarted.initialize();
  const result = await restarted.exec(901001, profile.id, ['printf', '%s', 'restart retained access']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'restart retained access');
  const health = await restarted.test(901001, profile.id);
  assert.equal(health.connected, true);
  assert.equal(health.home, '/root');
  assert.equal(health.capabilities.python, true);
  assert.equal(health.capabilities.git, true);
  assert.equal(typeof health.capabilities.codex, 'boolean');
  await restarted.remove(901001, profile.id);
  assert.deepEqual(await restarted.list(901001), []);
  await assert.rejects(Promise.resolve().then(() => restarted.get(901001, profile.id)), { code: 'not_found', statusCode: 404 });
  await assertTemporaryCredentialsRemoved(f.dataDir);
});

test('SSH exec preserves exact arguments, stdin and environment without exposing secrets in argv', realSshOptions, async (t) => {
  const f = await sshFixture(t);
  const profile = await f.connections.create(901003, f.profileInput);
  const marker = path.join(f.directory, 'shell-injection-must-not-exist');
  const args = ['contains spaces', "single'quote", 'double"quote', `$(touch ${marker})`, `'; touch ${marker}; #`, '你好\n第二行'];
  const input = 'stdin 首行\nsecond line\u0000tail';
  const secret = `private-env-${randomBytes(20).toString('hex')}`;
  const result = await f.connections.exec(901003, profile.id, ['python3', '-c', 'import json,os,sys; print(json.dumps({"args":sys.argv[1:],"input":sys.stdin.read(),"secret":os.environ["CODEX_TEST_SECRET"]}, ensure_ascii=False))', ...args], { input, env: { CODEX_TEST_SECRET: secret } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, input, secret });
  assert.equal(existsSync(marker), false);
  for (const call of f.calls) {
    assert.equal(call.args.join(' ').includes(secret), false);
    assert.equal(call.args.join(' ').includes(f.privateKey), false);
  }
  await assertTemporaryCredentialsRemoved(f.dataDir);
});

test('SSH spawn keeps duplex stdio intact and cleans credentials when the child exits', realSshOptions, async (t) => {
  const f = await sshFixture(t);
  const profile = await f.connections.create(901004, f.profileInput);
  const secret = `spawn-env-${randomBytes(20).toString('hex')}`;
  const child = await f.connections.spawn(901004, profile.id, ['python3', '-c', 'import json,os,sys; print("ready", flush=True); print(json.dumps({"input":sys.stdin.read(),"secret":os.environ["CODEX_TEST_SECRET"]}))'], { env: { CODEX_TEST_SECRET: secret } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const closed = once(child, 'close');
  child.stdin.end('first line\nsecond line\n');
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  const [ready, payload] = stdout.trimEnd().split('\n');
  assert.equal(ready, 'ready');
  assert.deepEqual(JSON.parse(payload), { input: 'first line\nsecond line\n', secret });
  assert.ok(f.spawnCalls.length > 0);
  for (const call of f.spawnCalls) assert.equal(call.args.join(' ').includes(secret), false);
  await assertTemporaryCredentialsRemoved(f.dataDir);
});

test('SSH refuses unconfirmed fingerprints and failed authentication without retaining profiles', realSshOptions, async (t) => {
  const f = await sshFixture(t);
  const fingerprint = `SHA256:${randomBytes(32).toString('base64').replace(/=+$/, '')}`;
  await assert.rejects(f.connections.create(901005, { ...f.profileInput, fingerprint }), { code: 'ssh_fingerprint_mismatch', statusCode: 400 });
  const privateKey = await fs.readFile(f.keys['unauthorized-client'], 'utf8');
  await assert.rejects(f.connections.create(901005, { ...f.profileInput, privateKey }), { code: 'ssh_permission_denied', statusCode: 400 });
  assert.deepEqual(await f.connections.list(901005), []);
  await assertTemporaryCredentialsRemoved(f.dataDir);
  for (const file of await readFiles(f.dataDir)) assert.equal(file.content.includes(Buffer.from(privateKey)), false);
});

test('SSH refuses a changed host key before executing remote commands', realSshOptions, async (t) => {
  const f = await sshFixture(t);
  const profile = await f.connections.create(901006, f.profileInput);
  await f.restart();
  const marker = path.join(f.directory, 'changed-host-command-must-not-run');
  await assert.rejects(f.connections.exec(901006, profile.id, ['touch', marker]), { code: 'ssh_host_key_changed', statusCode: 409 });
  assert.equal(existsSync(marker), false);
  assert.equal((await f.connections.get(901006, profile.id)).fingerprint, f.profileInput.fingerprint);
  await assertTemporaryCredentialsRemoved(f.dataDir);
});
