import { readFile } from 'node:fs/promises';
import { apiError } from './store.mjs';

let helper;

export async function workspaceRepository(runtime, id, operation = 'metadata', input = {}) {
  helper ||= readFile(new URL('./workspace-repository.py', import.meta.url), 'utf8');
  const script = await helper;
  const backend = runtime.backend ? runtime.backend(id) : runtime;
  const request = { ...input, operation, cwd: runtime.cwd(id) };
  const argv = ['python3', '-I', '-c', script];
  const options = { input: JSON.stringify(request), timeoutMs: 90_000, maxBytes: 2 * 1024 * 1024 };
  let result;
  if (backend.connections && backend.entry) {
    const entry = backend.entry(id);
    result = await backend.connections.exec(entry.ownerId, entry.remote.connectionId, argv, options);
  } else if (backend.exec) {
    result = await backend.exec(id, argv, options);
  } else throw apiError(503, 'repository_unavailable', 'Repository operations are unavailable in this environment');
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw apiError(502, 'repository_failed', 'Repository operation did not return a valid result'); }
  if (!response?.ok || result.code) {
    throw apiError(response?.statusCode || 409, response?.code || 'repository_failed', response?.error || 'Repository operation failed');
  }
  return response.result;
}
