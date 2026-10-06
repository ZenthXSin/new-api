/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembershipStore } from '../examples/membership-store.mjs';

const clientId = 'software_client';
const paid = { id: 'pay_fixture', client_id: clientId, out_trade_no: 'local_1', amount: 1990, currency: 'CNY', status: 'paid', paid_at: 1800000000 };
const event = { id: 'evt_1', type: 'payment.paid', created_at: 1800000000, data: paid };
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'new-api-fulfillment-'));
  const path = join(directory, 'test.sqlite');
  let store = new MembershipStore(path);
  store.createOrder({ out_trade_no: 'local_1', user_id: 'user_1', amount: 1990, currency: 'CNY' });
  store.attachOrder('local_1', { ...paid, status: 'pending' }, clientId);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new MembershipStore(path); return store; } };
}

test('software fulfillment commits order, entitlement and unique event together and survives restart', (t) => {
  const fixture = setup(t);
  assert.equal(fixture.store.applyPaymentEvent(event, paid, clientId, 1800000001).duplicate, false);
  const expected = paid.paid_at + 30 * 86400;
  assert.equal(fixture.store.membershipForUser('user_1', 1800000001), expected);
  const store = fixture.reopen();
  assert.equal(store.applyPaymentEvent(event, paid, clientId, 1800001000).duplicate, true);
  assert.equal(store.membershipForUser('user_1', 1800001000), expected, 'Repeated deliveries must not extend membership');
  assert.equal(store.getOrderForUser('local_1', 'user_2'), undefined, 'Another software user cannot read this order');
});

test('software fulfillment rejects wrong amount, currency, application and order binding before any grant', (t) => {
  const { store } = setup(t);
  for (const change of [{ amount: 1 }, { currency: 'USD' }, { client_id: 'other_application' }, { id: 'another_payment' }, { out_trade_no: 'another_local_order' }]) {
    assert.throws(() => store.applyPaymentEvent({ ...event, data: { ...paid, ...change } }, paid, clientId, 1800000001));
    assert.throws(() => store.applyPaymentEvent(event, { ...paid, ...change }, clientId, 1800000001));
    assert.equal(store.membershipForUser('user_1', 1800000001), 0);
  }
  assert.equal(store.applyPaymentEvent(event, paid, clientId, 1800000001).duplicate, false, 'Failed checks must not consume the event ID');
});

test('software fulfillment does not trust a paid notification without a final server lookup', (t) => {
  const { store } = setup(t);
  for (const status of ['pending', 'processing', 'failed', 'refunding']) assert.throws(() => store.applyPaymentEvent(event, { ...paid, status }, clientId), { code: 'payment_not_final' });
  assert.equal(store.membershipForUser('user_1', 1800000001), 0);
});

test('refund before or after paid notification never resurrects membership on an old event', (t) => {
  const { store } = setup(t);
  store.applyPaymentEvent(event, paid, clientId, 1800000001);
  const refunded = { ...paid, status: 'refunded', refunded_at: 1800000050 };
  store.applyPaymentEvent({ id: 'evt_refund', type: 'payment.refunded', data: refunded }, refunded, clientId, 1800000051);
  assert.equal(store.membershipForUser('user_1', 1800000051), 0);
  store.applyPaymentEvent(event, refunded, clientId, 1800000060);
  assert.equal(store.membershipForUser('user_1', 1800000060), 0);
  store.applyPaymentEvent({ ...event, id: 'evt_late_paid' }, paid, clientId, 1800000070);
  assert.equal(store.membershipForUser('user_1', 1800000070), 0, 'A stale lookup cannot overwrite the already committed refund');
});
