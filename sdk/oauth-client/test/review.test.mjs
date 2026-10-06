/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { NewAPIOAuthClient, base64url, readSSE } from '../index.mjs';

const issuer = 'https://api.example.test/oidc';
const redirectUri = 'https://client.example.test/callback';
const now = 1_700_000_000_000;
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  revocation_endpoint: `${issuer}/revoke`,
  jwks_uri: `${issuer}/jwks`,
};
const tokens = { access_token: 'review-access', refresh_token: 'review-refresh', token_type: 'Bearer', expires_in: 300 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(handler, options = {}) {
  return new NewAPIOAuthClient({
    issuer, clientId: 'review-client', redirectUri, crypto: webcrypto, now: () => now,
    fetch: async (url, init) => String(url).endsWith('openid-configuration') ? response(metadata) : handler(String(url), init),
    ...options,
  });
}

function barrier() {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  return { wait, release };
}

test('an in-flight refresh cannot restore a signed-out client or overwrite a new login', async () => {
  for (const replacement of [undefined, { ...tokens, access_token: 'new-login-access', refresh_token: 'new-login-refresh' }]) {
    for (const outcome of ['success', 'error']) {
      const entered = barrier();
      const finished = barrier();
      const saved = [];
      const client = fixture(async () => {
        entered.release();
        await finished.wait;
        if (outcome === 'error') throw new TypeError('Connection ended after refresh request');
        return response({ ...tokens, access_token: 'late-access', refresh_token: 'late-refresh' });
      }, { onTokens: (value) => saved.push(value) });
      await client.setTokens(tokens);
      const pending = client.refresh();
      await entered.wait;
      await client.setTokens(replacement);
      const writesBeforeResponse = saved.length;
      finished.release();
      await Promise.allSettled([pending]);
      assert.deepEqual(client.tokens, replacement, `Late ${outcome} must preserve the current authentication state`);
      assert.equal(saved.length, writesBeforeResponse, 'A stale refresh must not persist any credentials or clear a new login');
    }
  }
});

test('an in-flight authorization exchange cannot restore tokens after logout', async () => {
  const entered = barrier();
  const finished = barrier();
  const client = fixture(async () => {
    entered.release();
    await finished.wait;
    return response(tokens);
  });
  const { state } = await client.beginAuthorization({ scopes: ['profile:read'] });
  const authorization = client.completeAuthorization(`${redirectUri}?state=${state}&code=review-code`);
  await entered.wait;
  await client.revoke();
  finished.release();
  await Promise.allSettled([authorization]);
  assert.equal(client.tokens, undefined, 'A late authorization response must not reverse an explicit logout');
});

test('asynchronous credential persistence finishes logout after any earlier credential write', async () => {
  const entered = barrier();
  const finished = barrier();
  const writes = [];
  let stored;
  const client = fixture(() => response(tokens), {
    onTokens: async (value) => {
      writes.push(value);
      if (value) {
        entered.release();
        await finished.wait;
      }
      stored = value;
    },
  });
  const setting = client.setTokens(tokens);
  await entered.wait;
  const clearing = client.setTokens(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const callbacksBeforeRelease = writes.length;
  finished.release();
  await Promise.all([setting, clearing]);
  assert.equal(callbacksBeforeRelease, 1, 'A clear operation must wait for the earlier persistence write');
  assert.equal(stored, undefined, 'A delayed stored token must not overwrite persisted logout');
  assert.equal(client.tokens, undefined);
  assert.deepEqual(writes, [tokens, undefined]);
});

test('refresh rejects scope-changing options rather than silently retaining broader access', async () => {
  let calls = 0;
  const client = fixture(() => { calls++; return response(tokens); });
  await client.setTokens(tokens);
  await assert.rejects(client.refresh({ scopes: ['profile:read'] }), { code: 'invalid_request' });
  assert.equal(calls, 0);
});

test('OIDC authorization cannot silently succeed without the requested ID token', async () => {
  const client = fixture(() => response(tokens));
  const { state } = await client.beginAuthorization({ scopes: ['openid', 'profile'] });
  await assert.rejects(client.completeAuthorization(`${redirectUri}?state=${state}&code=review-code`));
  assert.equal(client.tokens, undefined, 'No credentials may be accepted when requested OIDC identity verification did not occur');
});

test('OAuth authorization without openid continues to accept an access token alone', async () => {
  const client = fixture(() => response(tokens));
  const { state } = await client.beginAuthorization({ scopes: ['profile:read'] });
  const result = await client.completeAuthorization(`${redirectUri}?state=${state}&code=review-code`);
  assert.equal(result.access_token, tokens.access_token);
  assert.equal('claims' in result, false);
});

const signingKey = await webcrypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
}, true, ['sign', 'verify']);
const jwk = { ...await webcrypto.subtle.exportKey('jwk', signingKey.publicKey), kid: 'review-key', use: 'sig', alg: 'RS256' };

async function signedIDToken(claims) {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: jwk.kid })));
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

test('refresh validates an included ID token and cannot change the authorized subject', async () => {
  for (const variant of ['different-subject', 'bad-signature']) {
    let firstIDToken;
    let refreshedIDToken;
    const client = fixture((url, init) => {
      if (url.endsWith('/jwks')) return response({ keys: [jwk] });
      const idToken = init.body.get('grant_type') === 'authorization_code' ? firstIDToken : refreshedIDToken;
      return response({ ...tokens, id_token: idToken });
    });
    const { state, url } = await client.beginAuthorization({ scopes: ['openid', 'profile', 'offline_access'] });
    const claims = { sub: 'original-user', iss: issuer, aud: 'review-client', nonce: new URL(url).searchParams.get('nonce'), exp: now / 1000 + 300, iat: now / 1000 };
    firstIDToken = await signedIDToken(claims);
    refreshedIDToken = variant === 'different-subject'
      ? await signedIDToken({ ...claims, sub: 'different-user' })
      : `${firstIDToken.slice(0, -8)}AAAAAAAA`;
    await client.completeAuthorization(`${redirectUri}?state=${state}&code=review-code`);
    await assert.rejects(client.refresh(), undefined, `Refresh must reject ${variant}`);
    assert.equal(client.tokens, undefined, 'Untrusted refreshed credentials must not replace the previous identity');
  }
});

test('SSE dispatches a complete CR-delimited event before another network chunk arrives', async () => {
  let controller;
  let cancelled = false;
  const stream = new ReadableStream({
    start(value) { controller = value; controller.enqueue(new TextEncoder().encode('data: first\r\r')); },
    cancel() { cancelled = true; },
  });
  const events = readSSE(stream);
  let delivered = false;
  const first = events.next().then((value) => { delivered = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  const deliveredWithoutMoreBytes = delivered;
  // Unblock an old implementation for cleanup without leaking a pending reader.
  if (!delivered) controller.enqueue(new TextEncoder().encode(': later\n\n'));
  const value = await first;
  await events.return();
  assert.equal(deliveredWithoutMoreBytes, true, 'A CR is a complete line terminator; waiting adds avoidable first-token latency');
  assert.deepEqual(value.value, { event: 'message', data: 'first', id: '' });
  assert.equal(cancelled, true);
});

test('SSE split CRLF is one line terminator and does not create an extra event', async () => {
  const chunks = ['data: first\r', '\ndata: second\r', '\n\r', '\ndata: third\n\n'];
  const stream = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
      else controller.close();
    },
  });
  const actual = [];
  for await (const event of readSSE(stream)) actual.push(event);
  assert.deepEqual(actual, [
    { event: 'message', data: 'first\nsecond', id: '' },
    { event: 'message', data: 'third', id: '' },
  ]);
});

test('hosted-action cancellation aborts the in-flight HTTP request and cannot return a late result', async () => {
  const entered = barrier();
  const finished = barrier();
  const controller = new AbortController();
  const abortReason = new DOMException('User cancelled the hosted operation wait', 'AbortError');
  let receivedSignal;
  const client = fixture(async (_url, init) => {
    receivedSignal = init.signal;
    entered.release();
    await finished.wait;
    // Model fetch abort behavior while guaranteeing cleanup on a failing implementation.
    receivedSignal?.throwIfAborted();
    return response({ success: true, data: { status: 'completed' } });
  });
  await client.setTokens(tokens);
  const result = client.waitForHostedAction('review-action', { signal: controller.signal });
  await entered.wait;
  controller.abort(abortReason);
  finished.release();
  const [outcome] = await Promise.allSettled([result]);
  assert.equal(receivedSignal?.aborted, true, 'The caller cancellation must reach the active request');
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason, abortReason);
});
