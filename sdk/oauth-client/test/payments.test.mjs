/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NewApiPaymentClient, verifyPaymentWebhook } from '../payments.mjs';

const secret = 'whsec_local_fixture_not_a_real_secret';
const now = () => 1_800_000_000_000;
function signed(body, timestamp = '1800000000', id = 'evt_fixture_1') {
  return {
    'NewAPI-Webhook-Id': id,
    'NewAPI-Webhook-Timestamp': timestamp,
    'NewAPI-Webhook-Signature': 'v1=' + createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex'),
  };
}
const body = Buffer.from('{ "id": "evt_fixture_1", "type": "payment.paid", "data": {"external_order_no":"本地订单"} }\n');

test('payment webhook verifies original UTF-8 bytes and case-insensitive HTTP headers', () => {
  const headers = signed(body);
  assert.deepEqual(verifyPaymentWebhook(body, new Headers(headers), { secret, now }), JSON.parse(body));
  assert.deepEqual(verifyPaymentWebhook(body, Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])), { secret, now }), JSON.parse(body));
  const padded = Buffer.concat([Buffer.from('padding'), body, Buffer.from('ignored')]);
  assert.deepEqual(verifyPaymentWebhook(padded.subarray(7, 7 + body.length), headers, { secret, now }), JSON.parse(body));
});

test('payment webhook rejects modified payload, re-encoded JSON, wrong secret and unsigned header event IDs', () => {
  for (const [raw, headers, key] of [
    [Buffer.from(body.toString().replace('payment.paid', 'payment.refunded')), signed(body), secret],
    [Buffer.from(JSON.stringify(JSON.parse(body))), signed(body), secret],
    [body, signed(body), 'another_secret'],
    [body, { ...signed(body), 'NewAPI-Webhook-Id': 'evt_attacker_replay' }, secret],
  ]) assert.throws(() => verifyPaymentWebhook(raw, headers, { secret: key, now }));
});

test('payment webhook enforces both past and future timestamp boundaries without accepting ambiguous signatures', () => {
  for (const timestamp of ['1799999699', '1800000301']) assert.throws(() => verifyPaymentWebhook(body, signed(body, timestamp), { secret, now }), { code: 'expired_webhook' });
  assert.equal(verifyPaymentWebhook(body, signed(body, '1799999700'), { secret, now }).id, 'evt_fixture_1');
  for (const headers of [
    { ...signed(body), 'NewAPI-Webhook-Timestamp': '1800000000,1800000000' },
    { ...signed(body), 'NewAPI-Webhook-Signature': signed(body)['NewAPI-Webhook-Signature'] + ',v1=' + '0'.repeat(64) },
    { ...signed(body), 'newapi-webhook-id': 'evt_fixture_1' },
    { ...signed(body), 'NewAPI-Webhook-Id': ['evt_fixture_1'] },
  ]) assert.throws(() => verifyPaymentWebhook(body, headers, { secret, now }), { code: 'invalid_webhook' });
});

test('payment webhook rejects malformed signed bodies and requires raw bytes', () => {
  for (const raw of [Buffer.from('not json'), Buffer.from('[]'), Buffer.from('{"id":"wrong"}'), Buffer.from([0xff])]) {
    assert.throws(() => verifyPaymentWebhook(raw, signed(raw), { secret, now }), { code: 'invalid_webhook' });
  }
  assert.throws(() => verifyPaymentWebhook(JSON.parse(body), signed(body), { secret, now }), { code: 'invalid_webhook' });
  assert.throws(() => verifyPaymentWebhook(body.toString(), signed(body), { secret, now }), { code: 'invalid_webhook' });
});

test('repeated deliveries retain their event ID, requiring durable application-level deduplication', () => {
  const first = verifyPaymentWebhook(body, signed(body), { secret, now });
  const retry = verifyPaymentWebhook(body, signed(body, '1800000100'), { secret, now: () => now() + 100_000 });
  assert.equal(first.id, retry.id);
  assert.deepEqual(first, retry);
});

test('webhook key rotation accepts an explicitly retained key for an older queued event', () => {
  assert.equal(verifyPaymentWebhook(body, signed(body), { secrets: ['new_rotation_key', secret], now }).id, 'evt_fixture_1');
  assert.throws(() => verifyPaymentWebhook(body, signed(body), { secrets: ['new_rotation_key'], now }), { code: 'invalid_signature' });
  assert.throws(() => verifyPaymentWebhook(body, signed(body), { secret, secrets: [secret], now }), { code: 'invalid_configuration' });
  assert.throws(() => verifyPaymentWebhook(body, signed(body), { secrets: [], now }), { code: 'invalid_configuration' });
});

const orderInput = { out_trade_no: 'membership_order_1', title: 'Monthly membership', amount: 1990, currency: 'CNY', return_url: 'https://software.example/payment-return', expires_in: 1800 };
const order = { ...orderInput, id: 'pay_fixture_1', client_id: 'software_client', status: 'pending', checkout_url: 'https://new-api.example/payments/checkout/pay_fixture_1' };
const result = (data, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
function paymentClient(fetch, extra = {}) {
  return new NewApiPaymentClient({ baseUrl: 'https://new-api.example', clientId: 'software_client', clientSecret: 'server_only_fixture', fetch, sleep: async () => {}, ...extra });
}

test('payment client sends Basic credentials only to its fixed API and returns order data', async () => {
  const calls = [];
  const client = paymentClient(async (url, init) => { calls.push({ url, ...init }); return result(order, 201); });
  assert.deepEqual(await client.createOrder(orderInput), order);
  assert.equal(calls[0].url, 'https://new-api.example/api/payments/orders');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('software_client:server_only_fixture').toString('base64'));
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].body), orderInput);
  assert.equal(JSON.stringify(client), '{}', 'Private application credentials must not appear in JSON logging');
  assert.equal(client.checkoutUrl(order), order.checkout_url);
  assert.equal(client.checkoutUrl({ ...order, checkout_url: '/payments/checkout/pay_fixture_1' }), order.checkout_url);
  for (const checkout_url of ['https://evil.example/payments/checkout/pay_fixture_1', '/payments/checkout/other', '/payments/checkout/pay_fixture_1?secret=value']) assert.throws(() => client.checkoutUrl({ ...order, checkout_url }));
});

test('payment client validates monetary units and does not accept caller-controlled credentials or order routing', () => {
  let requests = 0;
  const client = paymentClient(async () => { requests++; return result(order); });
  for (const change of [{ amount: 19.9 }, { amount: 0 }, { amount: 100_000_001 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'EUR' }, { out_trade_no: '' }, { out_trade_no: ' \n' }, { title: '' }, { expires_in: 59 }, { payer_user_id: 5 }, { webhook_url: 'https://evil.example' }]) {
    assert.throws(() => client.createOrder({ ...orderInput, ...change }), { code: 'invalid_request' });
  }
  for (const id of ['../other', 'id?query=x', 'https://evil.example', '']) assert.throws(() => client.getOrder(id));
  for (const baseUrl of ['http://new-api.example', 'https://user:secret@new-api.example', 'https://new-api.example/path', 'https://new-api.example?x=1']) assert.throws(() => paymentClient(async () => result(order), { baseUrl }));
  assert.equal(requests, 0);
});

test('payment create retries only when requested and preserves an identical idempotent payload', async () => {
  const bodies = [];
  const input = { ...orderInput };
  const client = paymentClient(async (_url, init) => {
    bodies.push(init.body);
    input.amount = 2;
    if (bodies.length === 1) throw new TypeError('local network fixture');
    if (bodies.length === 2) return new Response('', { status: 503 });
    return result(order);
  });
  assert.equal((await client.createOrder(input, { maxRetries: 2 })).id, order.id);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0]), orderInput);
  let defaultCalls = 0;
  await assert.rejects(paymentClient(async () => { defaultCalls++; throw new Error('failure'); }).createOrder(orderInput), { code: 'network_error' });
  assert.equal(defaultCalls, 1);
});

test('payment requests retain typed conflicts without leaking upstream messages or retrying 409', async () => {
  let calls = 0;
  const client = paymentClient(async () => {
    calls++;
    return new Response(JSON.stringify({ success: false, code: 'PAYMENT_IDEMPOTENCY_CONFLICT', message: 'private provider secret sentinel' }), { status: 409 });
  });
  await assert.rejects(client.createOrder(orderInput, { maxRetries: 3 }), (error) => error.code === 'PAYMENT_IDEMPOTENCY_CONFLICT' && error.status === 409 && !String(error).includes('sentinel'));
  assert.equal(calls, 1);
  await assert.rejects(paymentClient(async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } })).getOrder(order.id), { code: 'unexpected_redirect' });
});

test('payment list, get, cancel and full refund use exact methods and never automatically repeat money changes', async () => {
  const calls = [];
  const client = paymentClient(async (url, init) => { calls.push({ url, method: init.method, body: init.body }); return result(order); });
  await client.getOrder(order.id);
  await client.listOrders({ page: 2, pageSize: 25 });
  await client.cancelOrder(order.id);
  await client.refundOrder(order.id);
  assert.deepEqual(calls, [
    { url: 'https://new-api.example/api/payments/orders/pay_fixture_1', method: 'GET', body: undefined },
    { url: 'https://new-api.example/api/payments/orders?page=2&page_size=25', method: 'GET', body: undefined },
    { url: 'https://new-api.example/api/payments/orders/pay_fixture_1/cancel', method: 'POST', body: undefined },
    { url: 'https://new-api.example/api/payments/orders/pay_fixture_1/refund', method: 'POST', body: undefined },
  ]);
  assert.throws(() => client.refundOrder(order.id, { maxRetries: 1 }));
  assert.throws(() => client.refundOrder(order.id, { amount: 1 }), { code: 'invalid_request' }, 'A requested partial refund must not silently become a full refund');
  assert.throws(() => client.cancelOrder(order.id, { maxRetries: 1 }));
});

test('payment caller cancellation aborts an active request and prevents retries', async () => {
  const abort = new AbortController();
  let calls = 0;
  const client = paymentClient(async (_url, init) => {
    calls++;
    abort.abort();
    init.signal.throwIfAborted();
  });
  await assert.rejects(client.createOrder(orderInput, { signal: abort.signal, maxRetries: 3 }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
