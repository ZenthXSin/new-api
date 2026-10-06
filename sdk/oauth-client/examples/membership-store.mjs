/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
// A durable fulfillment example, separate from the reusable payment SDK.
import { DatabaseSync } from 'node:sqlite';
import { PaymentError } from '../payments.mjs';

export class MembershipStore {
  #db;
  constructor(path) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS demo_orders (
        out_trade_no TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL,
        remote_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'created',
        fulfilled_at INTEGER NOT NULL DEFAULT 0, refunded_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS demo_events (id TEXT PRIMARY KEY, out_trade_no TEXT NOT NULL, processed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_entitlements (out_trade_no TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }
  close() { this.#db.close(); }
  createOrder({ out_trade_no, user_id, amount, currency }) {
    this.#db.prepare('INSERT INTO demo_orders (out_trade_no,user_id,amount,currency) VALUES (?,?,?,?)').run(out_trade_no, user_id, amount, currency);
  }
  attachOrder(outTradeNo, remote, clientId) {
    const local = this.#db.prepare('SELECT * FROM demo_orders WHERE out_trade_no=?').get(outTradeNo);
    if (!local || remote.client_id !== clientId || remote.out_trade_no !== local.out_trade_no || remote.amount !== local.amount || remote.currency !== local.currency || typeof remote.id !== 'string' || !remote.id) {
      throw new PaymentError('order_mismatch', 'Created payment does not match the local order');
    }
    if (local.remote_id && local.remote_id !== remote.id) throw new PaymentError('order_mismatch', 'Local order is already bound to a different payment');
    this.#db.prepare('UPDATE demo_orders SET remote_id=? WHERE out_trade_no=?').run(remote.id, outTradeNo);
  }
  getOrderForUser(outTradeNo, userId) { return this.#db.prepare('SELECT * FROM demo_orders WHERE out_trade_no=? AND user_id=?').get(outTradeNo, userId); }
  ordersForUser(userId) { return this.#db.prepare('SELECT * FROM demo_orders WHERE user_id=? ORDER BY rowid DESC LIMIT 20').all(userId); }
  membershipForUser(userId, nowSeconds = Math.floor(Date.now() / 1000)) {
    return this.#db.prepare('SELECT MAX(expires_at) AS expires_at FROM demo_entitlements WHERE user_id=? AND active=1 AND expires_at>?').get(userId, nowSeconds).expires_at ?? 0;
  }
  saveSession(tokenHash, userId, csrf, expiresAt) { this.#db.prepare('INSERT INTO demo_sessions VALUES (?,?,?,?)').run(tokenHash, userId, csrf, expiresAt); }
  getSession(tokenHash, nowSeconds = Math.floor(Date.now() / 1000)) { return this.#db.prepare('SELECT * FROM demo_sessions WHERE token_hash=? AND expires_at>?').get(tokenHash, nowSeconds); }

  // Call only after signature verification AND authenticated remote lookup.
  applyPaymentEvent(event, remote, clientId, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!['payment.paid', 'payment.refunded'].includes(event?.type) || typeof event?.id !== 'string' || !event.id || !event.data || !remote) throw new PaymentError('invalid_event', 'Unsupported payment event');
    const snapshot = event.data;
    if (snapshot.status !== (event.type === 'payment.paid' ? 'paid' : 'refunded')) throw new PaymentError('order_mismatch', 'Payment event status does not match its type');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const local = this.#db.prepare('SELECT * FROM demo_orders WHERE out_trade_no=?').get(snapshot.out_trade_no);
      if (!local || !local.remote_id) throw new PaymentError('order_not_ready', 'Local order is not available for fulfillment');
      for (const payment of [snapshot, remote]) {
        if (payment.id !== local.remote_id || payment.out_trade_no !== local.out_trade_no || payment.client_id !== clientId || payment.amount !== local.amount || payment.currency !== local.currency) {
          throw new PaymentError('order_mismatch', 'Payment amount, currency, application or order identity differs');
        }
      }
      // A paid notification can arrive after a refund. Never restore a refunded entitlement.
      if (!['paid', 'refunded'].includes(remote.status) || (event.type === 'payment.refunded' && remote.status !== 'refunded')) throw new PaymentError('payment_not_final', 'Payment status is not final; retry authenticated lookup later');
      const previous = this.#db.prepare('SELECT out_trade_no FROM demo_events WHERE id=?').get(event.id);
      if (previous && previous.out_trade_no !== local.out_trade_no) throw new PaymentError('order_mismatch', 'Event ID was previously used for another order');
      if (remote.status === 'refunded') {
        this.#db.prepare("UPDATE demo_orders SET status='refunded',refunded_at=CASE WHEN refunded_at=0 THEN ? ELSE refunded_at END WHERE out_trade_no=?").run(nowSeconds, local.out_trade_no);
        this.#db.prepare('UPDATE demo_entitlements SET active=0 WHERE out_trade_no=?').run(local.out_trade_no);
      } else if (!previous && local.status !== 'refunded' && local.fulfilled_at === 0) {
        const paidAt = remote.paid_at;
        if (!Number.isSafeInteger(paidAt) || paidAt <= 0) throw new PaymentError('invalid_event', 'Paid order omitted a valid payment time');
        // Demo product: one 30-day entitlement per local order, starting at verified paid_at.
        this.#db.prepare('INSERT INTO demo_entitlements VALUES (?,?,?,1)').run(local.out_trade_no, local.user_id, paidAt + 30 * 86400);
        this.#db.prepare("UPDATE demo_orders SET status='fulfilled',fulfilled_at=? WHERE out_trade_no=?").run(nowSeconds, local.out_trade_no);
      }
      if (!previous) this.#db.prepare('INSERT INTO demo_events VALUES (?,?,?)').run(event.id, local.out_trade_no, nowSeconds);
      this.#db.exec('COMMIT');
      return { duplicate: Boolean(previous), outTradeNo: local.out_trade_no };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
