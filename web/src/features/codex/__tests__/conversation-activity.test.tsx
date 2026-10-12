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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodexConversation } from '../components/conversation'
import type { CodexThread } from '../types'

const defaults = { approvals: [], onApprove: vi.fn() }
const activeThread: CodexThread = {
  id: 'task',
  turns: [
    {
      id: 'turn',
      status: 'inProgress',
      items: [
        {
          id: 'request',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Check the settings page' }],
        },
        {
          id: 'progress',
          type: 'agentMessage',
          phase: 'commentary',
          text: 'I am checking keyboard navigation.',
          status: 'completed',
        },
        {
          id: 'command',
          type: 'commandExecution',
          command: 'bun test',
          status: 'inProgress',
          aggregatedOutput: 'Checking keyboard navigation',
        },
      ],
    },
  ],
}

describe('Continuous task activity', () => {
  test('expanded execution steps use a compact list while keeping each command accessible', async () => {
    render(<CodexConversation {...defaults} thread={activeThread} running />)
    await userEvent.click(
      screen.getByRole('button', { name: /Execution steps/ })
    )
    expect(screen.getByRole('list', { name: 'Execution steps' })).toHaveClass(
      'space-y-0.5'
    )
    expect(
      screen.getByRole('button', { name: /Command bun test/ })
    ).toBeEnabled()
  })

  test('the latest live update is readable without expanding command details', () => {
    render(<CodexConversation {...defaults} thread={activeThread} running />)
    expect(screen.getByText('I am checking keyboard navigation.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: /Execution steps/ })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByText('Checking keyboard navigation')
    ).not.toBeInTheDocument()
  })

  test('finishing a command preserves the execution details the reader opened', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <CodexConversation {...defaults} thread={activeThread} running />
    )
    await user.click(screen.getByRole('button', { name: /Execution steps/ }))
    const command = screen.getByRole('button', { name: /Command bun test/ })
    if (command.getAttribute('aria-expanded') !== 'true') {
      await user.click(command)
    }
    const completed = structuredClone(activeThread)
    completed.turns[0].status = 'completed'
    completed.turns[0].items[2].status = 'completed'
    completed.turns[0].items[2].exitCode = 0
    completed.turns[0].items.push({
      id: 'answer',
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'Keyboard navigation passes.',
    })
    rerender(
      <CodexConversation {...defaults} thread={completed} running={false} />
    )
    expect(
      screen.getByRole('button', { name: /Execution steps/ })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('button', { name: /Command bun test/ })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Checking keyboard navigation')).toBeVisible()
    expect(screen.getByText('Keyboard navigation passes.')).toBeVisible()
  })

  test('a stopped task never labels unfinished commands as still running', async () => {
    const stopped = structuredClone(activeThread)
    stopped.turns[0].status = 'interrupted'
    render(<CodexConversation {...defaults} thread={stopped} running={false} />)
    await userEvent.click(
      screen.getByRole('button', { name: /Execution steps/ })
    )
    const command = screen.getByRole('button', { name: /Command bun test/ })
    expect(command).toHaveTextContent('Stopped')
    expect(command).not.toHaveTextContent('Running')
  })

  test('tool details expose readable output without serializing private protocol fields', async () => {
    const thread: CodexThread = {
      id: 'tools',
      turns: [
        {
          id: 'tools-turn',
          status: 'completed',
          items: [
            {
              id: 'private-item-id',
              type: 'customOperation',
              text: 'Indexed 3 project files.',
              status: 'completed',
              debug: { token: 'private-debug-token' },
              arguments: { authorization: 'private-header-value' },
            },
          ],
        },
      ],
    }
    render(<CodexConversation {...defaults} thread={thread} running={false} />)
    await userEvent.click(
      screen.getByRole('button', { name: /Execution steps/ })
    )
    await userEvent.click(screen.getByRole('button', { name: /Tool activity/ }))
    expect(screen.getByText('Indexed 3 project files.')).toBeVisible()
    expect(
      screen.queryByText(
        /private-debug-token|private-header-value|private-item-id/
      )
    ).not.toBeInTheDocument()
  })

  test('failed file changes are available in activity but never counted as applied files', async () => {
    const thread: CodexThread = {
      id: 'files',
      turns: [
        {
          id: 'files-turn',
          status: 'completed',
          items: [
            {
              id: 'failed-change',
              type: 'fileChange',
              status: 'failed',
              changes: [{ path: 'settings.tsx', diff: '+never applied' }],
            },
            {
              id: 'answer',
              type: 'agentMessage',
              text: 'The requested change could not be applied.',
            },
          ],
        },
      ],
    }
    render(<CodexConversation {...defaults} thread={thread} running={false} />)
    expect(
      screen.queryByRole('region', { name: /Changed .* files/ })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: /Execution steps/ })
    )
    expect(screen.getByText('settings.tsx')).toBeVisible()
  })

  test('native user attachments remain visible by filename without exposing their local directory', () => {
    const thread: CodexThread = {
      id: 'attachments',
      turns: [
        {
          id: 'attachment-turn',
          status: 'completed',
          items: [
            {
              id: 'request',
              type: 'userMessage',
              content: [
                { type: 'text', text: 'Review this screenshot' },
                {
                  type: 'localImage',
                  path: '/private/task/uploads/screenshot.png',
                },
              ],
            },
          ],
        },
      ],
    }
    render(<CodexConversation {...defaults} thread={thread} running={false} />)
    const attachments = screen.getByRole('list', { name: 'Attachments' })
    expect(within(attachments).getByText('screenshot.png')).toBeVisible()
    expect(
      screen.queryByText('/private/task/uploads/screenshot.png')
    ).not.toBeInTheDocument()
  })
})
