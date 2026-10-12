/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type { CodexBranch, CodexDetail, CodexItem, CodexTurn } from '../types'

export type ConversationExportBranch = CodexBranch

export interface ConversationExportOptions {
  /** Metadata for the selected branch only; other branch histories are not included. */
  branch?: ConversationExportBranch
  translate?: (key: string) => string
}

export interface ConversationExportMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  type: string
  text: string
  status?: string
  phase?: string
  attachments?: { type: string; path?: string; url?: string }[]
  command?: string
  cwd?: string
  output?: string
  exitCode?: number | null
  changes?: { path: string; kind?: string; diff?: string }[]
  tool?: string
  server?: string
  query?: string
  url?: string
  agentName?: string
  details?: Record<string, unknown>
  children?: ConversationExportMessage[]
}

export interface ConversationExportData {
  schema: 'new-api.codex.conversation'
  schemaVersion: 1
  scope: 'visible-conversation'
  project: { id: string; name: string }
  conversation: { id: string; name: string; threadId: string | null }
  branch: ConversationExportBranch | null
  model: string
  group?: string
  effort: string
  mode: string
  status: string
  persistenceError: boolean
  turns: {
    id: string
    status: string
    messages: ConversationExportMessage[]
    plan?: CodexTurn['plan']
    planExplanation?: string
    diff?: string
    error?: string
  }[]
}

export interface ConversationExportFile {
  filename: string
  mimeType: string
  content: string
}

function exportMessage(item: CodexItem): ConversationExportMessage {
  let text = item.text ?? ''
  if (item.type === 'userMessage') {
    text =
      item.content
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n') || text
  } else if (item.type === 'reasoning') {
    text = (item.summary ?? []).join('\n\n')
  }
  let role: ConversationExportMessage['role'] = 'tool'
  if (item.type === 'userMessage') role = 'user'
  if (item.type === 'agentMessage') role = 'assistant'
  const message: ConversationExportMessage = {
    id: item.id,
    role,
    type: item.type,
    text,
  }
  // Copy display fields explicitly. Native item bookkeeping and arbitrary
  // provider properties do not belong in a portable conversation export.
  for (const field of [
    'status',
    'phase',
    'command',
    'cwd',
    'tool',
    'server',
    'query',
    'url',
    'agentName',
  ] as const) {
    if (typeof item[field] === 'string') message[field] = item[field]
  }
  if (typeof item.aggregatedOutput === 'string') {
    message.output = item.aggregatedOutput
  }
  if (typeof item.exitCode === 'number' || item.exitCode === null) {
    message.exitCode = item.exitCode
  }
  if (item.changes) {
    message.changes = item.changes.map((change) => ({
      path: change.path,
      ...(change.kind
        ? {
            kind:
              typeof change.kind === 'string' ? change.kind : change.kind.type,
          }
        : {}),
      ...(change.diff !== undefined ? { diff: change.diff } : {}),
    }))
  }
  const attachments = item.content
    ?.filter((part) => part.type !== 'text' && (part.path || part.url))
    .map((part) => ({
      type: part.type,
      ...(part.path ? { path: part.path } : {}),
      ...(part.url ? { url: part.url } : {}),
    }))
  if (attachments?.length) message.attachments = attachments
  if (item.type === 'subagent' && Array.isArray(item.items)) {
    message.children = item.items
      .filter(
        (child): child is CodexItem =>
          child !== null &&
          typeof child === 'object' &&
          typeof child.id === 'string' &&
          typeof child.type === 'string'
      )
      .map(exportMessage)
  }
  if (role === 'tool') {
    const details = Object.fromEntries(
      ['arguments', 'result', 'action', 'error'].flatMap((field) =>
        item[field] === undefined ? [] : [[field, structuredClone(item[field])]]
      )
    )
    if (Object.keys(details).length) message.details = details
  }
  return message
}

/** Exports the loaded, visible conversation. This is not a native runner backup. */
export function conversationExportData(
  detail: CodexDetail,
  options: ConversationExportOptions = {}
): ConversationExportData {
  const conversationId =
    detail.conversationId ||
    detail.workspace.conversationId ||
    detail.workspace.id
  const conversation = detail.conversations?.find(
    (entry) => entry.id === conversationId
  )
  const conversationName =
    conversation?.name ||
    detail.workspace.conversationName ||
    detail.workspace.name
  const branch = options.branch ?? conversation?.branch
  return {
    schema: 'new-api.codex.conversation',
    schemaVersion: 1,
    scope: 'visible-conversation',
    project: { id: detail.workspace.id, name: detail.workspace.name },
    conversation: {
      id: conversationId,
      name: conversationName,
      threadId: detail.thread?.id ?? null,
    },
    branch: branch
      ? {
          rootConversationId: branch.rootConversationId,
          revisionId: branch.revisionId,
          version: branch.version,
          ...(branch.parentRevisionId
            ? { parentRevisionId: branch.parentRevisionId }
            : {}),
          ...(branch.replayTurnId ? { replayTurnId: branch.replayTurnId } : {}),
          ...(branch.turnIndex !== undefined
            ? { turnIndex: branch.turnIndex }
            : {}),
        }
      : null,
    model: detail.workspace.model,
    ...(detail.workspace.group ? { group: detail.workspace.group } : {}),
    effort: detail.workspace.effort,
    mode: detail.workspace.mode,
    status: detail.workspace.status,
    persistenceError: detail.persistenceError === true,
    turns: (detail.thread?.turns ?? []).map((turn) => {
      const assistantVisible = !turn.deletedRoles?.includes('assistant')
      return {
        id: turn.id,
        status: turn.status,
        messages: turn.items
          .filter((item) =>
            item.type === 'userMessage'
              ? !turn.deletedRoles?.includes('user')
              : assistantVisible
          )
          .map(exportMessage),
        ...(assistantVisible && turn.plan
          ? { plan: turn.plan.map((step) => ({ ...step })) }
          : {}),
        ...(assistantVisible && turn.planExplanation
          ? { planExplanation: turn.planExplanation }
          : {}),
        ...(assistantVisible && turn.diff ? { diff: turn.diff } : {}),
        ...(assistantVisible && turn.error?.message
          ? { error: turn.error.message }
          : {}),
      }
    }),
  }
}

function markdownLabel(value: string): string {
  return value
    .replaceAll(/[\r\n\t]+/g, ' ')
    .replaceAll(/[\\`*_{}[\]<>#|]/g, '\\$&')
}

function codeBlock(value: string, language = 'text'): string {
  // User messages, commands and patches can themselves contain fenced code.
  let longestFence = 2
  for (const match of value.matchAll(/`+/g)) {
    longestFence = Math.max(longestFence, match[0].length)
  }
  const fence = '`'.repeat(longestFence + 1)
  return `${fence}${language}\n${value}\n${fence}`
}

function markdownMessage(
  message: ConversationExportMessage,
  translate: (key: string) => string
): string {
  let title = translate('Tool activity')
  if (message.role === 'user') title = translate('User')
  else if (message.role === 'assistant') title = 'Codex'
  else if (message.type === 'reasoning') title = translate('Reasoning summary')
  else if (message.type === 'commandExecution') title = translate('Command')
  else if (message.type === 'plan') title = translate('Implementation plan')
  else if (message.type === 'subagent') {
    title = message.agentName || translate('Subagent')
  }
  const lines = [
    `### ${markdownLabel(title)}`,
    `${markdownLabel(message.type)} · ${markdownLabel(message.id)}`,
  ]
  if (message.status) {
    lines.push(`${translate('Status')}: ${markdownLabel(message.status)}`)
  }
  if (message.text) lines.push(message.text)
  if (message.type === 'contextCompaction') {
    lines.push(translate('Conversation context compacted.'))
  }
  if (message.command !== undefined) {
    lines.push(codeBlock(message.command, 'sh'))
  }
  if (message.cwd) lines.push(`cwd:\n\n${codeBlock(message.cwd)}`)
  if (message.output !== undefined) lines.push(codeBlock(message.output))
  if (message.exitCode !== undefined) {
    lines.push(`exitCode: ${message.exitCode ?? '—'}`)
  }
  for (const field of ['tool', 'server', 'query', 'url'] as const) {
    if (message[field]) lines.push(`${field}: ${markdownLabel(message[field])}`)
  }
  if (message.details) {
    lines.push(codeBlock(JSON.stringify(message.details, null, 2), 'json'))
  }
  for (const attachment of message.attachments ?? []) {
    lines.push(
      `${markdownLabel(attachment.type)}:\n\n${codeBlock(attachment.path || attachment.url || '')}`
    )
  }
  for (const change of message.changes ?? []) {
    lines.push(
      `#### ${markdownLabel(change.path)}${change.kind ? ` (${markdownLabel(change.kind)})` : ''}`
    )
    if (change.diff !== undefined) lines.push(codeBlock(change.diff, 'diff'))
  }
  for (const child of message.children ?? []) {
    lines.push(markdownMessage(child, translate))
  }
  return lines.join('\n\n')
}

export function exportCodexConversation(
  detail: CodexDetail,
  format: 'markdown' | 'json',
  options: ConversationExportOptions = {}
): ConversationExportFile {
  const data = conversationExportData(detail, options)
  const filename =
    [...data.conversation.name.replaceAll(/[\p{Cc}<>:"/\\|?*]+/gu, '-').trim()]
      .slice(0, 96)
      .join('')
      .replaceAll(/[. ]+$/g, '') || 'conversation'
  if (format === 'json') {
    return {
      filename: `${filename}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: `${JSON.stringify(data, null, 2)}\n`,
    }
  }
  const t = options.translate ?? ((key: string) => key)
  const lines = [
    `# ${markdownLabel(data.conversation.name)}`,
    `${t('Project')}: ${markdownLabel(data.project.name)}`,
    `conversationId: ${markdownLabel(data.conversation.id)}`,
    `threadId: ${markdownLabel(data.conversation.threadId || '—')}`,
    `${t('Model')}: ${markdownLabel(data.model)} · ${markdownLabel(data.effort)} · ${markdownLabel(data.mode)}`,
    `${t('Status')}: ${markdownLabel(data.status)}`,
    'schema: new-api.codex.conversation · version: 1 · scope: visible-conversation',
  ]
  if (data.branch) {
    lines.push(
      `branch:\n\n${codeBlock(JSON.stringify(data.branch, null, 2), 'json')}`
    )
  }
  if (data.persistenceError) lines.push(t('Project not saved'))
  for (const turn of data.turns) {
    if (
      !turn.messages.length &&
      !turn.plan?.length &&
      !turn.diff &&
      !turn.error
    ) {
      continue
    }
    lines.push(`## ${markdownLabel(turn.id)} · ${markdownLabel(turn.status)}`)
    for (const message of turn.messages) lines.push(markdownMessage(message, t))
    if (turn.plan?.length) {
      lines.push(`### ${t('Implementation plan')}`)
      if (turn.planExplanation) lines.push(turn.planExplanation)
      lines.push(
        turn.plan
          .map(
            (step) =>
              `- [${step.status === 'completed' ? 'x' : ' '}] ${markdownLabel(step.step)} (${step.status})`
          )
          .join('\n')
      )
    }
    if (turn.diff) lines.push(codeBlock(turn.diff, 'diff'))
    if (turn.error) lines.push(`${t('Task failed')}\n\n${turn.error}`)
  }
  return {
    filename: `${filename}.md`,
    mimeType: 'text/markdown;charset=utf-8',
    content: `${lines.join('\n\n')}\n`,
  }
}
