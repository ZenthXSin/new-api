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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodexConversation } from '../components/conversation'
import type { CodexProjectConversation, CodexThread } from '../types'

const thread: CodexThread = {
  id: 'chat-a',
  turns: [
    {
      id: 'turn-a',
      status: 'completed',
      items: [
        {
          id: 'user-a',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Explain this change' }],
        },
        {
          id: 'answer-a',
          type: 'agentMessage',
          phase: 'final_answer',
          text: 'The page now keeps your place.',
          status: 'completed',
        },
      ],
    },
  ],
}
const defaults = { running: false, approvals: [], onApprove: vi.fn() }

describe('Chat conversation reading', () => {
  test('an empty conversation welcomes the user while a running empty turn only announces progress', () => {
    const { rerender } = render(
      <CodexConversation {...defaults} thread={null} />
    )
    expect(
      screen.getByRole('heading', { name: 'What can I help with?' })
    ).toBeVisible()
    rerender(
      <CodexConversation
        {...defaults}
        thread={{
          id: 'new',
          turns: [{ id: 'new-turn', status: 'inProgress', items: [] }],
        }}
        running
      />
    )
    expect(
      screen.queryByRole('heading', { name: 'What can I help with?' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Codex is working...')
    expect(
      screen.getByRole('region', { name: 'Task conversation' })
    ).toHaveAttribute('aria-busy', 'true')
  })

  test('sending locally returns a reader in history to the newest prompt', () => {
    const { rerender } = render(
      <CodexConversation {...defaults} thread={thread} />
    )
    const viewport = screen.getByLabelText('Task conversation')
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 400 },
    })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    expect(
      screen.getByRole('button', { name: 'Scroll to latest message' })
    ).toBeVisible()
    const next = structuredClone(thread)
    next.turns.push({
      id: 'turn-b',
      status: 'inProgress',
      items: [
        {
          id: 'user-b',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Make it responsive too' }],
        },
      ],
    })
    rerender(
      <CodexConversation
        {...defaults}
        thread={next}
        running
        scrollToLatestKey='local-turn-b'
      />
    )
    expect(viewport.scrollTop).toBe(1500)
    expect(
      screen.queryByRole('button', { name: 'Scroll to latest message' })
    ).not.toBeInTheDocument()
  })

  test('a queued or remote turn preserves the position of a reader in history', () => {
    const { rerender } = render(
      <CodexConversation {...defaults} thread={thread} />
    )
    const viewport = screen.getByLabelText('Task conversation')
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 400 },
    })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    const next = structuredClone(thread)
    next.turns.push({ id: 'remote-turn', status: 'inProgress', items: [] })
    rerender(<CodexConversation {...defaults} thread={next} running />)
    expect(viewport.scrollTop).toBe(100)
    expect(
      screen.getByRole('button', { name: 'Scroll to latest message' })
    ).toBeVisible()
  })

  test('resizing the viewport follows new content only while the reader stays at the bottom', () => {
    let resized: ResizeObserverCallback | undefined
    const observed: Element[] = []
    const BrowserResizeObserver = globalThis.ResizeObserver
    class ConversationResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resized = callback
      }
      observe(element: Element) {
        observed.push(element)
      }
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ConversationResizeObserver,
    })
    try {
      render(<CodexConversation {...defaults} thread={thread} />)
      const viewport = screen.getByLabelText('Task conversation')
      Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1500 },
        clientHeight: { configurable: true, value: 400 },
      })
      expect(observed).toContain(viewport)
      act(() => resized?.([], {} as ResizeObserver))
      expect(viewport.scrollTop).toBe(1500)
      viewport.scrollTop = 100
      fireEvent.scroll(viewport)
      act(() => resized?.([], {} as ResizeObserver))
      expect(viewport.scrollTop).toBe(100)
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: BrowserResizeObserver,
      })
    }
  })

  test('returning to the latest message keeps keyboard focus in the conversation', async () => {
    const user = userEvent.setup()
    render(<CodexConversation {...defaults} thread={thread} />)
    const viewport = screen.getByLabelText('Task conversation')
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 400 },
    })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    screen.getByRole('button', { name: 'Scroll to latest message' }).focus()
    await user.keyboard('{Enter}')
    expect(viewport).toHaveFocus()
    expect(
      screen.queryByRole('button', { name: 'Scroll to latest message' })
    ).not.toBeInTheDocument()
  })

  test('finishing a streamed reply gives one polite completion announcement', () => {
    const { rerender } = render(
      <CodexConversation {...defaults} thread={thread} running />
    )
    rerender(<CodexConversation {...defaults} thread={thread} />)
    expect(screen.getByRole('status')).toHaveTextContent('Response complete')
    expect(
      screen.getByRole('region', { name: 'Task conversation' })
    ).toHaveAttribute('aria-busy', 'false')
    expect(
      screen.getByRole('region', { name: 'Task conversation' })
    ).toHaveAttribute('tabindex', '0')
  })
})

describe('Chat conversation agent work', () => {
  test('subagent output stays inside execution details and expands into real messages', async () => {
    const user = userEvent.setup()
    const withAgent = structuredClone(thread)
    withAgent.turns[0].items.splice(1, 0, {
      id: 'subagent:worker-a',
      type: 'subagent',
      agentName: 'Review worker',
      threadId: 'worker-a',
      status: 'completed',
      items: [
        {
          id: 'review-output',
          type: 'agentMessage',
          text: 'The navigation supports keyboard focus.',
        },
      ],
    })
    render(<CodexConversation {...defaults} thread={withAgent} />)
    expect(
      screen.queryByText('The navigation supports keyboard focus.')
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Execution steps/ }))
    await user.click(screen.getByRole('button', { name: /Review worker/ }))
    expect(
      screen.getByText('The navigation supports keyboard focus.')
    ).toBeVisible()
    expect(
      screen.getAllByRole('button', { name: 'Copy response' })
    ).toHaveLength(1)
  })
})

describe('Chat message editing and actions', () => {
  test('message action controls remain pointer targets before the row is hovered', () => {
    render(
      <CodexConversation {...defaults} thread={thread} onRetry={vi.fn()} />
    )
    const edit = screen.getByRole('button', { name: 'Edit message' })
    expect(edit).toHaveClass('pointer-events-auto')
    expect(edit).toHaveClass('disabled:pointer-events-none')
  })

  test('Escape cancels an edit and returns keyboard focus to the edit button', async () => {
    const user = userEvent.setup()
    render(
      <CodexConversation {...defaults} thread={thread} onRetry={vi.fn()} />
    )
    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    await user.clear(screen.getByRole('textbox', { name: 'Edit message' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Edit message' }),
      'Discard this draft'
    )
    await user.keyboard('{Escape}')
    expect(
      screen.queryByRole('textbox', { name: 'Edit message' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit message' })).toHaveFocus()
    expect(screen.getByText('Explain this change')).toBeVisible()
  })

  test('switching between branches that share a turn never carries an open edit into the other conversation', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <CodexConversation {...defaults} thread={thread} onRetry={vi.fn()} />
    )
    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    await user.clear(screen.getByRole('textbox', { name: 'Edit message' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Edit message' }),
      'Private draft in branch A'
    )
    rerender(
      <CodexConversation
        {...defaults}
        thread={{ ...thread, id: 'chat-b' }}
        onRetry={vi.fn()}
      />
    )
    expect(
      screen.queryByRole('textbox', { name: 'Edit message' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('Explain this change')).toBeVisible()
  })

  test('IME confirmation never resends while Control Enter resends a completed draft', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn().mockResolvedValue(undefined)
    render(
      <CodexConversation {...defaults} thread={thread} onRetry={onRetry} />
    )
    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit message' })
    fireEvent.keyDown(editor, {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    })
    expect(onRetry).not.toHaveBeenCalled()
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onRetry).toHaveBeenCalledWith('turn-a', 'Explain this change')
  })

  test('a failed resend keeps the draft editable and exposes the server error', async () => {
    const user = userEvent.setup()
    let rejectRequest: ((reason: Error) => void) | undefined
    const onRetry = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequest = reject
        })
    )
    render(
      <CodexConversation {...defaults} thread={thread} onRetry={onRetry} />
    )
    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit message' })
    await user.clear(editor)
    await user.type(editor, 'Keep my revised request')
    await user.click(screen.getByRole('button', { name: 'Save and retry' }))
    expect(editor).toBeDisabled()
    await act(async () => rejectRequest?.(new Error('Connection unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connection unavailable'
    )
    expect(editor).toHaveValue('Keep my revised request')
    expect(editor).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save and retry' })).toBeEnabled()
  })

  test('copying a response places its original Markdown on the clipboard and announces success', async () => {
    const user = userEvent.setup()
    render(<CodexConversation {...defaults} thread={thread} />)
    await user.click(screen.getByRole('button', { name: 'Copy response' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Copied')
    )
    expect(await navigator.clipboard.readText()).toBe(
      'The page now keeps your place.'
    )
  })
})

const branchConversation = (
  revisionId: string,
  version: number,
  parentRevisionId?: string,
  turnIndex?: number
): CodexProjectConversation => ({
  id: `conversation-${revisionId}`,
  name: `Revision ${version}`,
  status: 'idle',
  createdAt: version,
  updatedAt: version,
  turnCount: 3,
  branch: {
    rootConversationId: 'family-a',
    revisionId,
    version,
    parentRevisionId,
    turnIndex,
  },
})
const branches = [
  branchConversation('one', 1),
  branchConversation('two', 2, 'one', 1),
  branchConversation('three', 3, 'two', 1),
  branchConversation('four', 4, 'one', 2),
  branchConversation('five', 5, 'three', 2),
  branchConversation('six', 6, 'one', 0),
  branchConversation('seven', 7, 'six', 1),
  branchConversation('eight', 8, 'two', 2),
]
const branchThread: CodexThread = {
  id: 'branch-thread',
  turns: ['First', 'Second', 'Third'].map((label) => ({
    id: `turn-${label}`,
    status: 'completed',
    items: [
      {
        id: `user-${label}`,
        type: 'userMessage',
        content: [{ type: 'text', text: `${label} request` }],
      },
      {
        id: `answer-${label}`,
        type: 'agentMessage',
        text: `${label} response`,
      },
    ],
  })),
}

describe('Message branch navigation', () => {
  test('message versions group matching fork points without mixing a different earlier branch', async () => {
    const user = userEvent.setup()
    const onSelectBranch = vi.fn()
    render(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        branches={branches}
        conversationId='conversation-five'
        onSelectBranch={onSelectBranch}
      />
    )
    const second = screen.getByRole('group', { name: 'Versions of message 2' })
    expect(second).toHaveTextContent('3 / 3')
    await user.click(
      within(second).getByRole('button', { name: 'Previous branch' })
    )
    expect(onSelectBranch).toHaveBeenCalledWith('conversation-eight', 1)
    const third = screen.getByRole('group', { name: 'Versions of message 3' })
    expect(third).toHaveTextContent('2 / 2')
    await user.click(
      within(third).getByRole('button', { name: 'Previous branch' })
    )
    expect(onSelectBranch).toHaveBeenLastCalledWith('conversation-three', 2)
  })

  test('later edits remain one version of an earlier message and selecting the next version restores that branch', async () => {
    const user = userEvent.setup()
    const onSelectBranch = vi.fn()
    render(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        branches={branches}
        conversationId='conversation-four'
        onSelectBranch={onSelectBranch}
      />
    )
    const second = screen.getByRole('group', { name: 'Versions of message 2' })
    expect(second).toHaveTextContent('1 / 3')
    expect(
      within(second).getByRole('button', { name: 'Previous branch' })
    ).toBeDisabled()
    await user.click(
      within(second).getByRole('button', { name: 'Next branch' })
    )
    expect(onSelectBranch).toHaveBeenCalledWith('conversation-eight', 1)
  })

  test('keyboard version selection is available without edit permissions or mutation callbacks', async () => {
    const user = userEvent.setup()
    const onSelectBranch = vi.fn()
    render(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        branches={branches}
        conversationId='conversation-seven'
        onSelectBranch={onSelectBranch}
        actionsDisabled
      />
    )
    const second = screen.getByRole('group', { name: 'Versions of message 2' })
    expect(second).toHaveTextContent('2 / 2')
    within(second).getByRole('button', { name: 'Previous branch' }).focus()
    await user.keyboard('{Enter}')
    expect(onSelectBranch).toHaveBeenCalledWith('conversation-six', 1)
  })

  test('missing revision ancestry offers an explicit conversation version selector instead of misleading message counts', async () => {
    const user = userEvent.setup()
    const onSelectBranch = vi.fn()
    render(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        branches={[
          branches[0],
          {
            ...branches[2],
            branch: {
              rootConversationId: 'family-a',
              revisionId: 'three',
              version: 3,
              turnIndex: 1,
              parentRevisionId: 'deleted-revision',
            },
          },
        ]}
        conversationId='conversation-three'
        onSelectBranch={onSelectBranch}
      />
    )
    expect(
      screen.queryByRole('group', { name: 'Versions of message 2' })
    ).not.toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Conversation version' }),
      'conversation-one'
    )
    expect(onSelectBranch).toHaveBeenCalledWith('conversation-one')
  })
})

const questionThread: CodexThread = {
  id: 'question-thread',
  turns: [
    {
      id: 'question-turn',
      status: 'completed',
      items: [
        {
          id: 'user-question',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Ask me for design preferences' }],
        },
        {
          id: 'question-answer',
          type: 'agentMessage',
          phase: 'final_answer',
          delivery: 'async',
          text: 'Which theme?\n- Light\n- Dark',
          questions: [
            { title: 'Which theme?', options: ['Light', 'Dark'] },
            { title: 'Preferred typeface?', options: ['Sans', 'Serif'] },
          ],
        },
      ],
    },
  ],
}

describe('Asynchronous questions in assistant messages', () => {
  test('selected options and a custom answer submit a new reply and remain visible after success', async () => {
    const user = userEvent.setup()
    const onReply = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()
    render(
      <CodexConversation
        {...defaults}
        thread={questionThread}
        onReply={onReply}
        onRetry={onRetry}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Your answer: Preferred typeface?' }),
      'System font'
    )
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(onReply).toHaveBeenCalledWith(
      'Which theme?\nDark\n\nPreferred typeface?\nSystem font'
    )
    expect(onRetry).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Answers submitted')
    expect(screen.getByText('Dark', { selector: 'dd' })).toBeVisible()
    expect(screen.getByText('System font', { selector: 'dd' })).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Submit answers' })
    ).not.toBeInTheDocument()
  })

  test('a failed answer submission preserves choices and shows an actionable error', async () => {
    const user = userEvent.setup()
    render(
      <CodexConversation
        {...defaults}
        thread={questionThread}
        onReply={vi.fn().mockRejectedValue(new Error('Connection unavailable'))}
      />
    )
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    await user.click(screen.getByRole('radio', { name: 'Sans' }))
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connection unavailable'
    )
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Sans' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeEnabled()
  })

  test('refresh recovers submitted answers from persisted conversation messages', () => {
    const answered = structuredClone(questionThread)
    answered.turns.push({
      id: 'answer-turn',
      status: 'completed',
      items: [
        {
          id: 'user-answers',
          type: 'userMessage',
          content: [
            {
              type: 'text',
              text: 'Which theme?\nDark\n\nPreferred typeface?\nSystem font',
            },
          ],
        },
      ],
    })
    render(
      <CodexConversation {...defaults} thread={answered} onReply={vi.fn()} />
    )
    expect(screen.getByText('Dark', { selector: 'dd' })).toBeVisible()
    expect(screen.getByText('System font', { selector: 'dd' })).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Submit answers' })
    ).not.toBeInTheDocument()
  })

  test('deleting a submitted answer hides its values in the question card after refresh without reopening the old question', () => {
    const answered = structuredClone(questionThread)
    answered.turns.push({
      id: 'answer-turn',
      status: 'completed',
      deletedRoles: ['user'],
      items: [
        {
          id: 'user-answers',
          type: 'userMessage',
          content: [
            {
              type: 'text',
              text: 'Which theme?\nDark\n\nPreferred typeface?\nHidden personal preference',
            },
          ],
        },
      ],
    })
    render(
      <CodexConversation {...defaults} thread={answered} onReply={vi.fn()} />
    )
    expect(
      screen.queryByText('Hidden personal preference')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Submit answers' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'This conversation has continued. Send a new message to update your answers.'
      )
    ).toBeVisible()
  })

  test('busy or read-only conversations keep questions visible with disabled controls', () => {
    render(
      <CodexConversation
        {...defaults}
        thread={questionThread}
        running
        onReply={vi.fn()}
      />
    )
    expect(screen.getByRole('radio', { name: 'Light' })).toBeDisabled()
    expect(
      screen.getByRole('textbox', { name: 'Your answer: Preferred typeface?' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
  })
})

describe('Search result positioning', () => {
  test('focusing an older result selects the matching turn and preserves it during later streaming', () => {
    const { rerender } = render(
      <CodexConversation {...defaults} thread={branchThread} />
    )
    const viewport = screen.getByRole('region', { name: 'Task conversation' })
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 400 },
    })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    rerender(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        focusTurnId='turn-First'
      />
    )
    expect(screen.getByText('First request').closest('section')).toHaveFocus()
    const before = viewport.scrollTop
    const streamed = structuredClone(branchThread)
    streamed.turns[2].items[1].text += ' More output.'
    rerender(
      <CodexConversation
        {...defaults}
        thread={streamed}
        focusTurnId='turn-First'
        running
      />
    )
    expect(viewport.scrollTop).toBe(before)
  })

  test('opening a branch after an uncached conversation remount focuses the matching message index', () => {
    render(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        focusTurnIndex={1}
        focusTurnKey='branch-selection'
      />
    )
    expect(screen.getByText('Second request').closest('section')).toHaveFocus()
  })

  test('an unavailable search result gives a readable status without hiding the current conversation', () => {
    render(
      <CodexConversation
        {...defaults}
        thread={branchThread}
        focusTurnId='removed-turn'
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'This message is no longer available in this conversation.'
    )
    expect(screen.getByText('First request')).toBeVisible()
  })
})

describe('Codex Web task response cards', () => {
  test('the response card groups real execution details and deduplicates changed files with actual diff counts', async () => {
    const user = userEvent.setup()
    const changed = structuredClone(thread)
    changed.turns[0].items.splice(
      1,
      0,
      {
        id: 'file-old',
        type: 'fileChange',
        changes: [
          { path: 'src/app.tsx', diff: '@@ -1 +1 @@\n-old\n+intermediate' },
        ],
      },
      {
        id: 'file-new',
        type: 'fileChange',
        changes: [
          {
            path: 'src/app.tsx',
            diff: '--- a/src/app.tsx\n+++ b/src/app.tsx\n@@ -1 +1,2 @@\n-old\n+new\n+accessible',
          },
          { path: 'README.md' },
        ],
      }
    )
    render(<CodexConversation {...defaults} thread={changed} />)
    const files = screen.getByRole('region', { name: 'Changed 2 files' })
    expect(within(files).getByText('+2')).toBeVisible()
    expect(within(files).getByText('−1')).toBeVisible()
    expect(within(files).queryByText('intermediate')).not.toBeInTheDocument()
    const file = within(files).getByRole('button', { name: /src\/app.tsx/ })
    expect(file).toHaveAttribute('aria-expanded', 'false')
    await user.click(file)
    expect(file).toHaveAttribute('aria-expanded', 'true')
    expect(within(files).getByText(/accessible/)).toBeVisible()
    expect(
      screen
        .getByRole('button', { name: /Execution steps/ })
        .closest('[data-message-role="assistant"]')
    ).toHaveClass('codex-task-response-card')
    expect(
      screen
        .getByText('The page now keeps your place.')
        .closest('[data-message-role="assistant"]')
    ).toHaveClass('codex-task-response-card')
  })

  test('responses without file changes never claim invented modified files or testing results', () => {
    render(<CodexConversation {...defaults} thread={thread} />)
    expect(
      screen.queryByRole('region', { name: /Changed .* files/ })
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Testing')).not.toBeInTheDocument()
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
  })
})
