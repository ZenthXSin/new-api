import { randomUUID } from 'node:crypto';
import { apiError } from './store.mjs';

export const accountDynamicTools = [
  { type: 'function', name: 'newapi_list_tools', description: 'Discover New API tools for the current user: profile, preferences, API keys, subscriptions, wallet, usage and security. Call this before changing account settings.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'newapi_call_tool', description: 'Invoke a discovered New API account tool with its named arguments. Permissions and ownership are enforced by the server. Respect browser interaction_required results; never collect passwords, MFA codes, plaintext API keys or payment credentials.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false } },
];

export class AccountTools {
  constructor(manager, { fetchImpl = fetch } = {}) {
    this.manager = manager;
    this.fetch = fetchImpl;
    this.credentials = new Map();
    this.catalogs = new Map();
  }
  accept(owner, token) {
    if (token === undefined) return;
    if (typeof token !== 'string' || !token.startsWith('nact_') || token.length > 8192 || /[\s\x00]/.test(token)) throw apiError(403, 'invalid_tools_credentials', 'Invalid account tool authorization');
    if (this.credentials.get(owner) !== token) this.catalogs.delete(owner);
    const previous = this.credentials.get(owner);
    if (previous) this.manager.modelSecrets.delete(previous);
    this.credentials.set(owner, token);
    this.manager.modelSecrets.add(token);
  }
  async request(owner, suffix, body, signal) {
    const token = this.credentials.get(owner);
    if (!token || !this.manager.config.apiBaseUrl) throw apiError(401, 'tools_unavailable', 'Account tools need a new authenticated message');
    const endpoint = new URL(`/api/codex/tools/${suffix}`, this.manager.config.apiBaseUrl);
    const response = await this.fetch(endpoint, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    let bytes = 0, text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 512 * 1024) throw apiError(413, 'tool_result_too_large', 'Narrow the query to reduce the tool result');
      text += decoder.decode(chunk, {stream:true});
    }
    text += decoder.decode();
    let result;
    try { result = JSON.parse(text); } catch { throw apiError(502, 'tools_unavailable', 'Account tools returned an invalid result'); }
    if (!response.ok && !result.message) result.message = 'Account tool request failed';
    return result;
  }
  async catalog(owner, signal) {
    const result = await this.request(owner, 'catalog', undefined, signal);
    if (!result.success || !Array.isArray(result.data?.tools)) throw apiError(403, 'tools_unavailable', result.message || 'Account tools are unavailable');
    this.catalogs.set(owner, result.data);
    return result;
  }
  async execute(owner, name, args, signal) {
    return this.request(owner, 'call', { name, arguments: args, confirmed: true }, signal);
  }
  async handle(state, session, message) {
    const params = message.params || {}, owner = state.workspace.ownerId;
    const reply = (value) => {
      if (!session.intentionalClose) session.rpc.respond(message.id, { success: value.success === true, contentItems: [{ type: 'inputText', text: JSON.stringify(this.manager.sanitize(value)) }] });
    };
    try {
      if (params.namespace || !['newapi_list_tools', 'newapi_call_tool'].includes(params.tool)) throw apiError(400, 'unknown_tool', 'Unknown New API tool');
      if (!session.accountCalls) session.accountCalls = new Set();
      if (session.accountCalls.has(message.id)) return;
      session.accountCalls.add(message.id);
      if (params.tool === 'newapi_list_tools') { reply(await this.catalog(owner, session.toolAbort.signal)); return; }
      const { name, arguments: args } = params.arguments || {};
      if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 32 * 1024) throw apiError(400, 'invalid_tool', 'Supply a tool name and argument object');
      const catalog = this.catalogs.get(owner) || (await this.catalog(owner, session.toolAbort.signal)).data;
      const tool = catalog.tools.find(tool => tool.name === name);
      if (!tool || Object.keys(args).some(field => !Object.hasOwn(tool.inputSchema.properties, field))) throw apiError(400, 'invalid_tool', 'Use a discovered tool and its supported arguments');
      if (tool.mutating && state.workspace.mode === 'ask') throw apiError(403, 'read_only', 'Account settings cannot be changed in read-only mode');
      if (session.intentionalClose) return;
      if (tool.mutating && !['auto', 'full-access'].includes(state.workspace.mode)) {
        const approval = { id: randomUUID(), requestId: message.id, method: 'workbench/newapi/approval', params: { name, arguments: args, itemId: params.callId, reason: tool.description } };
        state.pendingApprovals.push(approval);
        state.workspace.status = 'waiting_approval';
        this.manager.store.record(state, 'workbench/approval/requested', { approval });
        await this.manager.store.persist(state);
        return;
      }
      const result = await this.execute(owner, name, args, session.toolAbort.signal);
      this.manager.store.record(state, 'workbench/newapi/completed', { name, success: result.success === true });
      reply(result);
    } catch (error) { reply({ success: false, code: error.code || 'tools_unavailable', message: error.code ? error.message : 'Account tools could not be reached; try a new message' }); }
  }
}
