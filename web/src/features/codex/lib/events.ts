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
  const next: CodexDetail = { ...detail, nextCursor: event.seq }
  const params = event.params
  if (event.method === 'thread/started') {
    const thread = record(params.thread)
    if (typeof thread.id === 'string') {
      next.thread = { id: thread.id, turns: detail.thread?.turns ?? [] }
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
    return { ...next, thread: { ...thread, turns } }
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
      typeof params.summaryIndex === 'number' ? params.summaryIndex : 0
    if (summaryIndex >= 0 && summaryIndex < 100) {
      summary[summaryIndex] = (summary[summaryIndex] ?? '') + text(params.delta)
    }
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

export function applyCodexEvents(
  detail: CodexDetail,
  page: CodexEvents
): CodexDetail {
  const merged = page.events.reduce(applyCodexEvent, detail)
  return {
    ...merged,
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
