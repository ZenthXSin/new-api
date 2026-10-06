/*
Copyright (C) 2026 QuantumNous and contributors
SPDX-License-Identifier: AGPL-3.0-or-later
*/

export const DASHBOARD_RESOURCE = 'urn:new-api:dashboard';
export const RELAY_RESOURCE = 'urn:new-api:relay';

export class OAuthError extends Error {
  constructor(code, message, { status = 0, details } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class MemoryTransactionStore {
  #items = new Map();
  async set(key, value) { this.#items.set(key, structuredClone(value)); }
  async get(key) { return this.#items.get(key); }
  async delete(key) { this.#items.delete(key); }
  // Consume atomically. Shared server stores must use GETDEL/a transaction.
  async take(key) {
    const value = this.#items.get(key);
    this.#items.delete(key);
    return value;
  }
}

// Store only short-lived authorization transactions here, never access tokens.
export function sessionTransactionStore(storage = globalThis.sessionStorage, prefix = 'new-api.oauth.') {
  return {
    async set(key, value) { storage.setItem(prefix + key, JSON.stringify(value)); },
    async take(key) {
      const raw = storage.getItem(prefix + key);
      storage.removeItem(prefix + key);
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new OAuthError('invalid_token', 'Invalid token encoding');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createPKCE(crypto = globalThis.crypto) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' };
}

function trustedURL(raw, base) {
  const url = new URL(raw, base);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new OAuthError('invalid_configuration', 'Use HTTPS, or HTTP on loopback, without URL credentials or fragments');
  }
  return url;
}

function singleParam(params, key) {
  if (params.getAll(key).length > 1) throw new OAuthError('invalid_callback', `Duplicate ${key} parameter`);
  return params.get(key);
}

function callbackMatches(callback, expected) {
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash) return false;
  for (const [key, value] of expected.searchParams) {
    if (callback.searchParams.getAll(key).length !== expected.searchParams.getAll(key).length || !callback.searchParams.getAll(key).includes(value)) return false;
  }
  return true;
}

async function responseJSON(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; }
  catch { throw new OAuthError('invalid_response', 'Server returned invalid JSON', { status: response.status }); }
}

function serverError(response, data) {
  const code = typeof data?.error === 'string' ? data.error : 'request_failed';
  return new OAuthError(code, `New API request failed (${response.status})`, { status: response.status, details: data });
}

export class NewAPIOAuthClient {
  #metadata;
  #refreshing;
  #tokens;
  #jwks;
  #generation = 0;
  #claims;
  #persistence = Promise.resolve();

  constructor({ issuer, clientId, redirectUri, apiBaseUrl, clientSecret, transactionStore = new MemoryTransactionStore(), fetch = globalThis.fetch, crypto = globalThis.crypto, now = () => Date.now(), onTokens } = {}) {
    this.issuer = trustedURL(issuer).href.replace(/\/$/, '');
    this.apiBaseUrl = trustedURL(apiBaseUrl ?? '/', this.issuer).href;
    if (new URL(this.apiBaseUrl).origin !== new URL(this.issuer).origin) throw new OAuthError('invalid_configuration', 'API and issuer must use the same origin');
    this.redirectUri = trustedURL(redirectUri).href;
    if (!clientId || !crypto?.subtle || typeof fetch !== 'function' || typeof transactionStore?.take !== 'function') throw new OAuthError('invalid_configuration', 'clientId, Web Crypto, fetch and an atomic transaction store are required');
    if (clientSecret && typeof window !== 'undefined') throw new OAuthError('invalid_configuration', 'A browser client cannot keep a client secret');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.transactions = transactionStore;
    this.fetch = fetch;
    this.crypto = crypto;
    this.now = now;
    this.onTokens = onTokens;
  }

  async discover() {
    if (this.#metadata) return this.#metadata;
    const response = await this.fetch(`${this.issuer}/.well-known/openid-configuration`, { credentials: 'omit', redirect: 'error' });
    const data = await responseJSON(response);
    if (!response.ok) throw serverError(response, data);
    if (data?.issuer !== this.issuer) throw new OAuthError('invalid_issuer', 'Discovery issuer does not match the configured issuer');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'jwks_uri']) {
      const endpoint = trustedURL(data[key]);
      if (endpoint.origin !== new URL(this.issuer).origin) throw new OAuthError('invalid_endpoint', 'Discovery endpoint has an unexpected origin');
    }
    this.#metadata = data;
    return data;
  }

  async beginAuthorization({ scopes, resources = [], extra = {} } = {}) {
    const metadata = await this.discover();
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => typeof scope !== 'string' || !scope || /\s/.test(scope))) throw new OAuthError('invalid_scope', 'Supply an explicit nonempty array of scopes');
    const state = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const nonce = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    const pkce = await createPKCE(this.crypto);
    await this.transactions.set(state, { state, nonce, verifier: pkce.verifier, issuer: this.issuer, clientId: this.clientId, redirectUri: this.redirectUri, scopes: [...new Set(scopes)], createdAt: this.now() });
    const url = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries(extra)) {
      if (!['prompt', 'login_hint', 'ui_locales'].includes(key)) throw new OAuthError('invalid_request', `Unsupported authorization option: ${key}`);
      url.searchParams.set(key, String(value));
    }
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri, scope: [...new Set(scopes)].join(' '), state, nonce, code_challenge: pkce.challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    for (const resource of [...new Set(resources)]) url.searchParams.append('resource', resource);
    return { url: url.href, state };
  }

  async completeAuthorization(callbackUrl) {
    const generation = this.#generation;
    const callback = new URL(callbackUrl);
    const state = singleParam(callback.searchParams, 'state');
    if (!state) throw new OAuthError('invalid_state', 'Authorization state is missing');
    const transaction = await this.transactions.take(state);
    if (!transaction || transaction.state !== state || transaction.issuer !== this.issuer || transaction.clientId !== this.clientId || transaction.redirectUri !== this.redirectUri || this.now() - transaction.createdAt > 10 * 60_000 || this.now() < transaction.createdAt || !callbackMatches(callback, new URL(this.redirectUri))) throw new OAuthError('invalid_state', 'Authorization transaction is missing, expired or does not match this callback');
    const issuer = singleParam(callback.searchParams, 'iss');
    if (issuer && issuer !== this.issuer) throw new OAuthError('invalid_issuer', 'Authorization response issuer does not match');
    const error = singleParam(callback.searchParams, 'error');
    if (error) throw new OAuthError(error, 'Authorization was not completed');
    const code = singleParam(callback.searchParams, 'code');
    if (!code) throw new OAuthError('invalid_callback', 'Authorization code is missing');
    const tokens = await this.#tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: transaction.verifier });
    if (transaction.scopes.includes('openid') && !tokens.id_token) throw new OAuthError('invalid_id_token', 'An OpenID authorization must return an ID token');
    const claims = tokens.id_token ? await this.verifyIDToken(tokens.id_token, { nonce: transaction.nonce, accessToken: tokens.access_token }) : undefined;
    if (this.#generation !== generation) throw new OAuthError('session_changed', 'Credentials changed while authorization was pending');
    await this.setTokens(tokens);
    this.#claims = claims;
    return { ...this.tokens, ...(claims ? { claims } : {}) };
  }

  async #tokenRequest(parameters) {
    const metadata = await this.discover();
    const body = new URLSearchParams(parameters);
    body.set('client_id', this.clientId);
    // client_secret_post avoids encoding ambiguity for Basic auth and is sent only over HTTPS.
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await this.fetch(metadata.token_endpoint, { method: 'POST', body, credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    const data = await responseJSON(response);
    if (!response.ok || data?.error) throw serverError(response, data);
    if (!data?.access_token || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new OAuthError('invalid_response', 'Token endpoint returned an invalid token response');
    return { ...data, expires_at: this.now() + data.expires_in * 1000 };
  }

  get tokens() { return this.#tokens ? { ...this.#tokens } : undefined; }

  async setTokens(tokens) {
    this.#generation++;
    this.#tokens = tokens ? { ...tokens } : undefined;
    this.#claims = undefined;
    const snapshot = this.tokens;
    this.#persistence = this.#persistence.catch(() => {}).then(() => this.onTokens?.(snapshot));
    await this.#persistence;
  }

  async refresh(options) {
    if (options !== undefined) throw new OAuthError('invalid_request', 'Refresh does not change scope; use the authorization management flow');
    if (this.#refreshing) return this.#refreshing;
    if (!this.#tokens?.refresh_token) throw new OAuthError('login_required', 'No refresh token is available');
    const old = this.#tokens;
    const generation = this.#generation;
    const oldClaims = this.#claims;
    this.#refreshing = (async () => {
      try {
        const tokens = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refresh_token });
        const claims = tokens.id_token ? await this.verifyIDToken(tokens.id_token, { accessToken: tokens.access_token }) : oldClaims;
        if (oldClaims && claims?.sub !== oldClaims.sub) throw new OAuthError('invalid_id_token', 'Refresh changed the authenticated subject');
        if (this.#generation !== generation) throw new OAuthError('session_changed', 'Credentials changed while refresh was pending');
        await this.setTokens(tokens);
        this.#claims = claims;
        return this.tokens;
      } catch (error) {
        // An ambiguous network outcome may have consumed a rotating refresh token.
        // Clear it instead of replaying it and revoking the entire token family.
        if (this.#generation === generation) await this.setTokens(undefined);
        throw error;
      } finally { this.#refreshing = undefined; }
    })();
    return this.#refreshing;
  }

  async revoke(token = this.#tokens?.refresh_token ?? this.#tokens?.access_token) {
    if (!token) { await this.setTokens(undefined); return; }
    // Invalidate any in-flight refresh before sending the revocation request.
    await this.setTokens(undefined);
    const metadata = await this.discover();
    const body = new URLSearchParams({ token, client_id: this.clientId });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const response = await this.fetch(metadata.revocation_endpoint, { method: 'POST', body, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw serverError(response, await responseJSON(response));
  }

  async verifyIDToken(token, { nonce, accessToken, clockToleranceSeconds = 30 } = {}) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OAuthError('invalid_id_token', 'Malformed ID token');
    let header, claims;
    try {
      header = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0])));
      claims = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
    } catch { throw new OAuthError('invalid_id_token', 'Malformed ID token'); }
    if (header.alg !== 'RS256' || !header.kid || header.crit) throw new OAuthError('invalid_id_token', 'Unsupported ID token signature');
    const metadata = await this.discover();
    let key = this.#jwks?.keys?.find((item) => item.kid === header.kid);
    if (!key) {
      const response = await this.fetch(metadata.jwks_uri, { credentials: 'omit', redirect: 'error' });
      const data = await responseJSON(response);
      if (!response.ok) throw serverError(response, data);
      this.#jwks = data;
      key = data?.keys?.find((item) => item.kid === header.kid);
    }
    if (!key || key.kty !== 'RSA' || (key.alg && key.alg !== 'RS256') || (key.use && key.use !== 'sig')) throw new OAuthError('invalid_id_token', 'ID token signing key is not trusted');
    const publicKey = await this.crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await this.crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decodeBase64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const now = Math.floor(this.now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!valid || claims.iss !== this.issuer || !audiences.includes(this.clientId) || (audiences.length > 1 && claims.azp !== this.clientId) || (claims.azp && claims.azp !== this.clientId) || typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp) || claims.exp + clockToleranceSeconds < now || !Number.isFinite(claims.iat) || claims.iat > now + clockToleranceSeconds || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + clockToleranceSeconds)) || (nonce !== undefined && claims.nonce !== nonce)) throw new OAuthError('invalid_id_token', 'ID token signature or claims are invalid');
    if (claims.at_hash !== undefined) {
      if (!accessToken) throw new OAuthError('invalid_id_token', 'Access token is required to validate at_hash');
      const digest = new Uint8Array(await this.crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)));
      if (claims.at_hash !== base64url(digest.slice(0, digest.length / 2))) throw new OAuthError('invalid_id_token', 'ID token access-token hash does not match');
    }
    return claims;
  }

  async request(path, { json, ...options } = {}) {
    const url = trustedURL(path, this.apiBaseUrl);
    if (url.origin !== new URL(this.apiBaseUrl).origin) throw new OAuthError('invalid_target', 'OAuth credentials cannot be sent to another origin');
    if (!this.#tokens?.access_token) throw new OAuthError('login_required', 'Complete authorization first');
    if (this.#tokens.expires_at && this.#tokens.expires_at <= this.now() + 30_000) await this.refresh();
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${this.#tokens.access_token}`);
    if (json !== undefined) {
      if (options.body !== undefined) throw new OAuthError('invalid_request', 'Provide either json or body');
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(json);
    }
    // Never replay requests after 401: a mutation or model request may already have run.
    const response = await this.fetch(url.href, { ...options, headers, credentials: 'omit', redirect: 'error' });
    if (!response.ok) {
      let details;
      try { details = await response.clone().json(); } catch { /* Non-JSON errors are not echoed. */ }
      throw serverError(response, details);
    }
    return response;
  }

  async json(path, options) {
    const response = await this.request(path, options);
    const data = await responseJSON(response);
    if (data?.success === false) throw new OAuthError('business_error', 'New API did not complete the operation', { status: response.status, details: data });
    return data;
  }

  async capabilities() { return this.json('/api/oauth2/capabilities'); }
  async routes() { return this.json('/api/oauth2/routes'); }
  async operations() { return this.json('/api/oauth2/operations'); }

  async createRelayTicket() {
    const result = await this.json('/api/oauth2/relay-ticket', { method: 'POST', json: {} });
    const ticket = result?.data;
    if (!ticket?.ticket || !Number.isFinite(ticket.expires_in) || ticket.protocol !== `openai-insecure-api-key.${ticket.ticket}` || !/^nao_ws_[A-Za-z0-9_-]+$/.test(ticket.ticket)) throw new OAuthError('invalid_response', 'Relay ticket response is invalid');
    return ticket;
  }

  async connectRealtime(model, { WebSocket = globalThis.WebSocket } = {}) {
    if (typeof model !== 'string' || !model || typeof WebSocket !== 'function') throw new OAuthError('invalid_request', 'A model name and WebSocket implementation are required');
    const ticket = await this.createRelayTicket();
    const url = new URL('/v1/realtime', this.apiBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('model', model);
    return new WebSocket(url.href, ['realtime', ticket.protocol]);
  }

  async startHostedAction(operation, parameters = {}, { shareResult = false, returnUri } = {}) {
    let state;
    if (returnUri) {
      returnUri = trustedURL(returnUri).href;
      state = base64url(this.crypto.getRandomValues(new Uint8Array(32)));
    }
    const result = await this.json('/api/oauth2/actions', { method: 'POST', json: { operation, parameters, share_result: shareResult, ...(returnUri ? { return_uri: returnUri, state } : {}) } });
    const action = result?.data;
    if (!action?.action_id || typeof action.approval_url !== 'string') throw new OAuthError('invalid_response', 'Hosted action response is invalid');
    const approval = trustedURL(action.approval_url, this.apiBaseUrl);
    if (approval.origin !== new URL(this.apiBaseUrl).origin || !approval.pathname.startsWith('/oauth/actions/')) throw new OAuthError('invalid_response', 'Hosted action approval URL is not trusted');
    if (state) await this.transactions.set(`action:${state}`, { state, actionId: action.action_id, returnUri, createdAt: this.now(), issuer: this.issuer, clientId: this.clientId });
    return { ...action, approval_url: approval.href };
  }

  async completeHostedCallback(callbackUrl) {
    const callback = new URL(callbackUrl);
    const state = singleParam(callback.searchParams, 'state');
    const transaction = state ? await this.transactions.take(`action:${state}`) : undefined;
    const actionId = singleParam(callback.searchParams, 'action_id');
    if (!transaction || transaction.state !== state || transaction.actionId !== actionId || transaction.issuer !== this.issuer || transaction.clientId !== this.clientId || this.now() - transaction.createdAt > 10 * 60_000 || this.now() < transaction.createdAt || !callbackMatches(callback, new URL(transaction.returnUri))) throw new OAuthError('invalid_state', 'Hosted action callback does not match a pending operation');
    // Query status server-side; the URL's status parameter is only a UI hint.
    return { actionId };
  }

  async getHostedAction(actionId, { receiptToken, signal } = {}) {
    if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(actionId)) throw new OAuthError('invalid_request', 'Hosted action ID is invalid');
    const path = `/api/oauth2/actions/${encodeURIComponent(actionId)}`;
    if (!receiptToken) return (await this.json(path, { signal }))?.data;
    if (!/^nao_ar_[A-Za-z0-9_-]+$/.test(receiptToken)) throw new OAuthError('invalid_request', 'Hosted action receipt token is invalid');
    const response = await this.fetch(new URL(path, this.apiBaseUrl).href, { headers: { Authorization: `Bearer ${receiptToken}` }, signal, credentials: 'omit', redirect: 'error' });
    const data = await responseJSON(response);
    if (!response.ok || data?.success === false) throw serverError(response, data);
    return data?.data;
  }

  async claimHostedResult(actionId, receiptToken) {
    if (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(actionId) || !/^nao_ar_[A-Za-z0-9_-]+$/.test(receiptToken ?? '')) throw new OAuthError('invalid_request', 'Hosted claim requires a valid action ID and receipt token');
    return (await this.json(`/api/oauth2/actions/${encodeURIComponent(actionId)}/claim`, { method: 'POST', json: { receipt_token: receiptToken } }))?.data;
  }

  async waitForHostedAction(actionId, { signal, receiptToken, intervalMs = 2000, timeoutMs = 10 * 60_000 } = {}) {
    const started = this.now();
    while (this.now() - started < timeoutMs) {
      signal?.throwIfAborted();
      const action = await this.getHostedAction(actionId, { receiptToken, signal });
      signal?.throwIfAborted();
      if (['completed', 'rejected', 'failed', 'expired'].includes(action?.status)) return action;
      await new Promise((resolve, reject) => {
        let timer;
        const aborted = () => { clearTimeout(timer); reject(signal.reason); };
        timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, Math.max(250, intervalMs));
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    }
    throw new OAuthError('action_timeout', 'Hosted operation is still pending');
  }

  async *events(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'text/event-stream');
    const response = await this.request(path, { ...options, headers });
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw new OAuthError('invalid_response', 'Expected an SSE response');
    yield* readSSE(response.body);
  }
}

// Supports split UTF-8 characters, CR/LF/CRLF, multiline data, comments and final EOF.
export async function* readSSE(stream) {
  if (!stream) throw new OAuthError('invalid_response', 'SSE response has no body');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '', event = '', data = [], id = '', retry, previousCR = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      let chunk = decoder.decode(value, { stream: !done });
      if (previousCR && chunk.length) { if (chunk[0] === '\n') chunk = chunk.slice(1); previousCR = false; }
      pending += chunk;
      while (pending.length) {
        const newline = pending.search(/[\r\n]/);
        if (newline === -1) break;
        const line = pending.slice(0, newline);
        const width = pending[newline] === '\r' && pending[newline + 1] === '\n' ? 2 : 1;
        previousCR = pending[newline] === '\r' && newline === pending.length - 1;
        pending = pending.slice(newline + width);
        if (!line) {
          if (data.length) yield { event: event || 'message', data: data.join('\n'), id, ...(retry === undefined ? {} : { retry }) };
          event = ''; data = []; retry = undefined;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let content = colon < 0 ? '' : line.slice(colon + 1);
        if (content.startsWith(' ')) content = content.slice(1);
        if (field === 'data') data.push(content);
        else if (field === 'event') event = content;
        else if (field === 'id' && !content.includes('\0')) id = content;
        else if (field === 'retry' && /^\d+$/.test(content)) retry = Number(content);
      }
      if (done) break;
    }
    // An event is only complete after a blank line; a truncated final event is discarded.
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
