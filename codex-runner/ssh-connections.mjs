import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { domainToASCII } from 'node:url';

import { assertOwnerId, WORKSPACE_ID, workspaceError } from './user-layout.mjs';
import { runCommand } from './workspace-files.mjs';

const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
const supportedKeyTypes = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']);
// Read exactly one line without buffering any subsequent RPC or file input.
const environmentBootstrap = 'import json,os,sys\nb=bytearray()\nwhile True:\n c=os.read(0,1)\n if c==b"\\n": break\n if not c or len(b)>262144: sys.exit(126)\n b.extend(c)\ne=dict(os.environ);e.update(json.loads(b));os.execvpe(sys.argv[1],sys.argv[1:],e)';

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (!net.isIPv6(address) || address.includes('%')) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // Native global unicast only: no mapped IPv4, NAT64, link-local, ULA,
  // documentation, benchmark, Teredo or 6to4 addresses.
  if (!/^[23][0-9a-f]{3}:/.test(normalized) || normalized.startsWith('2002:')) return false;
  return !/^2001:(?:db8:|:|2:|1[0-9a-f]:|2[0-9a-f]:)/.test(normalized);
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\"'\"'")}'`; }

function remoteInvocation(argv, environment) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 256 || argv.some((value) => typeof value !== 'string' || value.includes('\0')) || argv.join('').length > 65_536) {
    throw workspaceError('Invalid remote command', 'invalid_ssh_command');
  }
  let inputPrefix = Buffer.alloc(0);
  if (environment !== undefined) {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw workspaceError('Invalid remote environment', 'invalid_ssh_environment');
    for (const [name, value] of Object.entries(environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) throw workspaceError('Invalid remote environment', 'invalid_ssh_environment');
    }
    inputPrefix = Buffer.from(JSON.stringify(environment) + '\n');
    if (inputPrefix.length > 262_144) throw workspaceError('Remote environment exceeds the limit', 'invalid_ssh_environment');
    argv = ['python3', '-I', '-c', environmentBootstrap, ...argv];
  }
  return { command: argv.map(shellQuote).join(' '), inputPrefix };
}

function sshFailure(stderr = '') {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Offending .* key|host key .*changed|no matching host key type/i.test(stderr)) {
    return workspaceError('The SSH server host key changed. Verify the server and add the connection again.', 'ssh_host_key_changed', 409);
  }
  if (/Permission denied|Authentication failed|Too many authentication failures|incorrect passphrase/i.test(stderr)) {
    return workspaceError('SSH permission denied. Check the username, credentials and server login permissions.', 'ssh_permission_denied', 400);
  }
  if (/Load key .*invalid format|error in libcrypto/i.test(stderr)) return workspaceError('The SSH private key could not be read. Use an unencrypted OpenSSH or PEM private key.', 'invalid_ssh_private_key');
  if (/Connection timed out|Operation timed out/i.test(stderr)) return workspaceError('The SSH connection timed out. Check the server address and firewall.', 'ssh_connection_timeout', 504);
  return workspaceError('The SSH connection failed. Check the server address, port and SSH service.', 'ssh_connection_failed', 502);
}

async function privateDirectory(location) {
  await fs.mkdir(location, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(location);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw workspaceError('SSH credential storage is unsafe', 'ssh_storage_unsafe', 500);
  await fs.chmod(location, 0o700);
}

async function readPrivateFile(location, maxBytes = 1024 * 1024) {
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw workspaceError('SSH credential storage is unsafe', 'ssh_storage_unsafe', 500);
    return await handle.readFile();
  } finally { await handle.close(); }
}

function publicProfile(record) {
  const { id, ownerId, name, host, port, username, authType, fingerprint, hostKeyType, address, createdAt, updatedAt } = record;
  return { id, ownerId, name, host, port, username, authType, fingerprint, hostKeyType, address, createdAt, updatedAt };
}

export class SshConnections {
  constructor({ dataDir, command = runCommand, spawnImpl = spawn, lookup = dns.lookup, allowPrivate = false }) {
    this.directory = path.join(path.resolve(dataDir), 'ssh-connections');
    this.profilesDirectory = path.join(this.directory, 'profiles');
    this.operationsDirectory = path.join(this.directory, 'operations');
    this.command = command;
    this.spawnImpl = spawnImpl;
    this.lookup = lookup;
    this.allowPrivate = allowPrivate;
    this.profiles = new Map();
    this.children = new Map();
    this.masterKey = null;
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeStorage();
    return this.initializing;
  }

  async initializeStorage() {
    await fs.mkdir(path.dirname(this.directory), { recursive: true, mode: 0o700 });
    for (const directory of [this.directory, this.profilesDirectory, this.operationsDirectory]) await privateDirectory(directory);
    const profileNames = (await fs.readdir(this.profilesDirectory)).filter((name) => name.endsWith('.json'));
    const keyPath = path.join(this.directory, 'master.key');
    try { this.masterKey = await readPrivateFile(keyPath, 32); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (profileNames.length) throw workspaceError('SSH credential encryption key is missing. Restore the credential backup.', 'ssh_credentials_unavailable', 500);
      const key = randomBytes(32);
      await fs.writeFile(keyPath, key, { mode: 0o600, flag: 'wx' }).catch((writeError) => { if (writeError.code !== 'EEXIST') throw writeError; });
      this.masterKey = await readPrivateFile(keyPath, 32);
    }
    if (this.masterKey.length !== 32) throw workspaceError('SSH credential encryption key is invalid', 'ssh_credentials_unavailable', 500);
    // A crashed SSH invocation must not leave usable credentials on disk.
    for (const name of await fs.readdir(this.operationsDirectory)) {
      if (name.startsWith('operation-')) await fs.rm(path.join(this.operationsDirectory, name), { recursive: true, force: true });
    }
    for (const name of profileNames) {
      if (!WORKSPACE_ID.test(name.slice(0, -5))) throw workspaceError('Invalid SSH connection state', 'ssh_storage_unsafe', 500);
      let record;
      try { record = JSON.parse(await readPrivateFile(path.join(this.profilesDirectory, name))); }
      catch (error) { if (error.code === 'ssh_storage_unsafe') throw error; throw workspaceError('SSH connection state could not be read', 'ssh_storage_unsafe', 500); }
      if (record.id !== name.slice(0, -5) || !Number.isSafeInteger(record.ownerId) || record.ownerId < 1 || !net.isIP(record.address) || !supportedKeyTypes.has(record.hostKeyType) || !['key', 'password'].includes(record.authType) || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/.test(record.username)) {
        throw workspaceError('Invalid SSH connection state', 'ssh_storage_unsafe', 500);
      }
      this.decrypt(record);
      this.profiles.set(record.id, record);
    }
  }

  async resolveTarget(host, port = 22) {
    if (typeof host !== 'string' || !host || host.length > 253 || /[\s\x00-\x1f\x7f%]/.test(host)) throw workspaceError('Use a valid public SSH hostname or address', 'invalid_ssh_host');
    host = host.replace(/^\[([^\]]+)\]$/, '$1');
    if (!net.isIP(host)) {
      host = domainToASCII(host).toLowerCase();
      if (!host.includes('.') || host.endsWith('.') || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw workspaceError('Use a valid public SSH hostname or address', 'invalid_ssh_host');
    }
    if (typeof port === 'string' && /^\d{1,5}$/.test(port)) port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw workspaceError('SSH port must be between 1 and 65535', 'invalid_ssh_port');
    let addresses;
    try { addresses = net.isIP(host) ? [host] : (await this.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address); }
    catch { throw workspaceError('The SSH hostname could not be resolved', 'invalid_ssh_host'); }
    if (!addresses.length || addresses.some((address) => !net.isIP(address) || !this.allowPrivate && !isPublicAddress(address))) throw workspaceError('SSH connections must use public server addresses', 'invalid_ssh_host');
    return { host, port, addresses: [...new Set(addresses)] };
  }

  async scan({ host, port }) {
    const target = await this.resolveTarget(host, port);
    let result;
    try { result = await this.command('ssh-keyscan', ['-T', '8', '-p', String(target.port), '-t', 'ed25519,ecdsa,rsa', target.addresses[0]], { env: cleanEnv, timeoutMs: 30_000, maxBytes: 128 * 1024 }); }
    catch { throw workspaceError('The SSH server host key could not be read', 'ssh_probe_failed', 502); }
    const keys = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.trim().split(/\s+/);
      const [, type, encoded] = parts;
      if (parts.length !== 3 || !supportedKeyTypes.has(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 16_384) continue;
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length < 8 || bytes.readUInt32BE(0) !== type.length || bytes.subarray(4, 4 + type.length).toString() !== type) continue;
      const fingerprint = `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`;
      if (!keys.some((key) => key.fingerprint === fingerprint)) keys.push({ type, fingerprint, encoded });
    }
    if (!keys.length) throw workspaceError('No supported SSH host key was returned. Check the address, port and SSH service.', 'ssh_probe_failed', 502);
    return { ...target, keys };
  }

  async probe(input) {
    const result = await this.scan(input || {});
    return { host: result.host, port: result.port, addresses: result.addresses, keys: result.keys.map(({ type, fingerprint }) => ({ type, fingerprint })) };
  }

  encrypt(record, credentials) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(`${record.ownerId}:${record.id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }

  decrypt(record) {
    try {
      const { version, iv, tag, ciphertext } = record.credentials;
      if (version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(`${record.ownerId}:${record.id}`));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
      try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
    } catch { throw workspaceError('SSH credentials could not be decrypted. Restore the credential backup or add the connection again.', 'ssh_credentials_unavailable', 500); }
  }

  record(ownerId, id) {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || typeof id !== 'string' || !WORKSPACE_ID.test(id)) throw workspaceError('SSH connection not found', 'not_found', 404);
    const record = this.profiles.get(id);
    if (!record || record.ownerId !== ownerId) throw workspaceError('SSH connection not found', 'not_found', 404);
    return record;
  }

  async list(ownerId) {
    assertOwnerId(ownerId);
    await this.initialize();
    return [...this.profiles.values()].filter((record) => record.ownerId === ownerId).map(publicProfile).sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(ownerId, id) { await this.initialize(); return publicProfile(this.record(ownerId, id)); }

  async create(ownerId, input) {
    assertOwnerId(ownerId);
    await this.initialize();
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f\x7f]/.test(input.name)) throw workspaceError('Enter an SSH connection name up to 100 characters', 'invalid_ssh_name');
    if (typeof input.username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/.test(input.username)) throw workspaceError('Enter a valid SSH username', 'invalid_ssh_username');
    if (!['key', 'password'].includes(input.authType)) throw workspaceError('Choose SSH key or password authentication', 'invalid_ssh_auth');
    if (typeof input.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint)) throw workspaceError('Confirm the SSH server fingerprint before connecting', 'ssh_fingerprint_required');
    let credentials;
    if (input.authType === 'key') {
      if (typeof input.privateKey !== 'string' || input.privateKey.length > 262_144 || !/^-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----\r?\n/.test(input.privateKey) || input.privateKey.includes('\0')) throw workspaceError('Enter an unencrypted OpenSSH or PEM private key', 'invalid_ssh_private_key');
      credentials = { privateKey: input.privateKey.endsWith('\n') ? input.privateKey : input.privateKey + '\n' };
    } else {
      if (typeof input.password !== 'string' || !input.password.length || input.password.length > 4096 || /[\0\r\n]/.test(input.password)) throw workspaceError('Enter a valid SSH password', 'invalid_ssh_password');
      credentials = { password: input.password };
    }
    if ([...this.profiles.values()].filter((record) => record.ownerId === ownerId).length >= 20) throw workspaceError('The SSH connection limit has been reached', 'ssh_connection_limit', 409);
    const scan = await this.scan(input);
    const key = scan.keys.find((entry) => entry.fingerprint === input.fingerprint);
    if (!key) throw workspaceError('The SSH server fingerprint does not match. Verify the server and probe again.', 'ssh_fingerprint_mismatch');
    const now = Date.now();
    const record = { id: randomUUID(), ownerId, name: input.name.trim(), host: scan.host, port: scan.port, username: input.username, authType: input.authType, fingerprint: key.fingerprint, hostKeyType: key.type, hostKey: key.encoded, address: scan.addresses[0], createdAt: now, updatedAt: now };
    record.credentials = this.encrypt(record, credentials);
    const result = await this.execRecord(record, ['true'], { timeoutMs: 20_000, maxBytes: 64 * 1024 });
    if (result.code !== 0) throw workspaceError('SSH login succeeded but remote commands are not permitted for this account', 'ssh_remote_command_denied', 400);
    const destination = path.join(this.profilesDirectory, `${record.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
    this.profiles.set(record.id, record);
    return publicProfile(record);
  }

  async remove(ownerId, id) {
    await this.initialize();
    this.record(ownerId, id);
    for (const child of this.children.get(id) || []) child.kill('SIGTERM');
    await fs.rm(path.join(this.profilesDirectory, `${id}.json`));
    this.profiles.delete(id);
    return { deleted: true };
  }

  async prepare(record, argv, environment) {
    if (!this.allowPrivate && !isPublicAddress(record.address)) throw workspaceError('SSH connections must use public server addresses', 'invalid_ssh_host');
    const invocation = remoteInvocation(argv, environment);
    const directory = await fs.mkdtemp(path.join(this.operationsDirectory, 'operation-'));
    await fs.chmod(directory, 0o700);
    try {
      const credentials = this.decrypt(record);
      const alias = `new-api-ssh-${record.id}`;
      const knownHosts = path.join(directory, 'known_hosts');
      await fs.writeFile(knownHosts, `${alias},[${alias}]:${record.port},${record.address},[${record.address}]:${record.port} ${record.hostKeyType} ${record.hostKey}\n`, { mode: 0o600, flag: 'wx' });
      const args = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes', '-o', 'CheckHostIP=yes', '-o', `HostKeyAlias=${alias}`, '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'CanonicalizeHostname=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'LogLevel=ERROR', '-o', 'EscapeChar=none'];
      args.push('-o', `HostKeyAlgorithms=${record.hostKeyType === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256' : record.hostKeyType}`);
      const env = { ...cleanEnv };
      if (record.authType === 'key') {
        const identity = path.join(directory, 'identity');
        await fs.writeFile(identity, credentials.privateKey, { mode: 0o600, flag: 'wx' });
        args.push('-i', identity, '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no');
      } else {
        const askpass = path.join(directory, 'askpass');
        await fs.writeFile(askpass, '#!/bin/sh\ncase "$1" in *assword*) printf \'%s\\n\' "$NEW_API_SSH_PASSWORD" ;; *) exit 1 ;; esac\n', { mode: 0o700, flag: 'wx' });
        // OpenSSH takes the first occurrence of each option.
        args[args.indexOf('BatchMode=yes')] = 'BatchMode=no';
        args.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=yes', '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=1');
        Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'new-api:0', NEW_API_SSH_PASSWORD: credentials.password });
      }
      args.push('-p', String(record.port), '-l', record.username, '--', record.address, invocation.command);
      return { args, env, inputPrefix: invocation.inputPrefix, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }

  async execRecord(record, argv, { input, env, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024 } = {}) {
    const operation = await this.prepare(record, argv, env);
    try {
      const result = await this.command('ssh', operation.args, {
        env: operation.env, timeoutMs, maxBytes,
        input: operation.inputPrefix.length ? Buffer.concat([operation.inputPrefix, input === undefined ? Buffer.alloc(0) : Buffer.from(input)]) : input,
      });
      if (result.code === 255) throw sshFailure(result.stderr);
      return result;
    } catch (error) {
      if (error.code?.startsWith('ssh_') || error.code === 'invalid_ssh_private_key') throw error;
      if (error.code === 'operation_timeout') throw workspaceError('The SSH operation timed out', 'ssh_operation_timeout', 504);
      if (error.code === 'output_too_large') throw workspaceError('Remote output exceeds the supported size', 'output_too_large', 413);
      throw workspaceError('The SSH client could not run', 'ssh_unavailable', 503);
    } finally { await operation.cleanup(); }
  }

  async exec(ownerId, id, argv, options = {}) { await this.initialize(); return this.execRecord(this.record(ownerId, id), argv, options); }

  async spawn(ownerId, id, argv, { env } = {}) {
    await this.initialize();
    const operation = await this.prepare(this.record(ownerId, id), argv, env);
    let child;
    try { child = this.spawnImpl('ssh', operation.args, { env: operation.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { await operation.cleanup(); throw workspaceError('The SSH client could not start', 'ssh_unavailable', 503); }
    let errors = '';
    child.stderr.on('data', (chunk) => { if (errors.length < 65_536) errors += chunk.toString('utf8').slice(0, 65_536 - errors.length); });
    child.on('exit', (code) => { if (code === 255) child.sshError = sshFailure(errors); errors = ''; });
    const children = this.children.get(id) || new Set();
    children.add(child); this.children.set(id, children);
    const cleanup = () => { children.delete(child); if (!children.size) this.children.delete(id); operation.cleanup().catch(() => {}); };
    child.once('close', cleanup);
    child.once('error', () => { child.sshError = workspaceError('The SSH client could not start', 'ssh_unavailable', 503); cleanup(); });
    // A caller attaches its own RPC failure handler, but the initial environment
    // write can fail before it receives the child process.
    child.stdin.on('error', () => {});
    if (operation.inputPrefix.length) child.stdin.write(operation.inputPrefix);
    return child;
  }

  async test(ownerId, id) {
    const script = 'printf "%s\\n" "$HOME"; for tool in python3 git codex; do if command -v "$tool" >/dev/null 2>&1; then printf "1\\n"; else printf "0\\n"; fi; done';
    const result = await this.exec(ownerId, id, ['sh', '-c', script], { timeoutMs: 20_000, maxBytes: 64 * 1024 });
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    if (result.code !== 0 || lines.length !== 4 || !lines[0].startsWith('/') || lines.slice(1).some((value) => !['0', '1'].includes(value))) throw workspaceError('The SSH account did not return a usable remote environment', 'ssh_environment_unavailable', 502);
    return { connected: true, home: lines[0], capabilities: { python: lines[1] === '1', git: lines[2] === '1', codex: lines[3] === '1' } };
  }
}
