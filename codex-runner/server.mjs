import { handlePullRequestRoute } from './pull-requests.mjs';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceStore, apiError } from './store.mjs';
import { WorkspaceManager } from './manager.mjs';
import { modelCredential } from './model-credentials.mjs';
import { searchCodexConversations } from './search.mjs';
import { listTasks } from './tasks.mjs';
import { pipeline } from 'node:stream/promises';

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
  if (response.headersSent) { response.destroy(); return; }
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
      manager.accountTools?.accept(ownerId,request.headers['x-codex-tools-token']);
      manager.acceptPolicy?.(ownerId,request.headers['x-codex-user-policy']);
      if(segments[0]==='ssh') manager.requireExecution?.(ownerId,true);
      if(segments[0]==='workspaces' && segments[1] && !(method === 'GET' && (segments.length === 2 || segments.length === 3 && ['events','conversations'].includes(segments[2])))) manager.requireExecution?.(ownerId,Boolean(manager.store.get(ownerId,segments[1]).workspace.remote),Boolean(manager.store.get(ownerId,segments[1]).workspace.host));
      const needsGitHub = (method === 'POST' && ['environments','github'].includes(segments[0])) || (segments[2] === 'git') || method === 'POST' && (
        segments.length === 1 && segments[0] === 'workspaces' ||
        segments.length === 3 && segments[0] === 'workspaces' && segments[2] === 'turns' ||
        segments.length === 2 && segments[0] === 'environment' && segments[1] === 'start');
      if (needsGitHub) await manager.syncGitHubCredentials(ownerId, request.headers);
      let data;
      if (segments[0] === 'environments') {
        if(segments.length===1 && method==='GET') data=manager.cloud.list(ownerId);
        else if(segments.length===1 && method==='POST') data=await manager.cloudCreate(ownerId,await readJson(request));
        else if(segments.length===2 && method==='GET') data=manager.cloudDetail(ownerId,segments[1]);
        else if(segments.length===2 && method==='PATCH') data=await manager.cloud.update(ownerId,segments[1],await readJson(request));
        else if(segments.length===2 && method==='DELETE') data=await manager.lock(`owner:${ownerId}`,()=>manager.cloud.remove(ownerId,segments[1]));
        else if(segments.length===3 && method==='POST') {
          const body=await readJson(request);
          if(['setup','publish'].includes(segments[2])) data=await manager.cloudOperation(ownerId,segments[1],segments[2]);
          else if(segments[2]==='tasks') data=await manager.cloudTask(ownerId,segments[1],body,modelCredential(request.headers));
        }
      } else if(segments[0]==='github' && segments[1]==='pulls'){
        if(segments.length===6 && segments[5]==='task' && method==='POST') data=await manager.pullRequestTask(ownerId,segments.slice(2,5),await readJson(request),modelCredential(request.headers));
        else data=await handlePullRequestRoute({manager,ownerId,request,url,segments,readJson});
      } else if (segments.length === 2 && segments[0] === 'integrations' && segments[1] === 'github' && method === 'DELETE') data = await manager.disconnectGitHub(ownerId, request.headers);
      else if (segments.length === 1 && segments[0] === 'search' && method === 'GET') {
        const includeArchived = url.searchParams.get('includeArchived');
        if (includeArchived !== null && includeArchived !== 'true' && includeArchived !== 'false') throw apiError(400, 'invalid_search', 'includeArchived must be true or false');
        data = await searchCodexConversations(manager.store, ownerId, { query: url.searchParams.get('query'), limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 30, includeArchived: includeArchived !== 'false' });
      }
      else if (segments.length === 1 && segments[0] === 'tasks' && method === 'GET') {
        const archived = url.searchParams.get('archived');
        const limit = url.searchParams.get('limit');
        const offset = url.searchParams.get('offset');
        if (archived !== null && archived !== 'true' && archived !== 'false') throw apiError(400, 'invalid_task_archive_filter', 'archived must be true or false');
        if (limit !== null && !/^[0-9]{1,4}$/.test(limit)) throw apiError(400, 'invalid_task_limit', 'Task limit must be between 1 and 1000');
        if (offset !== null && !/^[0-9]{1,6}$/.test(offset)) throw apiError(400, 'invalid_task_offset', 'Task offset must be between 0 and 100000');
        data = listTasks(manager.store, ownerId, {
          query: url.searchParams.get('query') ?? undefined,
          archived: archived === null ? undefined : archived === 'true',
          limit: limit === null ? undefined : Number(limit),
          offset: offset === null ? undefined : Number(offset),
        });
      }
      else if (segments.length === 1 && segments[0] === 'status' && method === 'GET') { data = await manager.getStatus(); const policy=manager.policy(ownerId); data.limits.maxWorkspaces=policy.maxProjects || data.limits.maxWorkspaces; data.defaultEffort=policy.defaultEffort || data.defaultEffort; }
      else if (segments.length === 1 && segments[0] === 'environment' && method === 'GET') data = await manager.environment(ownerId);
      else if (segments[0] === 'environment' && segments[1] === 'ports') {
        manager.requireExecution(ownerId, false);
        if (segments.length === 2 && method === 'GET') data = await manager.ports.list(ownerId);
        else if (segments.length === 2 && method === 'POST') data = await manager.ports.open(ownerId, await readJson(request));
        else if (segments.length === 3 && method === 'DELETE') data = await manager.ports.remove(ownerId, segments[2]);
      }
      else if (segments.length === 2 && segments[0] === 'environment' && method === 'POST') {
        await readJson(request);
        if (segments[1] === 'start') data = await manager.startEnvironment(ownerId);
        else if (segments[1] === 'stop') data = await manager.stopEnvironment(ownerId);
      }
      else if (segments[0] === 'ssh') {
        const connections = manager.sshConnections();
        if (segments.length === 2 && segments[1] === 'probe' && method === 'POST') data = await connections.probe(await readJson(request));
        else if (segments.length === 2 && segments[1] === 'connections') {
          if (method === 'GET') data = { connections: await connections.list(ownerId) };
          else if (method === 'POST') data = await manager.createSshConnection(ownerId, await readJson(request));
        } else if (segments.length === 3 && segments[1] === 'connections' && method === 'DELETE') data = await manager.deleteSshConnection(ownerId, segments[2]);
        else if (segments.length === 4 && segments[1] === 'connections' && segments[3] === 'test' && method === 'POST') { await readJson(request); data = await connections.test(ownerId, segments[2]); }
      }
      else if (segments.length === 1 && segments[0] === 'workspaces') {
        if (method === 'GET') data = { workspaces: manager.store.list(ownerId) };
        else if (method === 'POST') data = await manager.create(ownerId, await readJson(request));
      } else if (segments[0] === 'workspaces' && segments[1]) {
        const id = segments[1];
        const conversationId = url.searchParams.get('conversation') || undefined;
        const state = manager.store.get(ownerId, id, conversationId);
        if (segments.length === 2) {
          if (method === 'GET') data = manager.store.detail(state);
          else if (method === 'PATCH') data = await manager.update(ownerId, id, await readJson(request));
          else if (method === 'DELETE') data = await manager.delete(ownerId, id);
        } else if (segments.length === 3) {
          const action = segments[2];
          if (action === 'conversations' && method === 'GET') data = { conversations: manager.store.conversations(state) };
          else if (action === 'conversations' && method === 'POST') data = await manager.createConversation(ownerId, id, await readJson(request));
          else if (action === 'turns' && method === 'POST') data = await manager.turn(ownerId, id, await readJson(request), modelCredential(request.headers), conversationId);
          else if (action === 'interrupt' && method === 'POST') data = await manager.interrupt(ownerId, id, conversationId);
          else if (action === 'events' && method === 'GET') {
            const after = url.searchParams.get('after') || '0';
            if (!/^[0-9]{1,15}$/.test(after) || !Number.isSafeInteger(Number(after))) throw apiError(400, 'invalid_cursor', 'Invalid event cursor');
            data = manager.store.eventsAfter(state, Number(after));
          } else if (action === 'files' && method === 'GET') data = await manager.files.list(id, url.searchParams.get('path') || '');
          else if (action === 'file' && method === 'GET') data = await manager.files.read(id, url.searchParams.get('path') || '');
          else if (action === 'download' && method === 'GET') {
            const relativePath = url.searchParams.get('path') || '';
            const controller = new AbortController();
            const cancel = () => controller.abort();
            response.once('close', cancel);
            try {
              const download = await manager.files.download(id, relativePath, { signal: controller.signal });
              const filename = relativePath.split('/').at(-1);
              const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
              response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encoded}`, 'Content-Length': download.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
              await pipeline(download.stream, response);
            } finally { response.removeListener('close', cancel); }
            return;
          }
          else if (action === 'file' && method === 'PUT') {
            const body = await readJson(request);
            data = await manager.mutateFiles(ownerId, id, () => manager.files.write(id, body.path, body.content, body.expectedHash));
          } else if (action === 'diff' && method === 'GET') data = await manager.diff(ownerId, id);
          else if (action === 'repository' && method === 'GET') data = await manager.repository(ownerId, id);
          else if (action === 'import' && method === 'POST') {
            const zip = await readZip(request);
            data = await manager.mutateFiles(ownerId, id, async (entry) => {
              const imported = await manager.files.importZip(id, zip);
              return { workspace: manager.store.publicWorkspace(entry), ...imported };
            });
          } else if (action === 'upload' && method === 'POST') {
            if ((request.headers['content-type'] || '').split(';')[0] !== 'application/octet-stream') throw apiError(415, 'invalid_upload', 'Upload a file as application/octet-stream');
            const bytes = await readBody(request, ZIP_LIMIT);
            data = await manager.mutateFiles(ownerId, id, () => manager.files.upload(id, url.searchParams.get('path') || '', bytes));
          } else if (action === 'export' && method === 'GET') {
            // Snapshot while Codex is idle, otherwise files could change mid-archive.
            const archive = await manager.export(ownerId, id);
            response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="codex-workspace-${id}.zip"`, 'Content-Length': archive.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            response.end(archive);
            return;
          }
        } else if(segments.length===4 && segments[2]==='git' && ((method==='GET' && segments[3]==='status') || (method==='POST' && ['commit','push','pull-request'].includes(segments[3])))) {
          data=await manager.gitAction(ownerId,id,segments[3],method==='POST'?await readJson(request):{});
        } else if (segments.length === 4 && segments[2] === 'conversations') {
          if (method === 'PATCH') data = await manager.renameConversation(ownerId, id, segments[3], await readJson(request));
          else if (method === 'DELETE') data = await manager.deleteConversation(ownerId, id, segments[3]);
        } else if (segments.length === 4 && segments[2] === 'queue' && method === 'DELETE') {
          data = await manager.cancelQueuedTurn(ownerId, id, segments[3], conversationId);
        } else if (segments.length === 4 && segments[2] === 'repository' && segments[3] === 'checkout' && method === 'POST') {
          data = await manager.checkoutBranch(ownerId, id, await readJson(request));
        } else if (segments.length === 6 && segments[2] === 'turns' && segments[4] === 'messages' && method === 'DELETE') {
          data = await manager.deleteMessage(ownerId, id, segments[3], segments[5], conversationId);
        } else if (segments.length === 4 && segments[2] === 'approvals' && method === 'POST') {
          data = await manager.approve(ownerId, id, segments[3], await readJson(request), conversationId);
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
  const efforts = (env.CODEX_EFFORTS || 'low,medium,high,xhigh,max,ultra').split(',').map((value) => value.trim()).filter(Boolean);
  const config = {
    dataDir: resolve(env.CODEX_RUNNER_DATA_DIR || '/var/lib/new-api-codex'),
    key: await secretFromEnvironment(env, 'CODEX_RUNNER_KEY'),
    apiKey: await secretFromEnvironment(env, 'CODEX_API_KEY'),
    apiBaseUrl: env.CODEX_API_BASE_URL || '',
    host: env.CODEX_RUNNER_HOST || '127.0.0.1', port: Number(env.CODEX_RUNNER_PORT || 7310),
    image: env.CODEX_WORKER_IMAGE || 'new-api:codex-user-environment-0.160.0', network: env.CODEX_WORKER_NETWORK || 'new-api-codex-workers',
    cpuPercent: Number(env.CODEX_WORKER_CPU_PERCENT || 5), memoryMB: Number(env.CODEX_WORKER_MEMORY_MB || 2048),
    frpConfigFile: env.CODEX_FRP_CONFIG_FILE || '',
    maxActive: Number(env.CODEX_MAX_ACTIVE || 2), maxActiveTasks: Number(env.CODEX_MAX_ACTIVE_TASKS || 8), maxWorkspaces: Number(env.CODEX_MAX_WORKSPACES || 40),
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
  for (const [name, min, max] of [['port', 1, 65535], ['maxActive', 1, 8], ['maxActiveTasks', 1, 64], ['maxWorkspaces', 1, 1000], ['idleSeconds', 30, 86400]]) {
    if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isFinite(config.cpuPercent) || config.cpuPercent <= 0 || config.cpuPercent > 100) throw new Error('Invalid cpuPercent');
  if (!Number.isInteger(config.memoryMB) || config.memoryMB < 256 || config.memoryMB > 1048576) throw new Error('Invalid memoryMB');
  return config;
}

export async function startRunner(config) {
  const [{ DockerRuntime }, { WorkspaceFiles }, { SshConnections }, { RemoteRuntime, HybridRuntime, HybridFiles }] = await Promise.all([import('./docker-runtime.mjs'), import('./workspace-files.mjs'), import('./ssh-connections.mjs'), import('./remote-runtime.mjs')]);
  const local = new DockerRuntime({ dataDir: config.dataDir, image: config.image, network: config.network, cpuPercent: config.cpuPercent, memoryMB: config.memoryMB });
  const connections = new SshConnections({ dataDir: config.dataDir });
  const remote = new RemoteRuntime({ dataDir: config.dataDir, connections });
  const { HostRuntime } = await import('./host-runtime.mjs');
  const runtime = new HybridRuntime(local, remote, new HostRuntime({ dataDir: config.dataDir, systemd: true }));
  const files = new HybridFiles(new WorkspaceFiles({ dataDir: config.dataDir, dockerRuntime: local }), runtime);
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
