import { randomUUID } from 'node:crypto';
import { apiError } from './store.mjs';

export const portDynamicTools = [
  { type: 'function', name: 'codex_list_ports', description: 'List the public TCP ports for your Docker container, including connection addresses and the 10-port quota. A new authenticated conversation is required.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'codex_open_port', description: 'Expose one local TCP service in your Docker container to the internet through FRP. The server allocates a public port and configures its firewall. At most 10 ports per container. Existing mappings are reused for the same local port. The container must be running; the service may listen on localhost or 0.0.0.0.', inputSchema: { type: 'object', properties: { localPort: { type: 'integer', minimum: 1, maximum: 65535 }, label: { type: 'string', maxLength: 80 } }, required: ['localPort'], additionalProperties: false } },
  { type: 'function', name: 'codex_close_port', description: 'Close one of your Docker container public ports and release its quota slot. Use the mapping id returned by codex_list_ports or codex_open_port.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
];

export class PortTools {
  constructor(manager) { this.manager = manager; }
  accepts(name) { return portDynamicTools.some(tool => tool.name === name); }
  async execute(owner, name, args, signal) {
    const catalog = await this.manager.accountTools.catalog(owner, signal);
    if (catalog.data.allowDocker !== true) throw apiError(403, 'execution_disabled', 'Your Docker environment is not enabled');
    if (signal?.aborted) throw apiError(409, 'operation_canceled', 'The port request was canceled');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw apiError(400, 'invalid_port_forward', 'Supply a port argument object');
    let data;
    if (name === 'codex_list_ports' && !Object.keys(args).length) data = await this.manager.ports.list(owner);
    else if (name === 'codex_open_port') data = await this.manager.ports.open(owner, args, signal);
    else if (name === 'codex_close_port' && Object.keys(args).length === 1 && Object.hasOwn(args, 'id')) data = await this.manager.ports.remove(owner, args.id);
    else throw apiError(400, 'invalid_port_forward', 'Use a discovered port tool and its supported arguments');
    return { success: true, data };
  }
  async handle(state, session, message) {
    const reply = value => {
      if (!session.intentionalClose) session.rpc.respond(message.id, { success: value.success === true, contentItems: [{ type: 'inputText', text: JSON.stringify(this.manager.sanitize(value)) }] });
    };
    try {
      const params = message.params || {}, name = params.tool, args = params.arguments;
      const tool = portDynamicTools.find(tool => tool.name === name);
      if (params.namespace || !tool || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(field => !Object.hasOwn(tool.inputSchema.properties, field)) || Buffer.byteLength(JSON.stringify(args)) > 8192) throw apiError(400, 'invalid_port_forward', 'Supply the discovered port tool arguments');
      if (!session.portCalls) session.portCalls = new Set();
      if (session.portCalls.has(message.id)) return;
      session.portCalls.add(message.id);
      const mutating = name !== 'codex_list_ports';
      if (mutating && state.workspace.mode === 'ask') throw apiError(403, 'read_only', 'Public ports cannot be changed in read-only mode');
      if (name === 'codex_open_port') this.manager.ports.validateOpen(args);
      if (session.intentionalClose) return;
      if (mutating && !['auto', 'full-access'].includes(state.workspace.mode)) {
        const approval = { id: randomUUID(), requestId: message.id, method: 'workbench/ports/approval', params: { name, arguments: args, itemId: params.callId, reason: tool.description } };
        state.pendingApprovals.push(approval);
        state.workspace.status = 'waiting_approval';
        this.manager.store.record(state, 'workbench/approval/requested', { approval });
        await this.manager.store.persist(state);
        return;
      }
      const value = await this.execute(state.workspace.ownerId, name, args, session.toolAbort.signal);
      this.manager.store.record(state, 'workbench/ports/completed', { name, success: true });
      reply(value);
    } catch (error) { reply({ success: false, code: error.code || 'port_forward_unavailable', message: error.code ? error.message : 'The port forwarding service is unavailable' }); }
  }
}
