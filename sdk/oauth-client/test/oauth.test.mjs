/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { NewAPIOAuthClient, MemoryTransactionStore, createPKCE, base64url, readSSE } from '../index.mjs';

const issuer = 'https://api.example.test/oidc';
const redirectUri = 'https://client.example.test/callback';
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`, jwks_uri: `${issuer}/.well-known/jwks.json` };
const tokenResponse = { access_token: 'nao_at_test', refresh_token: 'nao_rt_first', token_type: 'Bearer', expires_in: 300, scope: 'profile:read' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(handler = () => response(tokenResponse), options = {}) {
  const calls = [];
  const client = new NewAPIOAuthClient({ issuer, clientId: 'test-client', redirectUri, crypto: webcrypto, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('openid-configuration')) return response(metadata);
    return handler(String(url), init);
  }, ...options });
  return { client, calls };
}

test('S256 PKCE and explicit scope/resource request, code callback consumed once', async () => {
  const { client, calls } = fixture();
  const { url, state } = await client.beginAuthorization({ scopes: ['profile:read', 'profile:read'], resources: ['urn:new-api:dashboard'] });
  const authorization = new URL(url);
  assert.equal(authorization.searchParams.get('scope'), 'profile:read');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('resource'), 'urn:new-api:dashboard');
  assert.equal(authorization.searchParams.get('code_challenge').length, 43);
  const tokens = await client.completeAuthorization(`${redirectUri}?code=single-code&state=${state}`);
  assert.equal(tokens.access_token, tokenResponse.access_token);
  const form = calls.find((call) => call.url.endsWith('/token')).init.body;
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')));
  assert.equal(base64url(new Uint8Array(digest)), authorization.searchParams.get('code_challenge'));
  assert.equal(form.get('redirect_uri'), redirectUri);
  assert.equal(form.get('client_secret'), null);
  await assert.rejects(client.completeAuthorization(`${redirectUri}?code=single-code&state=${state}`), { code: 'invalid_state' });
  assert.equal(calls.filter((call) => call.url.endsWith('/token')).length, 1);
});

test('callback validation rejects state mixing, expiry, duplicate code and issuer mix-up before token request', async () => {
  for (const variant of ['origin', 'issuer', 'duplicate', 'expired', 'unknown-state']) {
    let now = 1_000;
    const { client, calls } = fixture(undefined, { now: () => now });
    const { state } = await client.beginAuthorization({ scopes: ['profile:read'] });
    let url = `${redirectUri}?state=${state}&code=code`;
    if (variant === 'origin') url = url.replace('client.example.test', 'attacker.example.test');
    if (variant === 'issuer') url += '&iss=https%3A%2F%2Fattacker.example.test';
    if (variant === 'duplicate') url += '&code=second';
    if (variant === 'expired') now += 11 * 60_000;
    if (variant === 'unknown-state') url = url.replace(state, 'wrong-state');
    await assert.rejects(client.completeAuthorization(url));
    assert.equal(calls.filter((call) => call.url.endsWith('/token')).length, 0, variant);
  }
});

test('concurrent rotating refresh is serialized and replacement credentials persist once', async () => {
  let requests = 0;
  let finish;
  const ready = new Promise((resolve) => { finish = resolve; });
  const saved = [];
  const { client } = fixture(async (_url, init) => {
    requests++;
    assert.equal(init.body.get('refresh_token'), 'nao_rt_first');
    await ready;
    return response({ ...tokenResponse, refresh_token: 'nao_rt_rotated' });
  }, { onTokens: (tokens) => saved.push(tokens) });
  await client.setTokens(tokenResponse);
  const first = client.refresh();
  const second = client.refresh();
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(results[0].refresh_token, 'nao_rt_rotated');
  assert.deepEqual(results[0], results[1]);
  assert.equal(saved.length, 2);
});

test('ambiguous refresh failure clears credentials without automatic token replay', async () => {
  const { client, calls } = fixture(() => { throw new TypeError('connection closed'); });
  await client.setTokens(tokenResponse);
  await assert.rejects(client.refresh());
  assert.equal(client.tokens, undefined);
  await assert.rejects(client.refresh(), { code: 'login_required' });
  assert.equal(calls.filter((call) => call.url.endsWith('/token')).length, 1);
});

test('API request will not leak tokens across origins or follow redirects or replay mutations', async () => {
  const { client, calls } = fixture(() => response({ error: 'invalid_token' }, 401));
  await client.setTokens(tokenResponse);
  await assert.rejects(client.request('https://attacker.example.test/receive'), { code: 'invalid_target' });
  await assert.rejects(client.request('/api/token/', { method: 'POST', json: { name: 'test' }, redirect: 'follow', credentials: 'include' }), { status: 401 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.get('Authorization'), `Bearer ${tokenResponse.access_token}`);
});

test('multipart keeps fetch-generated boundary, download body remains intact and API business error is generic', async () => {
  const form = new FormData();
  form.set('file', new Blob(['audio'], { type: 'audio/wav' }), 'test.wav');
  const { client, calls } = fixture(() => new Response('file-content'));
  await client.setTokens(tokenResponse);
  const output = await client.request('/v1/audio/transcriptions', { method: 'POST', body: form });
  assert.equal(await output.text(), 'file-content');
  assert.equal(calls[0].init.body, form);
  assert.equal(calls[0].init.headers.has('Content-Type'), false);
  const second = fixture(() => response({ success: false, message: 'internal raw error sentinel' })).client;
  await second.setTokens(tokenResponse);
  await assert.rejects(second.json('/api/group-availability'), (error) => error.code === 'business_error' && !error.message.includes('sentinel'));
});

test('SSE handles UTF-8 chunk boundaries, CRLF, multiline events and cancels when consumer exits', async () => {
  const input = new TextEncoder().encode(': heartbeat\r\nid: 7\r\nevent: delta\r\ndata: 中\r\ndata: 文\r\n\r\ndata: [DONE]\n\ndata: truncated');
  let cancelled = false, index = 0;
  const stream = new ReadableStream({ pull(controller) { if (index < input.length) controller.enqueue(input.slice(index, ++index)); else controller.close(); }, cancel() { cancelled = true; } });
  const actual = [];
  for await (const event of readSSE(stream)) actual.push(event);
  assert.deepEqual(actual, [{ event: 'delta', data: '中\n文', id: '7' }, { event: 'message', data: '[DONE]', id: '7' }]);
  assert.equal(cancelled, false); // Completed stream cannot be cancelled again.
  const neverEnds = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); }, cancel() { cancelled = true; } });
  for await (const _event of readSSE(neverEnds)) break;
  assert.equal(cancelled, true);
});

test('RS256 ID token requires valid signature, issuer, audience, nonce and token hash', async () => {
  const key = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await webcrypto.subtle.exportKey('jwk', key.publicKey), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenResponse.access_token)));
  const claims = { sub: '42', iss: issuer, aud: 'test-client', nonce: 'expected-nonce', exp: 2000, iat: 1000, at_hash: base64url(digest.slice(0, 16)) };
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'test-key' })));
  async function sign(value) {
    const payload = `${header}.${base64url(new TextEncoder().encode(JSON.stringify(value)))}`;
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(payload));
    return `${payload}.${base64url(new Uint8Array(signature))}`;
  }
  const { client } = fixture(() => response({ keys: [jwk] }), { now: () => 1_500_000 });
  const options = { nonce: 'expected-nonce', accessToken: tokenResponse.access_token };
  assert.equal((await client.verifyIDToken(await sign(claims), options)).sub, '42');
  for (const changed of [{ iss: 'https://attacker.example.test' }, { aud: 'other-client' }, { nonce: 'wrong' }, { exp: 1000 }, { at_hash: 'wrong' }, { aud: ['test-client', 'other-client'] }]) {
    await assert.rejects(client.verifyIDToken(await sign({ ...claims, ...changed }), options), { code: 'invalid_id_token' });
  }
  const signed = await sign(claims);
  await assert.rejects(client.verifyIDToken(`${signed.slice(0, -8)}AAAAAAAA`, options));
});

test('revocation uses current refresh token and clears local credentials after server success', async () => {
  const { client, calls } = fixture(() => new Response(''));
  await client.setTokens(tokenResponse);
  await client.revoke();
  assert.equal(calls[1].init.body.get('token'), 'nao_rt_first');
  assert.equal(client.tokens, undefined);
});

test('discovery endpoints must remain on configured trusted issuer origin', async () => {
  const { client } = fixture(undefined, { fetch: () => response({ ...metadata, token_endpoint: 'https://attacker.example.test/token' }) });
  await assert.rejects(client.discover(), { code: 'invalid_endpoint' });
});

test('browser realtime uses a one-time ticket rather than exposing the OAuth access token', async () => {
  const { client, calls } = fixture(() => response({ success: true, data: { ticket: 'nao_ws_fixture', protocol: 'openai-insecure-api-key.nao_ws_fixture', expires_in: 60 } }));
  await client.setTokens(tokenResponse);
  class FakeWebSocket { constructor(url, protocols) { this.url = url; this.protocols = protocols; } }
  const connection = await client.connectRealtime('model/name', { WebSocket: FakeWebSocket });
  assert.equal(connection.url, 'wss://api.example.test/v1/realtime?model=model%2Fname');
  assert.deepEqual(connection.protocols, ['realtime', 'openai-insecure-api-key.nao_ws_fixture']);
  assert.equal(JSON.stringify(connection).includes(tokenResponse.access_token), false);
  assert.equal(calls[0].url, 'https://api.example.test/api/oauth2/relay-ticket');
});

test('hosted actions return only a trusted approval URL and receipt, with terminal status polling', async () => {
  const { client } = fixture((url) => url.endsWith('/actions') ? response({ success: true, data: { action_id: 'test-action', approval_url: '/oauth/actions/test-action', expires_at: 1000 } }) : response({ success: true, data: { action_id: 'test-action', status: 'completed', receipt: { completed: true } } }));
  await client.setTokens(tokenResponse);
  assert.equal((await client.startHostedAction('account.password')).approval_url, 'https://api.example.test/oauth/actions/test-action');
  assert.deepEqual((await client.waitForHostedAction('test-action')).receipt, { completed: true });
  const attacker = fixture(() => response({ success: true, data: { action_id: 'test', approval_url: 'https://attacker.example.test/oauth/actions/test' } })).client;
  await attacker.setTokens(tokenResponse);
  await assert.rejects(attacker.startHostedAction('account.password'), { code: 'invalid_response' });
});

test('hosted callback is one-use and secret claim stays in a body while receipt can outlive OAuth locally', async () => {
  const receipt = 'nao_ar_testreceipt';
  let creation;
  const { client, calls } = fixture((url, options) => {
    if (url.endsWith('/actions')) {
      creation = JSON.parse(options.body);
      return response({ success: true, data: { action_id: 'fixture-action', approval_url: '/oauth/actions/fixture-action', receipt_token: receipt } });
    }
    if (url.endsWith('/claim')) return response({ success: true, data: { key: 'fixture-claimed-secret' } });
    return response({ success: true, data: { status: 'completed', receipt: { completed: true } } });
  });
  await client.setTokens(tokenResponse);
  await client.startHostedAction('apikey.reveal', { id: 123 }, { shareResult: true, returnUri: 'https://client.example.test/action-callback?tenant=one' });
  assert.equal(creation.share_result, true);
  assert.equal(creation.return_uri, 'https://client.example.test/action-callback?tenant=one');
  const callback = `${creation.return_uri}&action_id=fixture-action&state=${creation.state}&status=forged-status`;
  assert.deepEqual(await client.completeHostedCallback(callback), { actionId: 'fixture-action' });
  await assert.rejects(client.completeHostedCallback(callback), { code: 'invalid_state' });
  assert.deepEqual(await client.claimHostedResult('fixture-action', receipt), { key: 'fixture-claimed-secret' });
  const claim = calls.find((call) => call.url.endsWith('/claim'));
  assert.equal(claim.url.includes(receipt), false);
  assert.deepEqual(JSON.parse(claim.init.body), { receipt_token: receipt });
  await client.setTokens(undefined);
  assert.equal((await client.getHostedAction('fixture-action', { receiptToken: receipt })).status, 'completed');
  assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${receipt}`);
});
