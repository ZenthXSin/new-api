import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export class RpcError extends Error {
  constructor(message, code = 'codex_error', statusCode = 502) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Codex 0.160.0 app-server uses one JSON-RPC message per stdout line.
export class CodexRpc extends EventEmitter {
  constructor(child, { timeoutMs = 60_000, maxLineBytes = 16 * 1024 * 1024 } = {}) {
    super();
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    child.stdout.on('data', (chunk) => this.receive(this.decoder.write(chunk)));
    // Stderr is operational logging, never part of the conversation or API response.
    // Keep no raw log here: providers and commands can include credentials in errors.
    child.stderr?.on('data', () => {});
    child.stdin.on('error', () => this.fail(new RpcError('Codex input pipe closed', 'runtime_stopped', 503)));
    child.stdout.on('error', () => this.fail(new RpcError('Codex output pipe closed', 'runtime_stopped', 503)));
    child.on('error', () => this.fail(new RpcError('Codex process could not start', 'runtime_start_failed', 503)));
    child.on('exit', (code, signal) => this.fail(new RpcError(`Codex process stopped (${signal || code || 0})`, 'runtime_stopped', 503)));
  }

  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes && !this.buffer.includes('\n')) {
      this.fail(new RpcError('Codex event exceeds the supported size', 'event_too_large'));
      this.child.kill('SIGTERM');
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.fail(new RpcError('Codex event exceeds the supported size', 'event_too_large'));
        this.child.kill('SIGTERM');
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.fail(new RpcError('Codex sent an invalid protocol message', 'invalid_protocol'));
        this.child.kill('SIGTERM');
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      if ('id' in message && typeof message.method !== 'string') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new RpcError(message.error.message || 'Codex request failed', String(message.error.code || 'codex_error')));
        } else pending.resolve(message.result);
      } else if (typeof message.method === 'string') {
        this.emit('message', message);
      }
    }
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw new RpcError('Codex is disconnected', 'runtime_stopped', 503);
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new RpcError('Codex is disconnected', 'runtime_stopped', 503));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('Codex request timed out; check the task before retrying', 'runtime_timeout', 504));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'new_api_codex', title: 'New API Codex', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }

  respond(id, result) { this.send({ id, result }); }
  reject(id, message = 'This client does not support this request') {
    this.send({ id, error: { code: -32601, message } });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }

  close() {
    // Even after a pipe failure, the local docker-exec client may still be alive.
    // Container-side process-group cleanup is owned by WorkspaceManager.
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    this.child.kill('SIGTERM');
    this.fail(new RpcError('Codex was stopped', 'runtime_stopped', 503));
  }
}
