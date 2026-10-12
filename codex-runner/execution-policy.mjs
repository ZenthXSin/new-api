import { apiError } from './store.mjs';

// Docker enforces read-only project mounts independently of writable workers.
export function executionPolicy(mode, remote = false, host = false) {
  if (!['code', 'ask', 'auto', 'full-access'].includes(mode)) throw apiError(400, 'invalid_mode', 'Choose request approval, read-only, auto approve, or full access');
  return {
    mountMode: mode === 'ask' ? 'ask' : 'code',
    approvalPolicy: ['auto', 'full-access'].includes(mode) ? 'never' : 'on-request',
    sandbox: (remote || host) && mode === 'ask' ? 'read-only' : 'danger-full-access',
    sandboxPolicy: (host && mode !== 'ask') || mode === 'full-access' ? { type: 'dangerFullAccess' }
      : (remote || host) && mode === 'ask' ? { type: 'readOnly', networkAccess: true }
      : { type: 'externalSandbox', networkAccess: 'enabled' },
  };
}
