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
  conversationExportData,
  exportCodexConversation,
} from '../lib/conversation-export'
import type { CodexDetail } from '../types'
import { detail } from './fixtures'

function conversation(): CodexDetail {
  return {
    ...detail(),
    conversationId: 'conversation-2',
    workspace: {
      ...detail().workspace,
      conversationName: '修复登录',
      ownerId: 23,
      group: 'team',
    },
    thread: {
      id: 'thread-2',
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          items: [
            {
              id: 'user-1',
              type: 'userMessage',
              content: [{ type: 'text', text: '修复登录\n保留测试。' }],
            },
            {
              id: 'reasoning-1',
              type: 'reasoning',
              summary: ['Check session expiry.'],
            },
            {
              id: 'command-1',
              type: 'commandExecution',
              command: 'bun test',
              cwd: '/workspace/project',
              aggregatedOutput: '3 tests passed\n',
              exitCode: 0,
              status: 'completed',
            },
            {
              id: 'file-1',
              type: 'fileChange',
              changes: [
                {
                  path: 'src/auth.ts',
                  kind: { type: 'update' },
                  diff: '-old\n+fixed',
                },
              ],
            },
            {
              id: 'assistant-1',
              type: 'agentMessage',
              text: '已修复，测试通过。',
              phase: 'final_answer',
              internalToken: 'do-not-export',
            },
          ],
          plan: [{ step: 'Fix the expiry check', status: 'completed' }],
          planExplanation: 'Preserve the public API.',
        },
        {
          id: 'turn-2',
          status: 'inProgress',
          items: [
            {
              id: 'user-2',
              type: 'userMessage',
              content: [{ type: 'text', text: 'Now document it.' }],
            },
            {
              id: 'assistant-2',
              type: 'agentMessage',
              text: 'Draft in progress',
            },
          ],
        },
      ],
    },
    events: [
      {
        seq: 12,
        method: 'item/agentMessage/delta',
        params: { delta: 'DO NOT DUPLICATE' },
        time: 1,
      },
    ],
    queuedTurns: [
      {
        requestId: 'pending',
        prompt: 'NOT SENT YET',
        model: 'model',
        group: 'team',
        effort: 'high',
        mode: 'code',
        conversationId: 'conversation-2',
        createdAt: 1,
        status: 'queued',
      },
    ],
  }
}

describe('ChatGPT-style conversation exports', () => {
  test('JSON exports the full loaded conversation with readable tools and a versioned visible-history schema', () => {
    const input = conversation()
    const original = structuredClone(input)
    const file = exportCodexConversation(input, 'json')
    const exported = JSON.parse(file.content)
    expect(file.filename).toBe('修复登录.json')
    expect(file.mimeType).toBe('application/json;charset=utf-8')
    expect(exported).toMatchObject({
      schema: 'new-api.codex.conversation',
      schemaVersion: 1,
      scope: 'visible-conversation',
      conversation: { id: 'conversation-2', threadId: 'thread-2' },
      branch: null,
    })
    expect(exported.turns).toHaveLength(2)
    expect(exported.turns[0].messages[2]).toMatchObject({
      role: 'tool',
      command: 'bun test',
      output: '3 tests passed\n',
      exitCode: 0,
    })
    expect(exported.turns[0].messages[3].changes[0]).toEqual({
      path: 'src/auth.ts',
      kind: 'update',
      diff: '-old\n+fixed',
    })
    expect(exported.turns[1].messages[1].text).toBe('Draft in progress')
    expect(file.content).not.toMatch(
      /DO NOT DUPLICATE|NOT SENT YET|do-not-export|ownerId|pendingApprovals/
    )
    expect(input).toEqual(original)
  })

  test('deleted assistant messages exclude their reasoning, tools, plans, errors and patches from both formats', () => {
    const input = conversation()
    if (!input.thread) throw new Error('Missing fixture thread')
    input.thread.turns[0].deletedRoles = ['assistant']
    input.thread.turns[0].error = { message: 'HIDDEN ERROR' }
    input.thread.turns[0].diff = 'HIDDEN PATCH'
    for (const format of ['json', 'markdown'] as const) {
      const file = exportCodexConversation(input, format)
      expect(file.content).toContain('修复登录')
      expect(file.content).not.toMatch(
        /Check session expiry|bun test|src\/auth.ts|已修复|expiry check|public API|HIDDEN/
      )
      expect(file.content).toContain('Draft in progress')
    }
  })

  test('deleted user messages and attachments stay excluded while the assistant reply is exported', () => {
    const input = conversation()
    if (!input.thread) throw new Error('Missing fixture thread')
    input.thread.turns[0].deletedRoles = ['user']
    input.thread.turns[0].items[0].content?.push({
      type: 'localImage',
      path: 'private-attachment.png',
    })
    const file = exportCodexConversation(input, 'json')
    expect(file.content).not.toMatch(/保留测试|private-attachment/)
    expect(file.content).toContain('已修复，测试通过。')
  })

  test('Markdown retains message formatting and full command output without allowing inner fences to close tool blocks', () => {
    const input = conversation()
    if (!input.thread) throw new Error('Missing fixture thread')
    input.thread.turns[0].items[2].aggregatedOutput =
      '````\n# literal output\n````'
    const file = exportCodexConversation(input, 'markdown', {
      translate: (key) => (key === 'User' ? '用户' : key),
    })
    expect(file.content).toContain('### 用户\n\nuserMessage')
    expect(file.content).toContain('修复登录\n保留测试。')
    expect(file.content).toContain(
      '`````text\n````\n# literal output\n````\n`````'
    )
    expect(file.content).toContain('```diff\n-old\n+fixed\n```')
    expect(file.content).toContain('cwd:\n\n```text\n/workspace/project\n```')
    expect(file.content).toContain('- [x] Fix the expiry check (completed)')
  })

  test('the selected conversation exports its real branch metadata without an explicit option', () => {
    const branch = {
      rootConversationId: 'conversation-1',
      revisionId: 'revision-2',
      parentRevisionId: 'revision-1',
      replayTurnId: 'turn-1',
      turnIndex: 0,
      version: 2,
    }
    const input = conversation()
    input.workspace.conversationId = 'conversation-1'
    input.conversations = [
      {
        id: 'conversation-1',
        name: 'Original',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        turnCount: 1,
        branch: {
          rootConversationId: 'conversation-1',
          revisionId: 'revision-1',
          version: 1,
        },
      },
      {
        id: 'conversation-2',
        name: 'Alternative',
        status: 'idle',
        createdAt: 2,
        updatedAt: 2,
        turnCount: 2,
        branch,
      },
    ]
    const exported = conversationExportData(input)
    expect(exported.branch).toEqual(branch)
    expect(exported.branch).not.toBe(branch)
    expect(exported.conversation.name).toBe('Alternative')
    const markdown = exportCodexConversation(input, 'markdown').content
    expect(markdown).toContain('"replayTurnId": "turn-1"')
    expect(markdown).toContain('"turnIndex": 0')
    expect(markdown).not.toMatch(/parentConversationId|parentTurnId/)
    expect(exported.scope).toBe('visible-conversation')
  })

  test('the workspace conversation ID locates branch metadata when the detail omits its conversation ID', () => {
    const input = detail()
    const branch = {
      rootConversationId: 'conversation-root',
      revisionId: 'revision-root',
      version: 1,
    }
    input.workspace.conversationId = 'conversation-current'
    input.conversations = [
      {
        id: 'conversation-current',
        name: 'Current',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        turnCount: 1,
        branch,
      },
    ]
    expect(conversationExportData(input).branch).toEqual(branch)
    expect(
      JSON.parse(exportCodexConversation(input, 'json').content).conversation.id
    ).toBe('conversation-current')
  })

  test('an explicit branch option overrides the selected metadata and an unrelated branch is never inferred', () => {
    const input = conversation()
    input.conversations = [
      {
        id: 'unrelated',
        name: 'Other conversation',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        turnCount: 1,
        branch: {
          rootConversationId: 'unrelated',
          revisionId: 'unrelated-revision',
          version: 1,
        },
      },
    ]
    expect(conversationExportData(input).branch).toBeNull()
    const override = {
      rootConversationId: 'explicit-root',
      revisionId: 'explicit-revision',
      version: 3,
    }
    expect(conversationExportData(input, { branch: override }).branch).toEqual(
      override
    )
    input.conversations[0].id = input.conversationId ?? ''
    expect(conversationExportData(input, { branch: override }).branch).toEqual(
      override
    )
  })

  test('empty conversations export valid data and derive a safe filename without inventing messages', () => {
    const input = detail()
    input.thread = null
    input.workspace.name = '../新项目/<unsafe>\n'
    const exported = exportCodexConversation(input, 'json')
    expect(exported.filename).not.toMatch(/[<>/\\\r\n]/)
    expect(JSON.parse(exported.content).turns).toEqual([])
    expect(conversationExportData(input).conversation.threadId).toBeNull()
    input.workspace.name = '   ... '
    expect(exportCodexConversation(input, 'markdown').filename).toBe(
      'conversation.md'
    )
  })

  test('nested subagent activity and visible attachments remain readable without copying native bookkeeping', () => {
    const input = conversation()
    if (!input.thread) throw new Error('Missing fixture thread')
    input.thread.turns[0].items[0].content?.push({
      type: 'localImage',
      path: 'screenshot.png',
    })
    input.thread.turns[0].items.push({
      id: 'agent',
      type: 'subagent',
      agentName: 'Reviewer',
      text: 'Inspecting auth',
      items: [
        { id: 'child', type: 'agentMessage', text: 'No regressions found.' },
        null,
      ],
    })
    const data = conversationExportData(input)
    expect(data.turns[0].messages[0].attachments).toEqual([
      { type: 'localImage', path: 'screenshot.png' },
    ])
    expect(data.turns[0].messages.at(-1)?.children).toEqual([
      {
        id: 'child',
        role: 'assistant',
        type: 'agentMessage',
        text: 'No regressions found.',
      },
    ])
    const markdown = exportCodexConversation(input, 'markdown').content
    expect(markdown).toContain('### Reviewer')
    expect(markdown).toContain('No regressions found.')
    expect(markdown).toContain('screenshot.png')
  })

  test('unsaved history exports preserve the save failure marker and real task errors', () => {
    const input = conversation()
    input.persistenceError = true
    if (!input.thread) throw new Error('Missing fixture thread')
    input.thread.turns[1].error = { message: 'Provider unavailable' }
    expect(conversationExportData(input).persistenceError).toBe(true)
    expect(exportCodexConversation(input, 'markdown').content).toContain(
      'Project not saved'
    )
    expect(exportCodexConversation(input, 'markdown').content).toContain(
      'Provider unavailable'
    )
  })

  test('web search and external tool results preserve the visible action details', () => {
    const input = detail()
    if (!input.thread) throw new Error('Missing fixture thread')
    input.thread.turns[0].items = [
      {
        id: 'search',
        type: 'webSearch',
        action: { type: 'search', query: 'session refresh documentation' },
        result: {
          title: 'Session documentation',
          url: 'https://example.com/docs',
        },
        bookkeeping: 'not a display field',
      },
    ]
    const data = conversationExportData(input)
    expect(data.turns[0].messages[0].details).toEqual({
      action: { type: 'search', query: 'session refresh documentation' },
      result: {
        title: 'Session documentation',
        url: 'https://example.com/docs',
      },
    })
    const file = exportCodexConversation(input, 'markdown')
    expect(file.content).toContain('session refresh documentation')
    expect(file.content).toContain('https://example.com/docs')
    expect(file.content).not.toContain('bookkeeping')
  })
})
