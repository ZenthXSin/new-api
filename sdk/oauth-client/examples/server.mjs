/* Copyright (C) 2026 QuantumNous and contributors. SPDX-License-Identifier: AGPL-3.0-or-later */
// An external client with tokens held only in server memory. No dependencies.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NewAPIOAuthClient } from '../index.mjs';

const issuer = process.env.NEW_API_ISSUER;
const clientId = process.env.NEW_API_CLIENT_ID;
const clientSecret = process.env.NEW_API_CLIENT_SECRET;
const origin = new URL(process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:8787').origin;
const scopes = (process.env.NEW_API_SCOPES ?? 'openid profile email full offline_access').split(/\s+/).filter(Boolean);
if (!issuer || !clientId) throw new Error('Set NEW_API_ISSUER and NEW_API_CLIENT_ID; register the exact callback DEMO_ORIGIN/callback first.');
const sessions = new Map();
const sessionTTL = 60 * 60_000;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function page(res, title, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(title)}</title><body><h1>${escapeHTML(title)}</h1>${body}</body></html>`);
}

function sessionFor(req, res) {
  const id = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('new_api_demo='))?.slice('new_api_demo='.length);
  let session = id ? sessions.get(id) : undefined;
  if (session && session.expiresAt <= Date.now()) { sessions.delete(id); session = undefined; }
  if (session) return session;
  const sessionId = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  session = { id: sessionId, csrf, expiresAt: Date.now() + sessionTTL, actions: new Map(), client: new NewAPIOAuthClient({ issuer, clientId, clientSecret, redirectUri: `${origin}/callback` }) };
  // SameSite=Lax is needed for the top-level OAuth GET callback.
  res.setHeader('Set-Cookie', `new_api_demo=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
  sessions.set(sessionId, session);
  return session;
}

async function readForm(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 16_384) throw new Error('Request is too large');
  }
  return new URLSearchParams(value);
}

async function verifyCSRF(req, session) {
  if (req.headers.origin !== origin) throw new Error('Request origin does not match');
  const form = await readForm(req);
  const provided = Buffer.from(form.get('csrf') ?? '');
  const expected = Buffer.from(session.csrf);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error('Invalid form session');
  return form;
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host) return page(res, '请求地址不匹配', '', 400);
    const url = new URL(req.url, origin);
    const session = sessionFor(req, res);
    const { client, csrf } = session;
    if (url.pathname === '/login' && req.method === 'POST') {
      await verifyCSRF(req, session);
      const authorization = await client.beginAuthorization({ scopes });
      res.writeHead(303, { Location: authorization.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (url.pathname === '/callback' && req.method === 'GET') {
      await client.completeAuthorization(url.href);
      sessions.delete(session.id);
      session.id = randomBytes(32).toString('base64url');
      session.csrf = randomBytes(32).toString('base64url');
      sessions.set(session.id, session);
      res.setHeader('Set-Cookie', `new_api_demo=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      await verifyCSRF(req, session);
      await client.revoke();
      sessions.delete(session.id);
      res.setHeader('Set-Cookie', `new_api_demo=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}`);
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/hosted' && req.method === 'POST') {
      const form = await verifyCSRF(req, session);
      const action = await client.startHostedAction(form.get('operation'), {}, { returnUri: `${origin}/action-callback` });
      session.actions.set(action.action_id, action.receipt_token);
      return page(res, '在 New API 完成本人操作', `<p><a href="${escapeHTML(action.approval_url)}" target="_blank" rel="noreferrer">打开 New API 操作页面</a></p><p>完成后返回此窗口。</p><p><a href="/action?id=${encodeURIComponent(action.action_id)}">查看结果</a></p>`);
    }
    if (url.pathname === '/action' && req.method === 'GET') {
      const actionId = url.searchParams.get('id');
      if (!session.actions.has(actionId)) throw new Error('Unknown operation');
      const action = await client.getHostedAction(actionId, { receiptToken: session.actions.get(actionId) });
      return page(res, '操作结果', `<pre>${escapeHTML(JSON.stringify(action, null, 2))}</pre><a href="/">返回首页</a>`);
    }
    if (url.pathname === '/action-callback' && req.method === 'GET') {
      const { actionId } = await client.completeHostedCallback(url.href);
      res.writeHead(303, { Location: `/action?id=${encodeURIComponent(actionId)}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (url.pathname !== '/' || req.method !== 'GET') return page(res, '页面不存在', '', 404);
    if (!client.tokens) return page(res, 'New API 外部 OAuth 客户端示例', `<p>授权页显示实际申请的权限，普通用户与管理员各自受现有权限约束。</p><form action="/login" method="post"><input type="hidden" name="csrf" value="${csrf}"><button>前往 New API 授权</button></form>`);
    const capabilities = await client.capabilities();
    const routes = await client.routes();
    const operations = await client.operations();
    return page(res, '已连接 New API', `<p>令牌仅保存在本示例服务端内存；浏览器页面不会展示令牌。下面的目录来自当前账号的真实接口。</p><h2>已授权能力</h2><pre>${escapeHTML(JSON.stringify(capabilities, null, 2))}</pre><h2>可用路由</h2><pre>${escapeHTML(JSON.stringify(routes, null, 2))}</pre><h2>本人确认操作与参数</h2><pre>${escapeHTML(JSON.stringify(operations, null, 2))}</pre><form action="/hosted" method="post"><input type="hidden" name="csrf" value="${csrf}"><label>无需固定对象参数的操作 <select name="operation" required>${(operations.data ?? []).filter((operation) => !(operation.parameters ?? []).some((field) => field.required)).map((operation) => `<option value="${escapeHTML(operation.id)}">${escapeHTML(operation.label)}</option>`).join('')}</select></label><button>发起并前往本站确认</button></form><form action="/logout" method="post"><input type="hidden" name="csrf" value="${csrf}"><button>撤销授权并退出</button></form>`);
  } catch (error) {
    // Neither the authorization code nor tokens, raw server bodies or URL query are logged.
    const code = typeof error?.code === 'string' ? error.code : 'request_failed';
    page(res, '操作未完成', `<p>错误类别：${escapeHTML(code)}</p><p><a href="/">返回首页</a></p>`, 400);
  }
});

const cleanup = setInterval(() => { for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id); }, 60_000);
cleanup.unref();
server.listen(Number(new URL(origin).port || 8787), '127.0.0.1', () => process.stdout.write(`New API OAuth demo: ${origin}\n`));
