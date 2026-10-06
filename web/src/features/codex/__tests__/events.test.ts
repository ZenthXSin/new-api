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
import { describe, expect, test } from 'vitest'

import { applyCodexEvent, applyCodexEvents } from '../lib/events'
import { detail, workspace } from './fixtures'

describe('Codex event restoration', () => {
  test('replayed event sequences do not duplicate streamed words', () => {
    const event = {
      seq: 1,
      time: 1,
      method: 'item/agentMessage/delta',
      params: { turnId: 'turn-1', itemId: 'answer', delta: 'Hello hello' },
    }
    const first = applyCodexEvent(detail(), event)
    expect(applyCodexEvent(first, event).thread?.turns[0].items[0].text).toBe(
      'Hello hello'
    )
  })
  test('item completion replaces streamed text with the authoritative complete answer', () => {
    const first = applyCodexEvent(detail(), {
      seq: 1,
      time: 1,
      method: 'item/agentMessage/delta',
      params: { turnId: 'turn-1', itemId: 'answer', delta: 'Partial' },
    })
    const result = applyCodexEvent(first, {
      seq: 2,
      time: 2,
      method: 'item/completed',
      params: {
        turnId: 'turn-1',
        item: { id: 'answer', type: 'agentMessage', text: 'Partial complete' },
      },
    })
    expect(result.thread?.turns[0].items).toHaveLength(1)
    expect(result.thread?.turns[0].items[0].text).toBe('Partial complete')
  })
  test('a terminal turn without items preserves command output and partial response', () => {
    const initial = detail()
    if (initial.thread) {
      initial.thread.turns[0].items = [
        {
          id: 'cmd',
          type: 'commandExecution',
          aggregatedOutput: 'tests passed',
        },
      ]
    }
    const result = applyCodexEvent(initial, {
      seq: 1,
      time: 1,
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'interrupted', items: [] } },
    })
    expect(result.thread?.turns[0].items[0].aggregatedOutput).toBe(
      'tests passed'
    )
    expect(result.thread?.turns[0].status).toBe('interrupted')
  })
  test('stream output arriving before item metadata is retained when metadata arrives', () => {
    const first = applyCodexEvent(detail(), {
      seq: 1,
      time: 1,
      method: 'item/commandExecution/outputDelta',
      params: { turnId: 'turn-1', itemId: 'cmd', delta: 'ok\n' },
    })
    const result = applyCodexEvent(first, {
      seq: 2,
      time: 2,
      method: 'item/started',
      params: {
        turnId: 'turn-1',
        item: { id: 'cmd', type: 'commandExecution', command: 'npm test' },
      },
    })
    expect(result.thread?.turns[0].items[0]).toMatchObject({
      command: 'npm test',
      aggregatedOutput: 'ok\n',
    })
  })
  test('polling an empty event page still updates approvals and project state', () => {
    const result = applyCodexEvents(detail(), {
      events: [],
      nextCursor: 4,
      workspace: { ...workspace, status: 'waiting_approval' },
      pendingApprovals: [
        {
          id: 'approval',
          method: 'item/commandExecution/requestApproval',
          params: {},
        },
      ],
    })
    expect(result.nextCursor).toBe(4)
    expect(result.workspace.status).toBe('waiting_approval')
    expect(result.pendingApprovals).toHaveLength(1)
  })
  test('starting a new turn preserves the earlier conversation', () => {
    const result = applyCodexEvent(detail(), {
      seq: 1,
      time: 1,
      method: 'turn/started',
      params: { turn: { id: 'turn-2', status: 'inProgress', items: [] } },
    })
    expect(result.thread?.turns.map((turn) => turn.id)).toEqual([
      'turn-1',
      'turn-2',
    ])
  })
  test('summary turn completion preserves earlier user messages and tool output', () => {
    const initial = detail()
    if (initial.thread) {
      initial.thread.turns[0].items = [
        {
          id: 'user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Fix it' }],
        },
        {
          id: 'cmd',
          type: 'commandExecution',
          command: 'npm test',
          aggregatedOutput: 'passed',
        },
        { id: 'answer', type: 'agentMessage', text: 'Part' },
      ]
    }
    const result = applyCodexEvent(initial, {
      seq: 1,
      time: 1,
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          itemsView: 'summary',
          items: [{ id: 'answer', type: 'agentMessage', text: 'Done' }],
        },
      },
    })
    expect(result.thread?.turns[0].items.map((item) => item.id)).toEqual([
      'user',
      'cmd',
      'answer',
    ])
    expect(result.thread?.turns[0].items[1].aggregatedOutput).toBe('passed')
    expect(result.thread?.turns[0].items[2].text).toBe('Done')
  })
  test('event polling propagates cloud save failures and their eventual recovery', () => {
    const failed = applyCodexEvents(detail(), {
      events: [],
      nextCursor: 1,
      workspace,
      pendingApprovals: [],
      persistenceError: true,
    })
    expect(failed.persistenceError).toBe(true)
    const recovered = applyCodexEvents(failed, {
      events: [],
      nextCursor: 2,
      workspace,
      pendingApprovals: [],
      persistenceError: false,
    })
    expect(recovered.persistenceError).toBe(false)
  })
  test('live plan progress and diff survive terminal summary events', () => {
    const planned = applyCodexEvent(detail(), {
      seq: 1,
      time: 1,
      method: 'turn/plan/updated',
      params: {
        turnId: 'turn-1',
        explanation: 'Check before editing',
        plan: [
          { step: 'Read the project', status: 'completed' },
          { step: 'Implement the change', status: 'inProgress' },
          { step: 'Invalid entry', status: 'unexpected' },
        ],
      },
    })
    const changed = applyCodexEvent(planned, {
      seq: 2,
      time: 2,
      method: 'turn/diff/updated',
      params: { turnId: 'turn-1', diff: '+fixed' },
    })
    const done = applyCodexEvent(changed, {
      seq: 3,
      time: 3,
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    })
    expect(done.thread?.turns[0]).toMatchObject({
      plan: [
        { step: 'Read the project', status: 'completed' },
        { step: 'Implement the change', status: 'inProgress' },
      ],
      planExplanation: 'Check before editing',
      diff: '+fixed',
      status: 'completed',
    })
  })
})
