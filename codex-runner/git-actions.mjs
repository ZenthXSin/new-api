import { readFile } from 'node:fs/promises';
import { apiError } from './store.mjs';

let helper;
const fields = {
  status: [],
  commit: ['message', 'paths', 'all', 'expectedHead', 'expectedStatusVersion'],
  push: ['remote', 'expectedHead'],
  'pull-request': ['title', 'body', 'base', 'draft', 'remote', 'expectedHead'],
};

/** Execute a user-requested Git action inside its existing owned workspace. */
export async function workspaceGitAction(runtime, id, operation = 'status', input = {}, { env = {} } = {}) {
  if (!Object.hasOwn(fields, operation)) throw apiError(400, 'invalid_git_operation', 'Unknown Git operation');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError(400, 'invalid_git_request', 'Invalid Git request');
  if (Object.keys(input).some((key) => !fields[operation].includes(key))) throw apiError(400, 'invalid_git_request', 'Git request contains unsupported fields');
  helper ||= Promise.all([
    readFile(new URL('./workspace-repository.py', import.meta.url), 'utf8'),
    readFile(new URL('./git-actions.py', import.meta.url), 'utf8'),
  ]).then(([repository, actions]) => {
    // Share the repository's filesystem/configuration validation without running
    // its CLI entrypoint. Both scripts are runner-owned, never project files.
    const boundary = repository.indexOf('\ntry:\n    payload = json.load(sys.stdin)');
    if (boundary < 0) throw new Error('Repository helper entrypoint was not found');
    return `${repository.slice(0, boundary)}\n${actions}`;
  });
  const script = await helper;
  const backend = runtime.backend ? runtime.backend(id) : runtime;
  const options = {
    input: JSON.stringify({ ...input, operation, cwd: runtime.cwd(id) }),
    timeoutMs: operation === 'status' ? 90_000 : 140_000,
    maxBytes: 5 * 1024 * 1024,
    // Credentials come exclusively from the manager's authenticated owner.
    env: env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {},
  };
  const argv = ['python3', '-I', '-c', script];
  let result;
  if (backend.connections && backend.entry) {
    const entry = backend.entry(id);
    result = await backend.connections.exec(entry.ownerId, entry.remote.connectionId, argv, options);
  } else if (backend.exec) result = await backend.exec(id, argv, options);
  else throw apiError(503, 'repository_unavailable', 'Git operations are unavailable in this environment');
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw apiError(502, 'git_action_failed', 'Git operation did not return a valid result'); }
  if (!response?.ok || result.code) throw apiError(response?.statusCode || 409, response?.code || 'git_action_failed', response?.error || 'Git operation failed');
  return response.result;
}
