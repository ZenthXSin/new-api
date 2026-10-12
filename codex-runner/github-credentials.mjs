import { apiError } from './store.mjs';
import { assertOwnerId } from './user-layout.mjs';

// Git only asks this helper for HTTPS github.com. The value contains code, never
// a credential: the token is inherited at execution time and is never persisted.
const GITHUB_HELPER = '!f() { [ "$1" = get ] || return 0; p=; h=; while IFS= read -r line; do case "$line" in protocol=*) p=${line#protocol=} ;; host=*) h=${line#host=} ;; esac; done; [ "$p" = https ] || return 0; case "$h" in github.com|github.com:443) [ -n "$GH_TOKEN" ] && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN" ;; esac; }; f';

export function githubGitEnvironment(credential) {
  if (!credential?.token) return {};
  return {
    GH_TOKEN: credential.token, GITHUB_TOKEN: credential.token,
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_BROWSER: 'false',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: GITHUB_HELPER,
    GIT_CONFIG_KEY_2: 'credential.https://github.com.username', GIT_CONFIG_VALUE_2: 'x-access-token',
    GIT_CONFIG_KEY_3: 'http.https://github.com/.followRedirects', GIT_CONFIG_VALUE_3: 'false',
  };
}

export class GitHubCredentials {
  #owners = new Map();
  #redactions = new Set();
  #pendingDeltas = new Map();

  parse(headers) {
    const token = headers['x-codex-github-token'];
    const login = headers['x-codex-github-login'];
    const generation = headers['x-codex-github-generation'];
    // Older callers without GitHub support have no credentials to synchronize.
    if (token === undefined && login === undefined && generation === undefined) return null;
    if (typeof token !== 'string' || typeof login !== 'string' || typeof generation !== 'string' ||
        !/^(0|[1-9][0-9]{0,15})$/.test(generation) || !Number.isSafeInteger(Number(generation)) ||
        token.length > 4096 || (token && !/^[A-Za-z0-9_.-]{8,4096}$/.test(token)) ||
        (token && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) || (!token && login)) {
      throw apiError(400, 'invalid_github_credentials', 'GitHub authorization metadata is invalid');
    }
    return { token, login, generation: Number(generation) };
  }

  update(ownerId, credential) {
    assertOwnerId(ownerId);
    const previous = this.#owners.get(ownerId);
    if (!credential) {
      if (previous) throw apiError(409, 'github_credentials_changed', 'GitHub authorization changed; refresh and retry');
      return { changed: false, credential: null };
    }
    if (previous && (credential.generation < previous.generation || credential.generation === previous.generation &&
        (credential.token !== previous.token || credential.login !== previous.login))) {
      throw apiError(409, 'github_credentials_changed', 'GitHub authorization changed; refresh and retry');
    }
    const changed = Boolean(previous ? previous.token !== credential.token || previous.login !== credential.login : credential.token);
    this.#owners.set(ownerId, Object.freeze({ ...credential }));
    if (credential.token) {
      // Keep retired tokens only for redacting delayed errors/events after revoke.
      this.#redactions.add(credential.token);
      this.#redactions.add(Buffer.from(`x-access-token:${credential.token}`).toString('base64'));
    }
    return { changed, credential: credential.token ? { ...credential } : null };
  }

  environment(ownerId) { return githubGitEnvironment(this.#owners.get(assertOwnerId(ownerId))); }

  addRedaction(secret) { if (secret) this.#redactions.add(secret); }

  sanitizeDelta(stream, delta, event = null) {
    let value = (this.#pendingDeltas.get(stream)?.prefix || '') + delta;
    this.#pendingDeltas.delete(stream);
    for (const secret of this.#redactions) value = value.split(secret).join('[REDACTED]');
    let held = 0;
    for (const secret of this.#redactions) {
      for (let length = Math.min(value.length, secret.length - 1); length > held; length--) {
        if (value.endsWith(secret.slice(0, length))) { held = length; break; }
      }
    }
    if (held) this.#pendingDeltas.set(stream, { prefix: value.slice(-held), event });
    return held ? value.slice(0, -held) : value;
  }

  flushDeltaStreams(projectId, itemId) {
    const pending = [];
    for (const [stream, value] of this.#pendingDeltas) {
      if (!stream.startsWith(`${projectId}:`) || itemId && value.event?.params?.itemId !== itemId) continue;
      this.#pendingDeltas.delete(stream);
      // Short suffixes are often normal text (for example a trailing "g"). A
      // longer truncated token prefix is itself sensitive and stays redacted.
      const delta = value.prefix.length >= 8 ? '[REDACTED]' : value.prefix;
      pending.push(value.event ? { ...value.event, params: { ...value.event.params, delta } } : { delta });
    }
    return pending;
  }

  clearDeltaStreams(projectId) {
    for (const stream of this.#pendingDeltas.keys()) if (stream.startsWith(`${projectId}:`)) this.#pendingDeltas.delete(stream);
  }

  sanitizeJSON(json) {
    for (const secret of this.#redactions) json = json.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    return json;
  }
}
