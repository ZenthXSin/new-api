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
import type {
  CodexDetail,
  CodexEvent,
  CodexEvents,
  CodexItem,
  CodexTurn,
} from '../types'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export function applyCodexEvent(
  detail: CodexDetail,
  event: CodexEvent
): CodexDetail {
  if (event.seq <= detail.nextCursor) return detail
  const next: CodexDetail = {
    ...detail,
    nextCursor: event.seq,
    // Keep the same bounded recent-event history returned by the detail API.
    // Unknown native notifications remain available instead of being discarded.
    events: [...detail.events, event].slice(-100),
  }
  const params = event.params
  if (event.method === 'workbench/subagent/event') {
    return applySubagentEvent(next, event)
  }
  if (
    event.method === 'workbench/interrupted' ||
    (event.method === 'workbench/error' && detail.workspace.status === 'error')
  ) {
    const activeId = detail.workspace.activeTurnId
    const active =
      detail.thread?.turns.find((turn) => turn.id === activeId) ??
      [...(detail.thread?.turns ?? [])]
        .reverse()
        .find((turn) => turn.status === 'inProgress')
    if (
      !active ||
      ['completed', 'failed', 'interrupted'].includes(active.status)
    ) {
      return next
    }
    const status =
      event.method === 'workbench/interrupted' ? 'interrupted' : 'failed'
    return {
      ...next,
      thread: detail.thread
        ? {
            ...detail.thread,
            turns: detail.thread.turns.map((turn) =>
              turn.id === active.id
                ? {
                    ...turn,
                    status,
                    error:
                      typeof params.message === 'string'
                        ? { message: params.message }
                        : turn.error,
                    items: turn.items.map((item) =>
                      stopCodexItem(item, status)
                    ),
                  }
                : turn
            ),
          }
        : null,
    }
  }
  if (event.method === 'workbench/thread/replaced') {
    return {
      ...next,
      events: [event],
      thread: params.thread as CodexDetail['thread'],
    }
  }
  if (event.method === 'workbench/message/deleted') {
    return {
      ...next,
      thread: detail.thread
        ? {
            ...detail.thread,
            turns: detail.thread.turns.map((turn) =>
              turn.id === params.turnId
                ? {
                    ...turn,
                    deletedRoles: [
                      ...new Set([
                        ...(turn.deletedRoles ?? []),
                        params.role as 'user' | 'assistant',
                      ]),
                    ],
                  }
                : turn
            ),
          }
        : null,
    }
  }
  if (event.method === 'thread/started') {
    const thread = record(params.thread)
    if (typeof thread.id === 'string') {
      if (detail.thread && detail.thread.id !== thread.id) {
        next.events = [event]
      }
      const turns =
        detail.thread?.id === thread.id ? [...detail.thread.turns] : []
      if (Array.isArray(thread.turns)) {
        for (const incoming of thread.turns as CodexTurn[]) {
          const index = turns.findIndex((turn) => turn.id === incoming.id)
          if (index < 0) turns.push(incoming)
          else turns[index] = mergeCodexTurn(turns[index], incoming)
        }
      }
      next.thread = { id: thread.id, turns }
    }
    return next
  }
  const thread = detail.thread ?? { id: text(params.threadId), turns: [] }
  const turns = [...thread.turns]
  const turnValue = record(params.turn)
  const turnId =
    text(params.turnId) ||
    text(turnValue.id) ||
    detail.workspace.activeTurnId ||
    turns.at(-1)?.id ||
    ''
  let index = turns.findIndex((turn) => turn.id === turnId)
  if (event.method === 'turn/started' || event.method === 'turn/completed') {
    if (!turnId) return next
    const previous = index < 0 ? undefined : turns[index]
    const items = [...(previous?.items ?? [])]
    if (Array.isArray(turnValue.items)) {
      for (const incoming of turnValue.items as CodexItem[]) {
        const existingIndex = items.findIndex((item) => item.id === incoming.id)
        if (existingIndex < 0) items.push(incoming)
        else items[existingIndex] = { ...items[existingIndex], ...incoming }
      }
    }
    const turn: CodexTurn = {
      ...previous,
      id: turnId,
      status:
        text(turnValue.status) ||
        (event.method === 'turn/started' ? 'inProgress' : 'completed'),
      items,
      error: turnValue.error as CodexTurn['error'],
    }
    if (index < 0) turns.push(turn)
    else turns[index] = turn
    const started = event.method === 'turn/started'
    const updated = {
      ...next,
      workspace: {
        ...next.workspace,
        activeTurnId: started ? turnId : null,
      },
      thread: { ...thread, turns },
    }
    // Child thread announcements can arrive before the first root turn.
    return started ? restoreCodexDetail(updated) : updated
  }
  if (
    (event.method === 'turn/plan/updated' ||
      event.method === 'turn/diff/updated') &&
    turnId
  ) {
    const previous =
      index < 0 ? { id: turnId, status: 'inProgress', items: [] } : turns[index]
    const turn: CodexTurn = { ...previous }
    if (event.method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      turn.plan = params.plan.flatMap((value) => {
        const entry = record(value)
        const status = entry.status
        return typeof entry.step === 'string' &&
          (status === 'pending' ||
            status === 'inProgress' ||
            status === 'completed')
          ? [{ step: entry.step, status }]
          : []
      })
      turn.planExplanation =
        typeof params.explanation === 'string' ? params.explanation : null
    }
    if (
      event.method === 'turn/diff/updated' &&
      typeof params.diff === 'string'
    ) {
      turn.diff = params.diff
    }
    if (index < 0) turns.push(turn)
    else turns[index] = turn
    return { ...next, thread: { ...thread, turns } }
  }
  if (!event.method.startsWith('item/') || !turnId) return next
  if (index < 0) {
    turns.push({ id: turnId, status: 'inProgress', items: [] })
    index = turns.length - 1
  }
  const turn = { ...turns[index], items: [...turns[index].items] }
  const itemValue = record(params.item)
  const itemId = text(params.itemId) || text(itemValue.id)
  if (!itemId) return next
  const itemIndex = turn.items.findIndex((item) => item.id === itemId)
  let item: CodexItem =
    itemIndex < 0
      ? { id: itemId, type: event.method.split('/')[1] }
      : { ...turn.items[itemIndex] }
  if (event.method === 'item/started' || event.method === 'item/completed') {
    item = { ...item, ...itemValue } as CodexItem
  } else if (event.method === 'item/agentMessage/delta') {
    item.type = 'agentMessage'
    item.text = (item.text ?? '') + text(params.delta)
  } else if (event.method === 'item/commandExecution/outputDelta') {
    item.type = 'commandExecution'
    item.aggregatedOutput = (item.aggregatedOutput ?? '') + text(params.delta)
  } else if (event.method === 'item/reasoning/summaryTextDelta') {
    item.type = 'reasoning'
    const summary = [...(item.summary ?? [])]
    const summaryIndex =
      typeof params.summaryIndex === 'number' &&
      Number.isInteger(params.summaryIndex) &&
      params.summaryIndex >= 0 &&
      params.summaryIndex < 1000
        ? params.summaryIndex
        : 0
    summary[summaryIndex] = (summary[summaryIndex] ?? '') + text(params.delta)
    item.summary = summary
  } else if (event.method === 'item/plan/delta') {
    item.type = 'plan'
    item.text = (item.text ?? '') + text(params.delta)
  } else {
    return next
  }
  if (itemIndex < 0) turn.items.push(item)
  else turn.items[itemIndex] = item
  turns[index] = turn
  return { ...next, thread: { ...thread, turns } }
}

function stopCodexItem(
  item: CodexItem,
  status: 'interrupted' | 'failed'
): CodexItem {
  const stopped = ['inProgress', 'starting', 'running'].includes(
    item.status ?? ''
  )
    ? { ...item, status }
    : item
  if (item.type !== 'subagent' || !Array.isArray(item.turns)) return stopped
  const turns = (item.turns as CodexTurn[]).map((turn) => ({
    ...turn,
    status: turn.status === 'inProgress' ? status : turn.status,
    items: turn.items.map((child) => stopCodexItem(child, status)),
  }))
  return { ...stopped, turns, items: turns.flatMap((turn) => turn.items) }
}

function mergeCodexTurn(previous: CodexTurn, incoming: CodexTurn): CodexTurn {
  const items = [...previous.items]
  for (const item of incoming.items ?? []) {
    const index = items.findIndex((entry) => entry.id === item.id)
    if (index < 0) items.push(item)
    else items[index] = { ...items[index], ...item }
  }
  return { ...previous, ...incoming, items }
}

function applySubagentEvent(
  detail: CodexDetail,
  event: CodexEvent
): CodexDetail {
  const notification = record(event.params.event)
  const method = text(notification.method)
  const params = record(notification.params)
  const metadata = record(params.thread)
  const threadId =
    text(params.threadId) ||
    (method === 'thread/started' ? text(metadata.id) : '')
  if (
    !threadId ||
    threadId === detail.thread?.id ||
    !detail.thread ||
    !method ||
    method.startsWith('workbench/')
  ) {
    return detail
  }
  const supported =
    method === 'thread/started' ||
    method === 'turn/started' ||
    method === 'turn/completed' ||
    method === 'turn/plan/updated' ||
    method === 'turn/diff/updated' ||
    method === 'item/started' ||
    method === 'item/completed' ||
    method === 'item/agentMessage/delta' ||
    method === 'item/commandExecution/outputDelta' ||
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/plan/delta'
  if (!supported) return detail
  if (method === 'thread/started' && metadata.id !== threadId) return detail
  if (
    (method === 'turn/started' || method === 'turn/completed') &&
    !text(record(params.turn).id)
  ) {
    return detail
  }
  if (
    (method === 'item/started' || method === 'item/completed') &&
    (!text(record(params.item).id) || !text(record(params.item).type))
  ) {
    return detail
  }
  if (method.endsWith('Delta') || method.endsWith('/delta')) {
    if (!text(params.itemId) || typeof params.delta !== 'string') return detail
  }
  if (method === 'turn/plan/updated' && !Array.isArray(params.plan)) {
    return detail
  }
  if (method === 'turn/diff/updated' && typeof params.diff !== 'string') {
    return detail
  }
  const itemId = `subagent:${threadId}`
  let parentIndex = detail.thread.turns.findIndex((turn) =>
    turn.items.some((item) => item.id === itemId && item.type === 'subagent')
  )
  if (parentIndex < 0) {
    parentIndex = detail.thread.turns.findIndex(
      (turn) => turn.id === detail.workspace.activeTurnId
    )
  }
  if (parentIndex < 0) parentIndex = detail.thread.turns.length - 1
  if (parentIndex < 0) return detail
  const parent = detail.thread.turns[parentIndex]
  const itemIndex = parent.items.findIndex(
    (item) => item.id === itemId && item.type === 'subagent'
  )
  const previous = itemIndex < 0 ? undefined : parent.items[itemIndex]
  const savedTurns = Array.isArray(previous?.turns)
    ? (previous.turns as CodexTurn[])
    : []
  if (
    method !== 'thread/started' &&
    !text(params.turnId) &&
    !text(record(params.turn).id) &&
    savedTurns.length === 0
  ) {
    return detail
  }
  const child = applyCodexEvent(
    {
      ...detail,
      workspace: {
        ...detail.workspace,
        threadId,
        activeTurnId:
          [...savedTurns].reverse().find((turn) => turn.status === 'inProgress')
            ?.id ?? null,
      },
      thread: { id: threadId, turns: savedTurns },
      nextCursor: event.seq - 1,
      events: [],
    },
    { ...event, method, params }
  )
  const turns = child.thread?.turns ?? savedTurns
  const lastTurn = turns.at(-1)
  const item: CodexItem = {
    ...previous,
    id: itemId,
    type: 'subagent',
    threadId,
    status: lastTurn?.status ?? previous?.status ?? 'inProgress',
    turns,
    items: turns.flatMap((turn) => turn.items),
    ...(typeof metadata.preview === 'string' ? { text: metadata.preview } : {}),
    ...(typeof metadata.name === 'string' ? { agentName: metadata.name } : {}),
  }
  const items = [...parent.items]
  if (itemIndex < 0) items.push(item)
  else items[itemIndex] = item
  const parents = [...detail.thread.turns]
  parents[parentIndex] = { ...parent, items }
  return { ...detail, thread: { ...detail.thread, turns: parents } }
}

// Older runners only retained wrapped child notifications in their event log.
// Hydrate missing child projections without replaying already-materialized text.
export function restoreCodexDetail(detail: CodexDetail): CodexDetail {
  const existing = new Set(
    detail.thread?.turns.flatMap((turn) =>
      turn.items
        .filter((item) => item.type === 'subagent')
        .map((item) => item.threadId)
    )
  )
  let restored = detail
  let parentTurnId: string | undefined
  const events = [...detail.events].sort((a, b) => a.seq - b.seq)
  const replacementIndex = events
    .map((event) => event.method)
    .lastIndexOf('workbench/thread/replaced')
  for (const event of events.slice(replacementIndex + 1)) {
    if (event.method === 'turn/started') {
      parentTurnId = text(record(event.params.turn).id) || parentTurnId
    }
    if (event.method !== 'workbench/subagent/event') continue
    const params = record(record(event.params.event).params)
    const threadId = text(params.threadId) || text(record(params.thread).id)
    if (!existing.has(threadId)) {
      const next = applySubagentEvent(
        {
          ...restored,
          workspace: { ...restored.workspace, activeTurnId: parentTurnId },
        },
        event
      )
      restored = { ...next, workspace: restored.workspace }
    }
  }
  return restored
}

export function applyCodexEvents(
  detail: CodexDetail,
  page: CodexEvents
): CodexDetail {
  if (
    page.workspace.id !== detail.workspace.id ||
    page.nextCursor < detail.nextCursor ||
    (page.conversationId &&
      detail.conversationId &&
      page.conversationId !== detail.conversationId)
  ) {
    return detail
  }
  let merged = [...page.events]
    .sort((a, b) => a.seq - b.seq)
    .reduce(applyCodexEvent, detail)
  // Runtime errors can be retryable. Only the authoritative workspace status
  // proves that execution has stopped and all remaining child activity ended.
  if (
    page.workspace.status === 'error' ||
    page.workspace.status === 'interrupted'
  ) {
    const status = page.workspace.status === 'error' ? 'failed' : 'interrupted'
    merged = {
      ...merged,
      thread: merged.thread
        ? {
            ...merged.thread,
            turns: merged.thread.turns.map((turn) => ({
              ...turn,
              status: turn.status === 'inProgress' ? status : turn.status,
              items: turn.items.map((item) => stopCodexItem(item, status)),
            })),
          }
        : null,
    }
  }
  return {
    ...merged,
    conversationId: page.conversationId ?? merged.conversationId,
    conversations: page.conversations ?? merged.conversations,
    queuedTurns: page.queuedTurns ?? merged.queuedTurns,
    nextCursor: Math.max(merged.nextCursor, page.nextCursor),
    workspace: page.workspace,
    pendingApprovals: page.pendingApprovals,
    persistenceError: page.persistenceError ?? merged.persistenceError,
  }
}
export function codexItemText(item: CodexItem): string {
  if (item.type === 'userMessage') {
    return (item.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
  }
  if (item.type === 'reasoning') return (item.summary ?? []).join('\n\n')
  return item.text ?? ''
}
export function isCodexBusy(status: string): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_approval'
  )
}
