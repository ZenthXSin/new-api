/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
// Real HTTP acceptance against a disposable, never initialized, loopback instance.
// Usage: NEW_API_TEST_URL=http://127.0.0.1:5181 node sdk/oauth-client/examples/verify-isolated.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { NewAPIOAuthClient } from '../index.mjs';

const origin = new URL(process.env.NEW_API_TEST_URL ?? 'http://127.0.0.1:5181');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || ['3000', '80', '443', ''].includes(origin.port)) throw new Error('This script only accepts a disposable loopback service on a nonproduction explicit port.');
const generated = Object.fromEntries(await Promise.all(['capabilities', 'routes', 'actions'].map(async (name) => [name, JSON.parse(await readFile(new URL(`../../../docs/oauth-full-access/${name}.json`, import.meta.url), 'utf8'))])));
const reportPath = process.env.NEW_API_TEST_REPORT;
const report = { origin: origin.origin, started_at: new Date().toISOString(), real_http: true, isolated_empty_database_required: true, paid_upstream_calls: 0, generated_catalog_counts: { capabilities: generated.capabilities.capabilities.length, routes: generated.routes.routes.length, operations: generated.actions.operations.length }, checks: [], http: [] };
const sessions = new Map();
const passwords = { root: randomBytes(15).toString('base64url'), ordinary: randomBytes(15).toString('base64url') };
const createdClients = [];
const activeOAuth = [];

async function api(path, { method = 'GET', json, session, headers = {}, expectedStatus = 200 } = {}) {
  const response = await fetch(new URL(path, origin), {
    method, headers: { Accept: 'application/json', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Authorization: `Bearer ${session.access_token}`, 'New-Api-User': String(session.user.id) } : {}), Origin: origin.origin, 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  report.http.push({ method, path: new URL(path, origin).pathname, status: response.status });
  assert.equal(response.status, expectedStatus, `${method} ${new URL(path, origin).pathname} HTTP status`);
  const data = await response.json();
  assert.notEqual(data.success, false, `${method} ${new URL(path, origin).pathname} did not complete`);
  return data;
}

async function authorize(session, clientId, expectedScopes, label) {
  const redirectUri = 'http://127.0.0.1:8787/callback';
  const client = new NewAPIOAuthClient({ issuer: `${origin.origin}/oidc`, clientId, redirectUri });
  activeOAuth.push(client);
  const authorization = await client.beginAuthorization({ scopes: ['openid', 'profile', 'email', 'offline_access', 'full'] });
  const request = new URL(authorization.url);
  const response = await fetch(request, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 302, 'authorize redirects to the actual consent page');
  const consentURL = new URL(response.headers.get('location'), origin);
  assert.equal(consentURL.origin, origin.origin);
  assert.equal(consentURL.pathname, '/authorize');
  const preview = await api(`/api/oauth2/consent?${consentURL.searchParams}`, { session });
  assert.equal(preview.require_consent, true);
  assert.ok(preview.consent_token);
  assert.deepEqual([...preview.scopes].sort(), [...expectedScopes].sort(), `${label} full expands exactly to current permitted capabilities`);
  assert.equal(preview.scopes.includes('full'), false);
  const payload = Object.fromEntries([...consentURL.searchParams].filter(([key]) => key !== 'resource' && key !== 'response_type'));
  payload.resources = consentURL.searchParams.getAll('resource');
  payload.consent_token = preview.consent_token;
  payload.selected_scopes = preview.scopes;
  payload.approve = true;
  const approval = await api('/api/oauth2/consent', { method: 'POST', json: payload, session });
  const callback = new URL(approval.redirect);
  assert.equal(callback.origin, new URL(redirectUri).origin);
  assert.equal(callback.searchParams.get('iss'), `${origin.origin}/oidc`);
  const tokens = await client.completeAuthorization(callback.href);
  assert.ok(tokens.access_token.startsWith('nao_at_'));
  assert.ok(tokens.refresh_token.startsWith('nao_rt_'));
  assert.equal(tokens.claims.sub, String(session.user.id));
  assert.deepEqual(tokens.scope.split(' ').sort(), [...expectedScopes].sort());
  const own = await client.json('/api/user/self');
  assert.equal(own.data.id, session.user.id);
  const catalog = await client.capabilities();
  assert.equal(catalog.data.catalog_version, generated.capabilities.catalog_version);
  assert.deepEqual([...catalog.data.granted_scopes].sort(), [...expectedScopes].sort());
  assert.deepEqual(catalog.data.capabilities, generated.capabilities.capabilities.filter((capability) => expectedScopes.includes(capability.scope)), `${label} capability metadata matches the generated contract`);
  const routeCatalog = await client.routes();
  const routes = Array.isArray(routeCatalog.data) ? routeCatalog.data : routeCatalog.data.routes;
  assert.ok(Array.isArray(routes) && routes.length > 0);
  assert.equal(routeCatalog.data.catalog_version, generated.routes.catalog_version);
  const expectedRoutes = generated.routes.routes.filter((route) => route.min_role <= session.user.role && (!route.scope || expectedScopes.includes(route.scope)));
  const byRoute = (left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`);
  assert.deepEqual([...routes].sort(byRoute), expectedRoutes.sort(byRoute), `${label} exact route policies match the generated contract`);
  const operations = await client.operations();
  assert.ok(Array.isArray(operations.data) && operations.data.length > 0);
  for (const operation of operations.data) {
    assert.ok(expectedScopes.includes(operation.scope), `${label} operation requires a granted scope`);
    assert.deepEqual(operation, generated.actions.operations.find((entry) => entry.id === operation.id), `${label} operation fields and steps match the generated contract`);
  }
  if (session.user.role === 100) assert.deepEqual(operations.data, generated.actions.operations, 'root operation catalog includes every registered operation');
  const before = client.tokens.refresh_token;
  await client.refresh();
  assert.notEqual(client.tokens.refresh_token, before);
  assert.equal((await client.json('/api/user/self')).data.id, session.user.id);
  report.checks.push({ name: `${label}: real PKCE, explicit consent, ID token verification, profile, generated capability/route/operation contracts, refresh`, passed: true, scope_count: expectedScopes.length, visible_route_count: routes.length, operation_count: operations.data.length });
  return { client, routes };
}

let initialized = false;
try {
  const setup = await api('/api/setup');
  assert.equal(setup.data.status, false, 'Refusing to mutate an already initialized service');
  assert.equal(setup.data.root_init, false, 'Refusing to use a database containing an existing root user');
  await api('/api/setup', { method: 'POST', json: { username: 'oauthroot', password: passwords.root, confirmPassword: passwords.root, SelfUseModeEnabled: true, DemoSiteEnabled: false } });
  initialized = true;
  const root = (await api('/api/user/login', { method: 'POST', json: { username: 'oauthroot', password: passwords.root } })).data;
  assert.equal(root.user.role, 100);
  sessions.set('root', root);
  await api('/api/option/', { method: 'PUT', session: root, json: { key: 'oauth_provider.issuer', value: `${origin.origin}/oidc` } });
  await api('/api/option/', { method: 'PUT', session: root, json: { key: 'oauth_provider.enabled', value: 'true' } });
  await api('/api/user/', { method: 'POST', session: root, json: { username: 'oauthuser', password: passwords.ordinary, display_name: 'Isolated OAuth User', role: 1, group: 'default' } });
  const ordinary = (await api('/api/user/login', { method: 'POST', json: { username: 'oauthuser', password: passwords.ordinary } })).data;
  assert.equal(ordinary.user.role, 1);
  sessions.set('ordinary', ordinary);
  const rootCapabilities = (await api('/api/oauth2/capabilities', { session: root })).data.capabilities;
  const userCapabilities = (await api('/api/oauth2/capabilities', { session: ordinary })).data.capabilities;
  const registration = (await api('/api/oauth_client/', { method: 'POST', session: root, json: { name: 'Isolated SDK HTTP Acceptance', description: 'Temporary local test client', redirect_uris: ['http://127.0.0.1:8787/callback', 'http://127.0.0.1:8787/action-callback'], scopes: rootCapabilities.map((capability) => capability.scope), is_public: true, enabled: true } })).data;
  assert.equal(registration.client.is_public, true);
  assert.equal(registration.client_secret, '');
  createdClients.push(registration.client.id);
  const normal = await authorize(ordinary, registration.client.client_id, userCapabilities.map((capability) => capability.scope), 'ordinary user');
  assert.ok(normal.routes.every((route) => route.min_role <= 1));
  assert.ok(!normal.client.tokens.scope.split(' ').some((scope) => scope.startsWith('channel:')));
  await assert.rejects(normal.client.json('/api/channel/'), (error) => error.status === 403);
  assert.equal((await normal.client.json('/api/group-availability?range=90m')).success, true);
  const modelList = await normal.client.json('/v1/models');
  assert.ok(Array.isArray(modelList.data));
  report.checks.push({ name: 'ordinary scope contains no channel administration, channel endpoint denied, group health and model metadata readable without upstream calls', passed: true });
  const action = await normal.client.startHostedAction('sessions.list', {}, { shareResult: true, returnUri: 'http://127.0.0.1:8787/action-callback' });
  const hostedPreview = (await api(`/api/oauth2/actions/${action.action_id}/approval`, { session: ordinary })).data;
  assert.equal(hostedPreview.operation, 'sessions.list');
  await api(`/api/oauth2/actions/${action.action_id}/approve`, { method: 'POST', session: ordinary, json: { approval_nonce: hostedPreview.approval_nonce, verification_password: passwords.ordinary } });
  const stepResult = await api(`/api/oauth2/actions/${action.action_id}/steps/${hostedPreview.current_step_id}`, { method: 'POST', session: ordinary, json: { approval_nonce: hostedPreview.approval_nonce, input: {} } });
  assert.equal(stepResult.action_status, 'completed');
  const callbackResult = await normal.client.completeHostedCallback(stepResult.return_uri);
  assert.equal(callbackResult.actionId, action.action_id);
  const receipt = await normal.client.waitForHostedAction(action.action_id, { receiptToken: action.receipt_token });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.receipt.completed, true);
  assert.equal(receipt.data, undefined);
  const sessionList = await normal.client.claimHostedResult(action.action_id, action.receipt_token);
  assert.ok(Array.isArray(sessionList) && sessionList.length > 0);
  assert.ok(sessionList.every((item) => !('access_token' in item) && !('refresh_token' in item)));
  await assert.rejects(normal.client.claimHostedResult(action.action_id, action.receipt_token));
  report.checks.push({ name: 'hosted session-list operation completes through real browser session/password confirmation, SDK validates callback, minimal receipt and one-use typed list claim', passed: true });
  const admin = await authorize(root, registration.client.client_id, rootCapabilities.map((capability) => capability.scope), 'root administrator');
  assert.ok(admin.client.tokens.scope.split(' ').includes('channel:secret_view'));
  const tickets = await admin.client.createRelayTicket();
  assert.equal(tickets.expires_in, 60);
  report.checks.push({ name: 'root full contains current administrator capabilities and issues a one-use realtime ticket', passed: true });
  for (const { client, label } of [{ client: normal.client, label: 'ordinary' }, { client: admin.client, label: 'root' }]) {
    const access = client.tokens.access_token;
    await client.revoke();
    const revoked = await fetch(new URL('/api/user/self', origin), { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(15_000) });
    assert.equal(revoked.status, 401);
    report.checks.push({ name: `${label}: actual revocation rejects the previously valid access token`, passed: true });
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, code: error.code, message: error.message, status: error.status };
  process.exitCode = 1;
} finally {
  // Disable the temporary client even on failure. Container/database disposal remains the runner's job.
  for (const client of activeOAuth) if (client.tokens) await client.revoke().catch(() => {});
  if (initialized && sessions.has('root')) for (const id of createdClients) await api(`/api/oauth_client/${id}`, { method: 'DELETE', session: sessions.get('root') }).catch(() => {});
  report.finished_at = new Date().toISOString();
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: report.passed, checks: report.checks.length, ...(report.failure ? { failure: report.failure } : {}), report: reportPath ?? null }, null, 2) + '\n');
}
