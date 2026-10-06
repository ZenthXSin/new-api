import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceStore, apiError } from './store.mjs';
import { WorkspaceManager } from './manager.mjs';

const BODY_LIMIT = 8 * 1024 * 1024;
const ZIP_LIMIT = 25 * 1024 * 1024;

async function readBody(request, limit = BODY_LIMIT) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) throw apiError(413, 'body_too_large', 'Request exceeds the size limit');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw apiError(413, 'body_too_large', 'Request exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const buffer = await readBody(request);
  if (!buffer.length) return {};
  let data;
  try { data = JSON.parse(buffer.toString('utf8')); }
  catch { throw apiError(400, 'invalid_json', 'Invalid JSON request body'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw apiError(400, 'invalid_json', 'Request body must be an object');
  return data;
}

async function readZip(request) {
  const type = request.headers['content-type'] || '';
  const body = await readBody(request, ZIP_LIMIT + 128 * 1024);
  if (type.split(';')[0] === 'application/zip') {
    if (body.length > ZIP_LIMIT) throw apiError(413, 'zip_too_large', 'ZIP exceeds the size limit');
    return body;
  }
  if (!type.toLowerCase().startsWith('multipart/form-data;')) throw apiError(415, 'invalid_upload', 'Upload a ZIP file as multipart form data');
  let form;
  try { form = await new Response(body, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw apiError(400, 'invalid_upload', 'Invalid multipart upload'); }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'file' || typeof entries[0][1] === 'string') throw apiError(400, 'invalid_upload', 'Upload exactly one ZIP file');
  const file = entries[0][1];
  if (!file.size || file.size > ZIP_LIMIT) throw apiError(413, 'zip_too_large', 'ZIP exceeds the size limit');
  return Buffer.from(await file.arrayBuffer());
}

function respond(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  const json = JSON.stringify(body);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(json) });
  response.end(json);
}

function authenticate(request, key) {
  const incoming = request.headers['x-codex-runner-key'];
  const adminId = request.headers['x-codex-admin-id'];
  const expected = Buffer.from(key);
  const received = Buffer.from(typeof incoming === 'string' ? incoming : '');
  if (expected.length < 32 || received.length !== expected.length || !timingSafeEqual(received, expected)) throw apiError(401, 'unauthorized', 'Unauthorized');
  if (typeof adminId !== 'string' || !/^[1-9][0-9]{0,9}$/.test(adminId)) throw apiError(401, 'unauthorized', 'Unauthorized');
  // This service is never a browser CORS endpoint, even if an address is leaked.
  if (request.headers.origin || request.headers['sec-fetch-site']) throw apiError(403, 'browser_denied', 'Access through New API is required');
  return Number(adminId);
}

export function createRunnerServer({ manager, key }) {
  const server = createServer(async (request, response) => {
    try {
      const ownerId = authenticate(request, key);
      const url = new URL(request.url, 'http://runner.local');
      if (/%2f|%5c|%00/i.test(url.pathname)) throw apiError(400, 'invalid_path', 'Invalid request path');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      let data;
      if (segments.length === 1 && segments[0] === 'status' && method === 'GET') data = await manager.getStatus();
      else if (segments.length === 1 && segments[0] === 'environment' && method === 'GET') data = await manager.environment(ownerId);
      else if (segments.length === 2 && segments[0] === 'environment' && method === 'POST') {
        await readJson(request);
        if (segments[1] === 'start') data = await manager.startEnvironment(ownerId);
        else if (segments[1] === 'stop') data = await manager.stopEnvironment(ownerId);
      }
      else if (segments.length === 1 && segments[0] === 'workspaces') {
        if (method === 'GET') data = { workspaces: manager.store.list(ownerId) };
        else if (method === 'POST') data = await manager.create(ownerId, await readJson(request));
      } else if (segments[0] === 'workspaces' && segments[1]) {
        const id = segments[1];
        const state = manager.store.get(ownerId, id);
        if (segments.length === 2) {
          if (method === 'GET') data = manager.store.detail(state);
          else if (method === 'PATCH') data = await manager.update(ownerId, id, await readJson(request));
          else if (method === 'DELETE') data = await manager.delete(ownerId, id);
        } else if (segments.length === 3) {
          const action = segments[2];
          if (action === 'turns' && method === 'POST') data = await manager.turn(ownerId, id, await readJson(request));
          else if (action === 'interrupt' && method === 'POST') data = await manager.interrupt(ownerId, id);
          else if (action === 'events' && method === 'GET') {
            const after = url.searchParams.get('after') || '0';
            if (!/^[0-9]{1,15}$/.test(after) || !Number.isSafeInteger(Number(after))) throw apiError(400, 'invalid_cursor', 'Invalid event cursor');
            data = manager.store.eventsAfter(state, Number(after));
          } else if (action === 'files' && method === 'GET') data = await manager.files.list(id, url.searchParams.get('path') || '');
          else if (action === 'file' && method === 'GET') data = await manager.files.read(id, url.searchParams.get('path') || '');
          else if (action === 'file' && method === 'PUT') {
            const body = await readJson(request);
            data = await manager.mutateFiles(ownerId, id, () => manager.files.write(id, body.path, body.content, body.expectedHash));
          } else if (action === 'diff' && method === 'GET') data = await manager.diff(ownerId, id);
          else if (action === 'import' && method === 'POST') {
            const zip = await readZip(request);
            data = await manager.mutateFiles(ownerId, id, async (entry) => {
              const imported = await manager.files.importZip(id, zip);
              return { workspace: manager.store.publicWorkspace(entry), ...imported };
            });
          } else if (action === 'export' && method === 'GET') {
            // Snapshot while Codex is idle, otherwise files could change mid-archive.
            const archive = await manager.export(ownerId, id);
            response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="codex-workspace-${id}.zip"`, 'Content-Length': archive.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            response.end(archive);
            return;
          }
        } else if (segments.length === 4 && segments[2] === 'approvals' && method === 'POST') {
          data = await manager.approve(ownerId, id, segments[3], await readJson(request));
        }
      }
      if (data === undefined) throw apiError(404, 'not_found', 'Endpoint not found');
      respond(response, 200, { success: true, data: manager.sanitize(data) });
    } catch (error) {
      const statusCode = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
      const message = statusCode === 500 ? 'Codex workbench encountered an internal error' : String(error.message || 'Request failed');
      respond(response, statusCode, { success: false, code: error.code || 'internal_error', message: manager.sanitize(message) });
    }
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  return server;
}

async function secretFromEnvironment(env, name) {
  if (env[`${name}_FILE`]) return (await readFile(env[`${name}_FILE`], 'utf8')).trim();
  return env[name]?.trim() || '';
}

export async function loadConfig(env = process.env) {
  const models = (env.CODEX_MODELS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const efforts = (env.CODEX_EFFORTS || 'low,medium,high,xhigh').split(',').map((value) => value.trim()).filter(Boolean);
  const config = {
    dataDir: resolve(env.CODEX_RUNNER_DATA_DIR || '/var/lib/new-api-codex'),
    key: await secretFromEnvironment(env, 'CODEX_RUNNER_KEY'),
    apiKey: await secretFromEnvironment(env, 'CODEX_API_KEY'),
    apiBaseUrl: env.CODEX_API_BASE_URL || '',
    host: env.CODEX_RUNNER_HOST || '127.0.0.1', port: Number(env.CODEX_RUNNER_PORT || 7310),
    image: env.CODEX_WORKER_IMAGE || 'new-api:codex-user-environment-0.160.0', network: env.CODEX_WORKER_NETWORK || 'new-api-codex-workers',
    maxActive: Number(env.CODEX_MAX_ACTIVE || 2), maxWorkspaces: Number(env.CODEX_MAX_WORKSPACES || 40),
    idleSeconds: Number(env.CODEX_IDLE_SECONDS || 600), models, efforts,
    defaultModel: env.CODEX_DEFAULT_MODEL || models[0] || '', defaultEffort: env.CODEX_DEFAULT_EFFORT || 'medium',
    version: '0.160.0',
  };
  if (config.key.length < 32) throw new Error('CODEX_RUNNER_KEY must contain at least 32 characters');
  if (config.defaultModel && !models.includes(config.defaultModel)) throw new Error('CODEX_DEFAULT_MODEL must be in CODEX_MODELS');
  if (!efforts.includes(config.defaultEffort)) throw new Error('CODEX_DEFAULT_EFFORT must be in CODEX_EFFORTS');
  if (models.some((model) => !/^[A-Za-z0-9_.:/-]{1,150}$/.test(model))) throw new Error('Invalid configured model');
  if (config.apiBaseUrl) {
    const endpoint = new URL(config.apiBaseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid CODEX_API_BASE_URL');
  }
  for (const [name, min, max] of [['port', 1, 65535], ['maxActive', 1, 8], ['maxWorkspaces', 1, 1000], ['idleSeconds', 30, 86400]]) {
    if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) throw new Error(`Invalid ${name}`);
  }
  return config;
}

export async function startRunner(config) {
  const [{ DockerRuntime }, { WorkspaceFiles }] = await Promise.all([import('./docker-runtime.mjs'), import('./workspace-files.mjs')]);
  const runtime = new DockerRuntime({ dataDir: config.dataDir, image: config.image, network: config.network });
  const files = new WorkspaceFiles({ dataDir: config.dataDir, dockerRuntime: runtime });
  const store = new WorkspaceStore({ dataDir: config.dataDir });
  const manager = new WorkspaceManager({ store, files, runtime, config });
  await manager.initialize();
  const server = createRunnerServer({ manager, key: config.key });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(config.port, config.host, done); });
  console.log(`New API Codex runner listening on ${config.host}:${config.port}`);
  return { server, manager };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server, manager } = await startRunner(await loadConfig());
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await manager.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
