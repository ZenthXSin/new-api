/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
// A single-user software membership demo. Replace demo login with your real application session.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NewApiPaymentClient, verifyPaymentWebhook } from '../payments.mjs';
import { MembershipStore } from './membership-store.mjs';

process.umask(0o077);
const origin = new URL(process.env.PAYMENT_DEMO_ORIGIN ?? 'http://127.0.0.1:8788').origin;
const clientId = process.env.NEW_API_CLIENT_ID;
const loginPassword = process.env.PAYMENT_DEMO_LOGIN_PASSWORD;
const webhookSecrets = (process.env.NEW_API_PAYMENT_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean);
if (!loginPassword || loginPassword.length < 12 || webhookSecrets.length === 0) throw new Error('Configure PAYMENT_DEMO_LOGIN_PASSWORD (12+ characters) and NEW_API_PAYMENT_WEBHOOK_SECRETS');
const client = new NewApiPaymentClient({ baseUrl: process.env.NEW_API_ORIGIN, clientId, clientSecret: process.env.NEW_API_CLIENT_SECRET });
const store = new MembershipStore(process.env.PAYMENT_DEMO_DATABASE ?? './payment-demo.sqlite');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function page(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>软件会员收款示例</title><h1>软件会员收款示例</h1>${body}</html>`);
}
async function rawBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function newSession(res, userId = '') {
  const token = randomBytes(32).toString('base64url');
  const session = { user_id: userId, csrf: randomBytes(24).toString('base64url') };
  store.saveSession(hash(token), userId, session.csrf, Math.floor(Date.now() / 1000) + 3600);
  res.setHeader('Set-Cookie', `payment_demo=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
  return session;
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host) return page(res, '请求地址不匹配', 400);
    const url = new URL(req.url, origin);
    if (req.method === 'POST' && url.pathname === '/payment-webhook') {
      // Do not place a JSON body parser before this route.
      let event;
      try { event = verifyPaymentWebhook(await rawBody(req), req.headers, { secrets: webhookSecrets }); }
      catch { res.writeHead(400); return res.end('Invalid notification'); }
      if (!['payment.paid', 'payment.refunded'].includes(event.type)) { res.writeHead(204); return res.end(); }
      try {
        const remote = await client.getOrder(event.data?.id, { maxRetries: 2 });
        store.applyPaymentEvent(event, remote, clientId);
        res.writeHead(204);
        return res.end();
      } catch {
        // Non-2xx schedules platform retries. Never acknowledge a failed fulfillment transaction.
        res.writeHead(503, { 'Retry-After': '30' });
        return res.end('Order processing pending');
      }
    }
    const token = (req.headers.cookie ?? '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('payment_demo='))?.slice(13);
    let session = token ? store.getSession(hash(token)) : undefined;
    if (!session) session = newSession(res);
    if (req.method === 'POST') {
      const form = new URLSearchParams((await rawBody(req)).toString('utf8'));
      if (req.headers.origin !== origin || !same(form.get('csrf') ?? '', session.csrf)) return page(res, '请求验证失败', 403);
      if (url.pathname === '/login') {
        if (!same(form.get('password') ?? '', loginPassword)) return page(res, '登录失败', 403);
        newSession(res, 'demo-member');
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (!session.user_id) return page(res, '请先登录软件示例', 401);
      if (url.pathname === '/buy' || url.pathname === '/retry') {
        let local;
        if (url.pathname === '/buy') {
          local = { out_trade_no: `membership_${randomBytes(18).toString('hex')}`, user_id: session.user_id, amount: 1990, currency: 'CNY' };
          store.createOrder(local);
        } else {
          local = store.getOrderForUser(form.get('out_trade_no'), session.user_id);
          if (!local) return page(res, '订单不存在', 404);
        }
        try {
          // Price and product are from this server, never trusted from browser fields.
          const order = await client.createOrder({ out_trade_no: local.out_trade_no, title: '示例软件30天会员', amount: local.amount, currency: local.currency, return_url: `${origin}/payment-return`, expires_in: 1800 }, { maxRetries: 2 });
          store.attachOrder(local.out_trade_no, order, clientId);
          res.writeHead(303, { Location: client.checkoutUrl(order), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
        } catch { return page(res, '订单已保存在本软件，可回首页重试同一订单。<p><a href="/">查看订单</a></p>', 503); }
      }
      return page(res, '页面不存在', 404);
    }
    if (req.method !== 'GET' || !['/', '/payment-return'].includes(url.pathname)) return page(res, '页面不存在', 404);
    if (!session.user_id) return page(res, `<form method="post" action="/login"><input type="hidden" name="csrf" value="${escapeHTML(session.csrf)}"><label>示例登录口令 <input type="password" name="password" required></label><button>登录</button></form>`);
    const membership = store.membershipForUser(session.user_id);
    const orders = store.ordersForUser(session.user_id).map((order) => `<li>${escapeHTML(order.out_trade_no)}：${escapeHTML(order.status)}${order.status === 'created' ? `<form method="post" action="/retry"><input type="hidden" name="csrf" value="${escapeHTML(session.csrf)}"><input type="hidden" name="out_trade_no" value="${escapeHTML(order.out_trade_no)}"><button>继续同一订单</button></form>` : ''}</li>`).join('');
    // Return URL parameters never mark paid or grant membership.
    return page(res, `<p>会员到期：${membership ? escapeHTML(new Date(membership * 1000).toISOString()) : '未开通'}</p>${url.pathname === '/payment-return' ? '<p>付款页面已返回；会员状态由验签通知及服务端查单更新，可刷新查看。</p>' : ''}<form method="post" action="/buy"><input type="hidden" name="csrf" value="${escapeHTML(session.csrf)}"><button>购买30天会员 ¥19.90</button></form><ul>${orders}</ul>`);
  } catch { if (!res.headersSent) page(res, '请求处理失败，请稍后查看订单状态', 500); else res.end(); }
});
server.listen(Number(new URL(origin).port || 8788), '127.0.0.1', () => process.stdout.write(`Membership payment demo: ${origin}\n`));
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => server.close(() => { store.close(); process.exit(0); }));
