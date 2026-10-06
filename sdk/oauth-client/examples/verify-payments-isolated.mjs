/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
// Mutates only a disposable, never initialized loopback service. The runner disposes its database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { NewApiPaymentClient } from '../payments.mjs';

const origin = new URL(process.env.NEW_API_TEST_URL ?? 'http://127.0.0.1:3199');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || ['3000', '80', '443', ''].includes(origin.port)) throw new Error('Use a disposable loopback instance on an explicit nonproduction port');
const reportPath = process.env.NEW_API_TEST_REPORT;
const report = { origin: origin.origin, started_at: new Date().toISOString(), real_http: true, empty_database_required: true, real_provider_payments: 0, webhook_destination: 'https://localhost/events', checks: [] };
// User validation caps passwords and display names at 20 characters.
const passwords = { root: randomBytes(15).toString('base64url'), user: randomBytes(15).toString('base64url'), other: randomBytes(15).toString('base64url') };

async function api(path, { method = 'GET', json, session, expectedStatus = 200, headers = {} } = {}) {
  const response = await fetch(new URL(path, origin), { method, headers: { Accept: 'application/json', Origin: origin.origin, 'Sec-Fetch-Site': 'same-origin', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(session ? { Authorization: `Bearer ${session.access_token}`, 'New-Api-User': String(session.user.id) } : {}), ...headers }, ...(json === undefined ? {} : { body: JSON.stringify(json) }), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, expectedStatus, `${method} ${path} returned an unexpected status`);
  const body = await response.json();
  if (expectedStatus < 400) assert.notEqual(body.success, false, `${method} ${path} failed`);
  return body;
}

try {
  const setup = (await api('/api/setup')).data;
  assert.equal(setup.status, false, 'Refusing an initialized service');
  assert.equal(setup.root_init, false, 'Refusing an existing root account');
  await api('/api/setup', { method: 'POST', json: { username: 'paymentroot', password: passwords.root, confirmPassword: passwords.root, SelfUseModeEnabled: true, DemoSiteEnabled: false } });
  const root = (await api('/api/user/login', { method: 'POST', json: { username: 'paymentroot', password: passwords.root } })).data;
  await api('/api/option/', { method: 'PUT', session: root, json: { key: 'ServerAddress', value: origin.origin } });
  await api('/api/option/', { method: 'PUT', session: root, json: { key: 'oauth_provider.enabled', value: 'true' } });
  await api('/api/option/', { method: 'PUT', session: root, json: { key: 'oauth_provider.issuer', value: origin.origin + '/oidc' } });
  const users = {};
  for (const label of ['user', 'other']) {
    const username = `payment${label}`;
    await api('/api/user/', { method: 'POST', session: root, json: { username, password: passwords[label], display_name: 'Payment Test User', role: 1, group: 'default' } });
    users[label] = (await api('/api/user/login', { method: 'POST', json: { username, password: passwords[label] } })).data;
  }
  await api('/api/user/manage', { method: 'POST', session: root, json: { id: users.user.user.id, action: 'add_quota', mode: 'add', value: 5_000_000 } });
  const initialQuota = (await api('/api/user/self', { session: users.user })).data.quota;
  const clients = [];
  for (const name of ['first', 'second']) {
    const registration = (await api('/api/oauth_client/', { method: 'POST', session: root, json: { name: `Isolated payment ${name}`, redirect_uris: ['http://127.0.0.1:8788/payment-return'], scopes: ['openid', 'profile:read'], is_public: false, enabled: true } })).data;
    assert.ok(registration.client_secret);
    const clientId = registration.client.client_id;
    const application = (await api(`/api/payments/applications/${clientId}`, { method: 'PUT', session: root, json: { enabled: true, webhook_url: 'https://localhost/events', methods: ['balance'] } })).data;
    assert.ok(application.webhook_secret, 'First application save must return its signing secret');
    clients.push({ id: clientId, sdk: new NewApiPaymentClient({ baseUrl: origin.origin, clientId, clientSecret: registration.client_secret }) });
  }
  const [app, otherApp] = clients;
  const input = { out_trade_no: 'isolated-membership-1', title: 'Local acceptance membership', amount: 100, currency: 'USD', return_url: 'http://127.0.0.1:8788/payment-return', expires_in: 1800 };
  const order = await app.sdk.createOrder(input);
  assert.match(order.id, /^ap_[0-9a-f]{28}$/);
  assert.equal(new URL(app.sdk.checkoutUrl(order)).origin, origin.origin);
  await delay(1100); // Cross a wall-clock second: expires_in must remain idempotent.
  const repeated = await app.sdk.createOrder(input);
  assert.equal(repeated.id, order.id);
  assert.equal(repeated.expires_at, order.expires_at);
  await assert.rejects(app.sdk.createOrder({ ...input, amount: 101 }), { status: 409, code: 'PAYMENT_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(otherApp.sdk.getOrder(order.id), { status: 404 });
  const independent = await otherApp.sdk.createOrder(input);
  assert.notEqual(independent.id, order.id);
  await api('/api/payments/orders', { method: 'POST', session: users.user, json: input, expectedStatus: 401 });
  await api(`/api/payments/checkout/${order.id}`, { expectedStatus: 401 });
  assert.ok((await app.sdk.listOrders()).items.some((entry) => entry.id === order.id));
  report.checks.push('Basic-only application identity, per-application order isolation, cross-second create idempotency and typed amount conflict');

  const preview = (await api(`/api/payments/checkout/${order.id}`, { session: users.user })).data;
  assert.ok(preview.methods.some((method) => method.id === 'balance'));
  assert.ok(preview.confirmation_nonce);
  const required = preview.balance.required_quota;
  assert.ok(Number.isSafeInteger(required) && required > 0 && preview.balance.sufficient);
  const confirmation = { method: 'balance', confirmation_nonce: preview.confirmation_nonce };
  const firstPay = (await api(`/api/payments/checkout/${order.id}/confirm`, { method: 'POST', session: users.user, json: confirmation })).data;
  assert.equal(firstPay.order.status, 'paid');
  const repeatPay = (await api(`/api/payments/checkout/${order.id}/confirm`, { method: 'POST', session: users.user, json: confirmation })).data;
  assert.equal(repeatPay.order.status, 'paid');
  const afterPay = (await api('/api/user/self', { session: users.user })).data.quota;
  assert.equal(afterPay, initialQuota - required, 'Repeated confirmation must debit only once');
  const bound = await app.sdk.getOrder(order.id);
  assert.equal(bound.status, 'paid');
  assert.equal(bound.payer_user_id, users.user.user.id);
  const own = (await api('/api/payments/self/orders', { session: users.user })).data;
  assert.ok(own.items.some((entry) => entry.id === order.id));
  const other = (await api('/api/payments/self/orders', { session: users.other })).data;
  assert.ok(other.items.every((entry) => entry.id !== order.id));
  report.checks.push('Real session-bound checkout nonce, one balance debit, payer binding and self-order isolation');

  assert.equal((await app.sdk.refundOrder(order.id)).status, 'refunded');
  assert.equal((await app.sdk.refundOrder(order.id)).status, 'refunded');
  assert.equal((await api('/api/user/self', { session: users.user })).data.quota, initialQuota, 'Repeated full refund must credit only once');
  const canceled = await app.sdk.createOrder({ ...input, out_trade_no: 'isolated-cancel-1' });
  assert.equal((await app.sdk.cancelOrder(canceled.id)).status, 'canceled');
  assert.equal((await app.sdk.cancelOrder(canceled.id)).status, 'canceled');
  report.checks.push('Full balance refund is idempotent and restores exact quota; pending cancellation is idempotent');

  const events = (await api(`/api/payments/applications/${app.id}/events`, { session: root })).data;
  const forOrder = events.items.filter((entry) => entry.order_id === order.id);
  assert.equal(forOrder.filter((entry) => entry.type === 'payment.paid').length, 1);
  assert.equal(forOrder.filter((entry) => entry.type === 'payment.refunded').length, 1);
  assert.ok(forOrder.every((entry) => entry.delivered_at === 0), 'Localhost delivery is blocked and must never be acknowledged');
  assert.ok(forOrder.every((entry) => !('payload' in entry) && !('secret' in entry) && !('webhook_secret' in entry)));
  report.checks.push('Exactly one durable paid/refunded event each, safe Root event listing, no outbound payment or webhook delivery');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { name: error.name, code: error.code, status: error.status, message: error.message };
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: report.passed, checks: report.checks.length, ...(report.failure ? { failure: report.failure } : {}), report: reportPath ?? null }) + '\n');
}
