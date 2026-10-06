import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UserWorkspaceLayout, assertWorkspaceId, workspaceError } from './user-layout.mjs';
export { WORKSPACE_ID, assertWorkspaceId, assertOwnerId, workspacePaths, userPaths, workspaceError } from './user-layout.mjs';
const helper = fileURLToPath(new URL('./safe-files.py', import.meta.url));
const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

export function runCommand(command, args, { input, env = cleanEnv, cwd, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = [], stderr = [], bytes = 0, settled = false;
    const complete = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      complete(workspaceError('Workspace operation timed out', 'operation_timeout', 504));
    }, timeoutMs);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          child.kill('SIGKILL');
          complete(workspaceError('Workspace output exceeds the limit', 'output_too_large', 413));
        } else chunks.push(chunk);
      });
    }
    child.on('error', () => complete(workspaceError('Workspace runtime is unavailable', 'runtime_unavailable', 503)));
    child.on('close', (code) => complete(null, { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Require native global-unicast IPv6; reject mapped IPv4, ULA, link-local and documentation ranges.
  return net.isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:');
}

export async function validateCloneUrl(value, lookup = dns.lookup) {
  let url;
  try { url = new URL(value); } catch { throw workspaceError('Use a public HTTPS repository URL', 'invalid_repository'); }
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.search || url.hash || !url.pathname || url.pathname === '/' || url.hostname.endsWith('.') || /[\x00-\x20\x7f]/.test(value)) {
    throw workspaceError('Use a public HTTPS repository URL without credentials or query parameters', 'invalid_repository');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname.includes('.') && !net.isIP(hostname)) throw workspaceError('Local repository hosts are not allowed', 'invalid_repository');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true }).catch(() => { throw workspaceError('Repository host could not be resolved', 'invalid_repository'); });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw workspaceError('Repository host must resolve only to public addresses', 'invalid_repository');
  return { url: url.href, hostname, addresses: addresses.map(({ address }) => address) };
}

export class WorkspaceFiles {
  constructor({ dataDir, dockerRuntime, command = runCommand, lookup = dns.lookup }) {
    this.dataDir = path.resolve(dataDir);
    this.dockerRuntime = dockerRuntime;
    this.command = command;
    this.lookup = lookup;
    this.operations = new Map();
    this.layout = dockerRuntime?.layout || new UserWorkspaceLayout(dataDir);
  }

  initialize(workspaces) { return this.layout.initialize(workspaces); }
  create(id = randomUUID(), ownerId) { return this.layout.create(id, ownerId); }
  check(id) { return this.layout.check(id); }

  async locked(id, callback) {
    assertWorkspaceId(id);
    const previous = this.operations.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(callback);
    this.operations.set(id, current);
    try { return await current; } finally { if (this.operations.get(id) === current) this.operations.delete(id); }
  }

  async fileOperation(id, operation, args = {}) {
    const { projectPath } = await this.check(id);
    const result = await this.command('python3', ['-I', helper, projectPath], {
      input: JSON.stringify({ operation, ...args }),
      timeoutMs: operation === 'import' || operation === 'export' ? 60_000 : 10_000,
      maxBytes: operation === 'export' ? 140 * 1024 * 1024 : 5 * 1024 * 1024,
    });
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw workspaceError('Workspace file operation failed', 'file_operation_failed', 500); }
    if (!response.ok) throw workspaceError(response.error, response.code, response.statusCode);
    return response.result;
  }

  list(id, relativePath = '') { return this.fileOperation(id, 'list', { path: relativePath }); }
  read(id, relativePath) { return this.fileOperation(id, 'read', { path: relativePath }); }
  write(id, relativePath, content, expectedHash) {
    return this.locked(id, () => this.fileOperation(id, 'write', { path: relativePath, content, ...(expectedHash !== undefined ? { expectedHash } : {}) }));
  }
  importZip(id, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 25 * 1024 * 1024) throw workspaceError('ZIP upload exceeds 25 MiB', 'archive_too_large', 413);
    return this.locked(id, () => this.fileOperation(id, 'import', { data: bytes.toString('base64') }));
  }
  async exportZip(id) { return Buffer.from((await this.fileOperation(id, 'export')).data, 'base64'); }
  async diff(id) {
    await this.check(id);
    if (!this.dockerRuntime) throw workspaceError('Workspace runtime is unavailable', 'runtime_unavailable', 503);
    return this.dockerRuntime.diff(id);
  }
  async remove(id) {
    return this.locked(id, async () => {
      const { root, workspaceHomePath } = await this.check(id);
      // A project owns its files and Codex history, never the shared user container.
      await fs.rm(root, { recursive: true, force: false });
      await fs.rm(workspaceHomePath, { recursive: true, force: false });
      this.layout.unregister(id);
      return { deleted: true };
    });
  }
  async clone(id, value, branch) {
    const repository = await validateCloneUrl(value, this.lookup);
    if (branch !== undefined && branch !== '' && (typeof branch !== 'string' || branch.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock'))) throw workspaceError('Invalid repository branch', 'invalid_branch');
    if (branch) repository.branch = branch;
    await this.check(id);
    if (!this.dockerRuntime) throw workspaceError('Workspace runtime is unavailable', 'runtime_unavailable', 503);
    return this.locked(id, async () => {
      const listing = await this.list(id);
      if (listing.entries.length) throw workspaceError('Repository import requires an empty workspace', 'workspace_not_empty', 409);
      return this.dockerRuntime.clone(id, repository);
    });
  }
}
