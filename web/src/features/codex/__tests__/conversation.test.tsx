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
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodexConversation } from '../components/conversation'
import type { CodexThread } from '../types'

const thread: CodexThread = {
  id: 'thread-a',
  turns: [
    {
      id: 'turn-a',
      status: 'completed',
      items: [
        {
          id: 'user-a',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Fix the page' }],
        },
        {
          id: 'command-a',
          type: 'commandExecution',
          command: 'npm test',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'All tests passed',
        },
        {
          id: 'file-a',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'src/login.tsx', diff: '+ fixed login' }],
        },
        {
          id: 'answer-a',
          type: 'agentMessage',
          text: '**Fixed** the login page.',
          status: 'completed',
        },
      ],
    },
  ],
}
const props = { running: false, approvals: [], onApprove: vi.fn() }

describe('Codex task conversation', () => {
  test('completed tool steps collapse into a summary while the final Markdown answer remains visible', async () => {
    render(<CodexConversation {...props} thread={thread} />)
    expect(screen.queryByText('Task completed')).not.toBeInTheDocument()
    expect(screen.getByText('Fixed')).toHaveProperty('tagName', 'STRONG')
    const steps = screen.getByRole('button', { name: /Execution steps/ })
    expect(steps).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('All tests passed')).not.toBeInTheDocument()
    await userEvent.click(steps)
    expect(steps).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('npm test')).toBeVisible()
    expect(screen.getByText('login.tsx')).toBeVisible()
  })
  test('reader scrolling into history is not dragged to the bottom by streamed content', async () => {
    const { rerender } = render(
      <CodexConversation {...props} thread={thread} />
    )
    const viewport = screen.getByLabelText('Task conversation')
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    const updated = structuredClone(thread)
    updated.turns[0].items[3].text += ' More details.'
    rerender(<CodexConversation {...props} thread={updated} />)
    expect(viewport.scrollTop).toBe(100)
    await userEvent.click(
      screen.getByRole('button', { name: 'Scroll to latest message' })
    )
    expect(viewport.scrollTop).toBe(1000)
    expect(
      screen.queryByRole('button', { name: 'Scroll to latest message' })
    ).not.toBeInTheDocument()
  })
  test('selecting another conversation restores following its latest message', () => {
    const { rerender } = render(
      <CodexConversation {...props} thread={thread} />
    )
    const viewport = screen.getByLabelText('Task conversation')
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    })
    viewport.scrollTop = 100
    fireEvent.scroll(viewport)
    rerender(
      <CodexConversation {...props} thread={{ ...thread, id: 'thread-b' }} />
    )
    expect(viewport.scrollTop).toBe(1000)
    expect(
      screen.queryByRole('button', { name: 'Scroll to latest message' })
    ).not.toBeInTheDocument()
  })
  test('interrupted and failed turns have distinct explanations and no completion label', () => {
    render(
      <CodexConversation
        {...props}
        thread={{
          id: 'thread-states',
          turns: [
            { id: 'stop', status: 'interrupted', items: [] },
            {
              id: 'fail',
              status: 'failed',
              items: [],
              error: { message: 'Connection unavailable' },
            },
          ],
        }}
      />
    )
    expect(
      screen.getByText('Task stopped. Send a message to continue.')
    ).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('Task failed')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connection unavailable'
    )
    expect(screen.queryByText('Task completed')).not.toBeInTheDocument()
  })
  test('a running implementation plan remains collapsed until requested', async () => {
    render(
      <CodexConversation
        {...props}
        running
        thread={{
          id: 'planned',
          turns: [
            {
              id: 'plan-turn',
              status: 'inProgress',
              items: [],
              plan: [
                { step: 'Read source', status: 'completed' },
                { step: 'Implement changes', status: 'inProgress' },
                { step: 'Run checks', status: 'pending' },
              ],
            },
          ],
        }}
      />
    )
    expect(screen.getByText('Implementation plan')).toBeVisible()
    expect(screen.queryByText('Read source')).not.toBeVisible()
    await userEvent.click(screen.getByText('Implementation plan'))
    expect(screen.getByText('Read source')).toBeVisible()
    expect(screen.getByText('Implement changes')).toBeVisible()
    expect(screen.getByLabelText('Completed')).toBeInTheDocument()
    expect(screen.getByLabelText('Running')).toBeInTheDocument()
    expect(screen.getByLabelText('Pending')).toBeInTheDocument()
  })
  test('keyboard users can expand command output and close it without leaving the conversation', async () => {
    const user = userEvent.setup()
    render(<CodexConversation {...props} thread={thread} />)
    const steps = screen.getByRole('button', { name: /Execution steps/ })
    steps.focus()
    await user.keyboard('{Enter}')
    const command = screen.getByRole('button', { name: /Command npm test/ })
    expect(command).toHaveAttribute('aria-expanded', 'false')
    command.focus()
    await user.keyboard(' ')
    expect(command).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('All tests passed')).toBeVisible()
    await user.keyboard(' ')
    expect(screen.queryByText('All tests passed')).not.toBeInTheDocument()
    expect(command).toHaveFocus()
  })
})

describe('Codex message actions', () => {
  test('intermediate assistant output is collapsed and only the final response has response actions', async () => {
    const expanded = structuredClone(thread)
    expanded.turns[0].items.splice(1, 0, {
      id: 'intermediate',
      type: 'agentMessage',
      phase: 'commentary',
      text: 'I will inspect the implementation.',
    })
    render(
      <CodexConversation
        {...props}
        thread={expanded}
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(
      screen.queryByText('I will inspect the implementation.')
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: 'Copy response' })
    ).toHaveLength(1)
    await userEvent.click(
      screen.getByRole('button', { name: /Execution steps/ })
    )
    expect(screen.getByText('I will inspect the implementation.')).toBeVisible()
    expect(
      screen.getAllByRole('button', { name: 'Copy response' })
    ).toHaveLength(1)
  })
  test('user and assistant actions retry the original prompt and delete only the selected role', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined),
      onRetry = vi.fn().mockResolvedValue(undefined)
    render(
      <CodexConversation
        {...props}
        thread={thread}
        onDelete={onDelete}
        onRetry={onRetry}
      />
    )
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Retry message' })[1]
    )
    expect(onRetry).toHaveBeenCalledWith('turn-a', 'Fix the page')
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete message' })[0]
    )
    expect(onDelete).toHaveBeenCalledWith('turn-a', 'user')
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Delete message' })[1]
    )
    expect(onDelete).toHaveBeenCalledWith('turn-a', 'assistant')
  })
  test('editing a user message allows cancel and resends the edited text', async () => {
    const user = userEvent.setup(),
      onRetry = vi.fn().mockResolvedValue(undefined)
    render(<CodexConversation {...props} thread={thread} onRetry={onRetry} />)
    await user.click(screen.getByRole('button', { name: 'Edit message' }))
    const editor = screen.getByRole('textbox', { name: 'Edit message' })
    expect(editor).toHaveValue('Fix the page')
    expect(editor).toHaveFocus()
    await user.clear(editor)
    expect(
      screen.getByRole('button', { name: 'Save and retry' })
    ).toBeDisabled()
    await user.type(editor, 'Fix the mobile page')
    await user.click(screen.getByRole('button', { name: 'Save and retry' }))
    expect(onRetry).toHaveBeenCalledWith('turn-a', 'Fix the mobile page')
  })
  test('deleted messages remain absent and busy tasks disable mutations', () => {
    const deleted = structuredClone(thread)
    deleted.turns[0].deletedRoles = ['assistant']
    render(
      <CodexConversation
        {...props}
        thread={deleted}
        actionsDisabled
        onDelete={vi.fn()}
        onRetry={vi.fn()}
      />
    )
    expect(screen.queryByText('Fixed')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete message' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retry message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDisabled()
  })
})
