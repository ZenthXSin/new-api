/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
// Server-only entry point. Never bundle application or webhook secrets into a browser.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class PaymentError extends Error {
  constructor(code, message, { status = 0, requestId } = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** Confidential application credentials are independent of delegated user OAuth tokens. */
export class NewApiPaymentClient {
  #origin;
  #authorization;
  #fetch;
  #timeoutMs;
  #sleep;

  constructor({ baseUrl, clientId, clientSecret, fetch = globalThis.fetch, timeoutMs = 15_000, sleep = delay } = {}) {
    let origin;
    try { origin = new URL(baseUrl); } catch { throw new PaymentError('invalid_configuration', 'Configure the New API HTTPS origin'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof clientId !== 'string' || !clientId || /[:\x00-\x20\x7f]/.test(clientId) || typeof clientSecret !== 'string' || !clientSecret || /[\x00-\x1f\x7f]/.test(clientSecret) ||
      typeof fetch !== 'function' || typeof sleep !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new PaymentError('invalid_configuration', 'Use a valid HTTPS origin and confidential application credentials on the server');
    }
    this.#origin = origin.origin;
    this.#authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
    this.#fetch = fetch;
    this.#timeoutMs = timeoutMs;
    this.#sleep = sleep;
  }

  async #request(method, path, body, { signal, maxRetries = 0 } = {}) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new PaymentError('invalid_request', 'maxRetries must be between 0 and 3');
    // Snapshot exactly once: create retries must retain the same external order ID and payload.
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let response;
      try {
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        response = await this.#fetch(this.#origin + path, {
          method, headers: { Accept: 'application/json', Authorization: this.#authorization, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(encoded === undefined ? {} : { body: encoded }), redirect: 'manual', credentials: 'omit',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch {
        signal?.throwIfAborted();
        if (attempt < maxRetries) { await this.#sleep(Math.min(200 * 2 ** attempt, 2000), undefined, { signal }); continue; }
        throw new PaymentError('network_error', 'Payment request outcome is unknown; query the order before retrying');
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
        await response.body?.cancel();
        await this.#sleep(Math.min(200 * 2 ** attempt, 2000), undefined, { signal });
        continue;
      }
      if (response.status >= 300 && response.status < 400) throw new PaymentError('unexpected_redirect', 'Payment API redirects are not accepted', { status: response.status });
      let payload;
      try { payload = await response.json(); } catch { throw new PaymentError('invalid_response', 'Payment API did not return JSON', { status: response.status }); }
      if (!response.ok || payload?.success !== true) {
        const code = /^PAYMENT_[A-Z0-9_]{1,64}$/.test(payload?.code ?? '') ? payload.code : 'payment_request_failed';
        const requestId = response.headers.get('X-Request-Id') ?? undefined;
        throw new PaymentError(code, 'New API did not complete the payment operation', { status: response.status, requestId });
      }
      if (payload.data === undefined || payload.data === null) throw new PaymentError('invalid_response', 'Payment API omitted its result', { status: response.status });
      return payload.data;
    }
  }

  #orderPath(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new PaymentError('invalid_request', 'Use a valid New API payment order ID');
    return `/api/payments/orders/${encodeURIComponent(id)}`;
  }

  createOrder(input, options) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PaymentError('invalid_request', 'Provide payment order fields');
    const { out_trade_no, title, amount, currency, return_url, expires_in } = input;
    const allowed = new Set(['out_trade_no', 'title', 'amount', 'currency', 'return_url', 'expires_in']);
    if (Object.keys(input).some((key) => !allowed.has(key)) || typeof out_trade_no !== 'string' || !out_trade_no.trim() || /[\x00\r\n]/.test(out_trade_no) || Buffer.byteLength(out_trade_no) > 128 ||
      typeof title !== 'string' || !title.trim() || Buffer.byteLength(title) > 256 || !Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000 || !['CNY', 'USD'].includes(currency) ||
      typeof return_url !== 'string' || !return_url || (expires_in !== undefined && (!Number.isInteger(expires_in) || expires_in < 60 || expires_in > 86400))) {
      throw new PaymentError('invalid_request', 'Invalid order fields; amounts use integer minor currency units');
    }
    return this.#request('POST', '/api/payments/orders', { out_trade_no, title, amount, currency, return_url, ...(expires_in === undefined ? {} : { expires_in }) }, options);
  }

  getOrder(id, options) { return this.#request('GET', this.#orderPath(id), undefined, options); }

  listOrders({ page = 1, pageSize = 20, ...options } = {}) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new PaymentError('invalid_request', 'Invalid payment order page');
    return this.#request('GET', `/api/payments/orders?${new URLSearchParams({ page: String(page), page_size: String(pageSize) })}`, undefined, options);
  }

  cancelOrder(id, { signal, maxRetries = 0 } = {}) {
    if (maxRetries !== 0) throw new PaymentError('invalid_request', 'Query cancellation status before retrying');
    return this.#request('POST', `${this.#orderPath(id)}/cancel`, undefined, { signal });
  }

  refundOrder(id, options = {}) {
    const { signal, maxRetries = 0 } = options;
    if (Object.keys(options).some((key) => !['signal', 'maxRetries'].includes(key))) throw new PaymentError('invalid_request', 'Refunds are full-order only; no amount or destination can be supplied');
    if (maxRetries !== 0) throw new PaymentError('invalid_request', 'Query refund status before retrying');
    return this.#request('POST', `${this.#orderPath(id)}/refund`, undefined, { signal });
  }

  checkoutUrl(order) {
    const path = this.#orderPath(order?.id).replace('/api/payments/orders/', '/payments/checkout/');
    let url;
    try { url = new URL(order.checkout_url, this.#origin); } catch { throw new PaymentError('invalid_response', 'Payment order omitted its checkout URL'); }
    if (url.origin !== this.#origin || url.pathname !== path || url.username || url.password || url.search || url.hash) throw new PaymentError('invalid_response', 'Payment checkout URL does not match this order and New API origin');
    return url.href;
  }
}

function webhookHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const entries = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  if (entries.length !== 1 || typeof entries[0][1] !== 'string') return null;
  return entries[0][1];
}

/** Verify the original HTTP body bytes before parsing JSON. Persist event.id atomically with fulfillment. */
export function verifyPaymentWebhook(rawBody, headers, { secret, secrets, now = Date.now, toleranceSeconds = 300 } = {}) {
  const keys = secrets ?? [secret];
  if ((secret !== undefined && secrets !== undefined) || !Array.isArray(keys) || keys.length < 1 || keys.length > 8 || keys.some((key) => typeof key !== 'string' || !key) || typeof now !== 'function' || !Number.isInteger(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > 300) {
    throw new PaymentError('invalid_configuration', 'Configure a webhook secret and a tolerance of at most 300 seconds');
  }
  if (!(rawBody instanceof Uint8Array) && !(rawBody instanceof ArrayBuffer)) throw new PaymentError('invalid_webhook', 'Pass the original HTTP body bytes, without JSON re-encoding');
  const body = rawBody instanceof ArrayBuffer ? Buffer.from(rawBody) : Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (body.length === 0 || body.length > 1024 * 1024) throw new PaymentError('invalid_webhook', 'Invalid webhook body size');
  const id = webhookHeader(headers, 'NewAPI-Webhook-Id');
  const timestamp = webhookHeader(headers, 'NewAPI-Webhook-Timestamp');
  const signature = webhookHeader(headers, 'NewAPI-Webhook-Signature');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id ?? '') || !/^[1-9][0-9]{0,12}$/.test(timestamp ?? '') || !/^v1=[0-9a-fA-F]{64}$/.test(signature ?? '')) {
    throw new PaymentError('invalid_webhook', 'Missing or ambiguous webhook authentication headers');
  }
  const current = now();
  if (!Number.isFinite(current) || Math.abs(current / 1000 - Number(timestamp)) > toleranceSeconds) throw new PaymentError('expired_webhook', 'Webhook timestamp is outside the accepted window');
  const received = Buffer.from(signature.slice(3), 'hex');
  let matched = 0;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(timestamp).update('.').update(body).digest();
    matched |= Number(timingSafeEqual(expected, received));
  }
  if (matched === 0) throw new PaymentError('invalid_signature', 'Webhook signature does not match');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new PaymentError('invalid_webhook', 'Webhook is not valid UTF-8 JSON'); }
  if (!event || Array.isArray(event) || typeof event !== 'object' || event.id !== id) throw new PaymentError('invalid_webhook', 'Webhook event ID does not match its signed body');
  return event;
}
