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

import {
  applyCodexEvent,
  applyCodexEvents,
  restoreCodexDetail,
} from '../lib/events'
import type { CodexEvent } from '../types'
import { detail, workspace } from './fixtures'

const event = (
  seq: number,
  method: string,
  params: Record<string, unknown>
): CodexEvent => ({
  seq,
  method,
  params,
  time: seq,
})

describe('live conversation event integrity', () => {
  test('new event pages retain native and unknown notifications exactly once', () => {
    const first = event(1, 'item/agentMessage/delta', {
      turnId: 'turn-1',
      itemId: 'answer',
      delta: 'Hello',
    })
    const unknown = event(2, 'thread/tokenUsage/updated', {
      threadId: 'thread-1',
      tokenUsage: { total: 20 },
    })
    const page = {
      events: [first, unknown],
      nextCursor: 2,
      workspace,
      pendingApprovals: [],
    }
    const result = applyCodexEvents(applyCodexEvents(detail(), page), page)
    expect(result.events).toEqual([first, unknown])
    expect(result.thread?.turns[0].items[0].text).toBe('Hello')
  })

  test('an older event response cannot roll back task status or resurrect approvals', () => {
    const latest = {
      ...detail(),
      nextCursor: 5,
      workspace: { ...workspace, status: 'idle' as const },
    }
    const result = applyCodexEvents(latest, {
      events: [],
      nextCursor: 4,
      workspace: { ...workspace, status: 'waiting_approval' },
      pendingApprovals: [
        {
          id: 'resolved',
          method: 'item/commandExecution/requestApproval',
          params: {},
        },
      ],
    })
    expect(result.workspace.status).toBe('idle')
    expect(result.pendingApprovals).toEqual([])
  })

  test('a page for another project is ignored even if its conversation ID is absent', () => {
    const initial = detail()
    const result = applyCodexEvents(initial, {
      events: [
        event(1, 'item/agentMessage/delta', {
          turnId: 'turn-1',
          itemId: 'answer',
          delta: 'Other project',
        }),
      ],
      nextCursor: 1,
      workspace: { ...workspace, id: 'other-project' },
      pendingApprovals: [],
    })
    expect(result).toBe(initial)
  })

  test('a runner interruption stops the visible active turn and preserves its partial answer', () => {
    const initial = detail()
    initial.workspace = {
      ...workspace,
      activeTurnId: 'turn-1',
      status: 'running',
    }
    if (initial.thread) {
      initial.thread.turns[0].items.push({
        id: 'answer',
        type: 'agentMessage',
        text: 'Partial answer',
      })
    }
    const result = applyCodexEvent(
      initial,
      event(1, 'workbench/interrupted', { reason: 'user_requested' })
    )
    expect(result.thread?.turns[0]).toMatchObject({
      status: 'interrupted',
      items: [{ text: 'Partial answer' }],
    })
  })

  test('a wrapped child thread streams and completes without replacing the root conversation', () => {
    const initial = detail()
    initial.workspace = {
      ...workspace,
      activeTurnId: 'turn-1',
      status: 'running',
    }
    const notifications = [
      {
        method: 'thread/started',
        params: {
          thread: {
            id: 'child-thread',
            name: 'Reviewer',
            preview: 'Review the implementation',
            turns: [],
          },
        },
      },
      {
        method: 'turn/started',
        params: {
          threadId: 'child-thread',
          turn: { id: 'child-turn', status: 'inProgress', items: [] },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'child-thread',
          turnId: 'child-turn',
          itemId: 'answer',
          delta: 'Found an issue.',
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'child-thread',
          turn: { id: 'child-turn', status: 'completed', items: [] },
        },
      },
    ]
    const result = notifications.reduce(
      (current, notification, index) =>
        applyCodexEvent(
          current,
          event(index + 1, 'workbench/subagent/event', { event: notification })
        ),
      initial
    )
    expect(result.thread?.id).toBe('thread-1')
    expect(result.workspace.activeTurnId).toBe('turn-1')
    expect(result.workspace.status).toBe('running')
    expect(result.thread?.turns).toHaveLength(1)
    expect(result.thread?.turns[0].items).toEqual([
      expect.objectContaining({
        id: 'subagent:child-thread',
        type: 'subagent',
        threadId: 'child-thread',
        agentName: 'Reviewer',
        text: 'Review the implementation',
        status: 'completed',
        items: [
          expect.objectContaining({
            id: 'answer',
            type: 'agentMessage',
            text: 'Found an issue.',
          }),
        ],
        turns: [
          expect.objectContaining({ id: 'child-turn', status: 'completed' }),
        ],
      }),
    ])
    expect(result.events).toHaveLength(4)
  })

  test('a late child event stays attached to its original parent turn after the root advances', () => {
    const initial = detail()
    initial.workspace.activeTurnId = 'turn-1'
    const child = applyCodexEvent(
      initial,
      event(1, 'workbench/subagent/event', {
        event: {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'child-thread',
            turnId: 'child-turn',
            itemId: 'answer',
            delta: 'Part',
          },
        },
      })
    )
    const nextTurn = applyCodexEvent(
      child,
      event(2, 'turn/started', {
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      })
    )
    nextTurn.workspace = { ...nextTurn.workspace, activeTurnId: 'turn-2' }
    const result = applyCodexEvent(
      nextTurn,
      event(3, 'workbench/subagent/event', {
        event: {
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'child-thread',
            turnId: 'child-turn',
            itemId: 'answer',
            delta: ' complete',
          },
        },
      })
    )
    expect(result.thread?.turns[0].items[0]).toMatchObject({
      items: [{ text: 'Part complete' }],
    })
    expect(result.thread?.turns[1].items).toEqual([])
  })
})

test('root thread replacement does not inherit turns from the old native thread', () => {
  const result = applyCodexEvent(
    detail(),
    event(1, 'thread/started', { thread: { id: 'new-root', turns: [] } })
  )
  expect(result.thread).toEqual({ id: 'new-root', turns: [] })
})

test('a new native root does not restore child output from the replaced thread event history', () => {
  const initial = applyCodexEvent(
    detail(),
    event(1, 'workbench/subagent/event', {
      event: {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'old-child',
          turnId: 'child-turn',
          itemId: 'answer',
          delta: 'Output from the old root',
        },
      },
    })
  )
  const replacement = applyCodexEvent(
    initial,
    event(2, 'thread/started', { thread: { id: 'new-root', turns: [] } })
  )
  const result = applyCodexEvent(
    replacement,
    event(3, 'turn/started', {
      threadId: 'new-root',
      turn: { id: 'new-turn', status: 'inProgress', items: [] },
    })
  )
  expect(result.thread).toEqual({
    id: 'new-root',
    turns: [{ id: 'new-turn', status: 'inProgress', items: [] }],
  })
})

test('root interruption also stops nested subagent progress without changing completed work', () => {
  const initial = detail()
  initial.workspace.activeTurnId = 'turn-1'
  if (initial.thread) {
    initial.thread.turns[0].items.push({
      id: 'subagent:child',
      type: 'subagent',
      threadId: 'child',
      status: 'inProgress',
      turns: [
        {
          id: 'child-turn',
          status: 'inProgress',
          items: [
            { id: 'done', type: 'commandExecution', status: 'completed' },
            { id: 'working', type: 'commandExecution', status: 'inProgress' },
          ],
        },
      ],
    })
  }
  const result = applyCodexEvent(
    initial,
    event(1, 'workbench/interrupted', { reason: 'user_requested' })
  )
  expect(result.thread?.turns[0].items[0]).toMatchObject({
    status: 'interrupted',
    turns: [
      {
        status: 'interrupted',
        items: [{ status: 'completed' }, { status: 'interrupted' }],
      },
    ],
  })
})

test('restoring legacy subagent events materializes missing child output without replaying persisted deltas', () => {
  const initial = detail()
  initial.events = [
    event(1, 'workbench/subagent/event', {
      event: {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'child',
          turnId: 'child-turn',
          itemId: 'answer',
          delta: 'Saved output',
        },
      },
    }),
  ]
  initial.nextCursor = 1
  const restored = restoreCodexDetail(initial)
  expect(restored.thread?.turns[0].items[0]).toMatchObject({
    type: 'subagent',
    items: [{ text: 'Saved output' }],
  })
  expect(restoreCodexDetail(restored).thread).toEqual(restored.thread)
  expect(restored.nextCursor).toBe(1)
})

test('a malformed child notification remains in event history without adding an empty agent card', () => {
  const result = applyCodexEvent(
    detail(),
    event(1, 'workbench/subagent/event', {
      event: {
        method: 'item/agentMessage/delta',
        params: { threadId: 'child', delta: 'No identity' },
      },
    })
  )
  expect(result.thread?.turns[0].items).toEqual([])
  expect(result.events).toHaveLength(1)
})

test('retryable workbench errors do not stop a task that the server reports as running', () => {
  const initial = detail()
  initial.workspace.status = 'running'
  initial.workspace.activeTurnId = 'turn-1'
  const result = applyCodexEvents(initial, {
    events: [
      event(1, 'workbench/error', {
        code: 'runtime_timeout',
        message: 'Still starting',
      }),
    ],
    nextCursor: 1,
    workspace: { ...initial.workspace },
    pendingApprovals: [],
  })
  expect(result.thread?.turns[0].status).toBe('inProgress')
  expect(result.workspace.status).toBe('running')
})

test('replacing a thread starts a new event history so removed subagents cannot reappear', () => {
  const initial = detail()
  initial.nextCursor = 1
  initial.events = [
    event(1, 'workbench/subagent/event', {
      event: {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'removed-child',
          turnId: 'child-turn',
          itemId: 'answer',
          delta: 'Old branch output',
        },
      },
    }),
  ]
  const replacement = event(2, 'workbench/thread/replaced', {
    thread: {
      id: 'forked-thread',
      turns: [{ id: 'kept-turn', status: 'completed', items: [] }],
    },
  })
  const result = restoreCodexDetail(applyCodexEvent(initial, replacement))
  expect(result.events).toEqual([replacement])
  expect(result.thread?.turns[0].items).toEqual([])
})

test('a child that starts after a new root turn in the same page attaches to that new turn', () => {
  const initial = detail()
  initial.workspace.activeTurnId = 'turn-1'
  const result = applyCodexEvents(initial, {
    events: [
      event(1, 'turn/started', {
        turn: { id: 'turn-2', status: 'inProgress', items: [] },
      }),
      event(2, 'workbench/subagent/event', {
        event: {
          method: 'thread/started',
          params: { thread: { id: 'new-child', turns: [] } },
        },
      }),
    ],
    nextCursor: 2,
    workspace: { ...workspace, status: 'running', activeTurnId: 'turn-2' },
    pendingApprovals: [],
  })
  expect(result.thread?.turns[0].items).toEqual([])
  expect(result.thread?.turns[1].items[0]).toMatchObject({
    type: 'subagent',
    threadId: 'new-child',
  })
})

test('a child notification received before the root turn retains its real name once the root arrives', () => {
  const initial = { ...detail(), thread: { id: 'thread-1', turns: [] } }
  const child = applyCodexEvent(
    initial,
    event(1, 'workbench/subagent/event', {
      event: {
        method: 'thread/started',
        params: { thread: { id: 'early-child', name: 'Reviewer', turns: [] } },
      },
    })
  )
  expect(child.thread?.turns).toEqual([])
  const result = applyCodexEvent(
    child,
    event(2, 'turn/started', {
      turn: { id: 'root-turn', status: 'inProgress', items: [] },
    })
  )
  expect(result.thread?.turns[0].items[0]).toMatchObject({
    type: 'subagent',
    threadId: 'early-child',
    agentName: 'Reviewer',
  })
})
