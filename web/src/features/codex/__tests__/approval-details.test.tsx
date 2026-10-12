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

import { ApprovalCard } from '../components/approval-card'

describe('Approval action details', () => {
  test('a file approval discloses the requested directory and linked patch through a focusable file disclosure', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'file-approval',
          method: 'item/fileChange/requestApproval',
          params: {
            itemId: 'patch',
            reason: 'Update the navigation.',
            grantRoot: '/workspace/app',
          },
        }}
        item={{
          id: 'patch',
          type: 'fileChange',
          changes: [
            {
              path: '/workspace/app/navigation.tsx',
              kind: { type: 'update' },
              diff: '-Old navigation\n+New navigation',
            },
          ],
        }}
        onApprove={approve}
      />
    )

    expect(screen.getByText('Update the navigation.')).toBeVisible()
    expect(screen.getByText('/workspace/app')).toBeVisible()
    const file = screen.getByText('/workspace/app/navigation.tsx')
    expect(file).toBeVisible()
    const details = file.closest('details')
    expect(details).not.toHaveAttribute('open')
    file.closest('summary')?.focus()
    expect(file.closest('summary')).toHaveFocus()
    await user.click(file)
    expect(details).toHaveAttribute('open')
    expect(screen.getByText(/-Old navigation\s+\+New navigation/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(approve).toHaveBeenCalledWith('file-approval', {
      decision: 'accept',
    })
  })

  test('command approvals display additional permission entries and the exact network destination', () => {
    render(
      <ApprovalCard
        approval={{
          id: 'command-approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            command: 'bun install',
            cwd: '/workspace/app',
            reason: 'Install project dependencies.',
            additionalPermissions: {
              fileSystem: {
                entries: [
                  {
                    access: 'read',
                    path: { type: 'path', path: '/opt/cache' },
                  },
                  {
                    access: 'write',
                    path: {
                      type: 'glob_pattern',
                      pattern: '/workspace/app/node_modules/**',
                    },
                  },
                ],
              },
              network: { enabled: true },
            },
            networkApprovalContext: {
              host: 'registry.npmjs.org',
              protocol: 'https',
            },
          },
        }}
        onApprove={vi.fn()}
      />
    )

    expect(screen.getByText('/workspace/app')).toBeVisible()
    expect(screen.getByText('registry.npmjs.org')).toBeVisible()
    expect(screen.getByText('https')).toBeVisible()
    expect(screen.getByText('Read access')).toBeVisible()
    expect(screen.getByText('Write access')).toBeVisible()
    expect(screen.getByText('/opt/cache')).toBeInTheDocument()
    expect(
      screen.getByText('Pattern: /workspace/app/node_modules/**')
    ).toBeInTheDocument()
  })

  test('upstream decisions restrict the available local answers instead of suggesting an unsupported approval', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'restricted',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'bun install', availableDecisions: ['decline'] },
        }}
        onApprove={approve}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Allow once' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    expect(approve).toHaveBeenCalledWith('restricted', { decision: 'decline' })
  })

  test('a request with only unsupported decisions explains that it cannot be answered', () => {
    const approve = vi.fn()
    render(
      <ApprovalCard
        approval={{
          id: 'unsupported-decision',
          method: 'item/commandExecution/requestApproval',
          params: { availableDecisions: ['cancel'] },
        }}
        onApprove={approve}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Allow once' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Decline' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'This request needs an action that is not available here. Stop the task to continue.'
      )
    ).toBeVisible()
    expect(approve).not.toHaveBeenCalled()
  })

  test('terminal input approvals are distinguished from a new command', () => {
    render(
      <ApprovalCard
        approval={{
          id: 'stdin',
          method: 'item/commandExecution/requestApproval',
          params: { kind: 'writeStdin', command: 'y' },
        }}
        onApprove={vi.fn()}
      />
    )
    expect(screen.getByText('Send input to the running command?')).toBeVisible()
    expect(screen.queryByText('Run this command?')).not.toBeInTheDocument()
  })

  test('an invalid question among valid ones is explained instead of leaving a silently disabled submission', async () => {
    const user = userEvent.setup()
    const approve = vi.fn()
    render(
      <ApprovalCard
        approval={{
          id: 'invalid-questions',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              { id: 'theme', question: 'Theme?' },
              { question: 'No ID' },
            ],
          },
        }}
        onApprove={approve}
      />
    )
    const card = screen.getByRole('region', { name: 'Codex needs your input' })
    await user.type(within(card).getByRole('textbox'), 'Dark')
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'Some questions could not be displayed. Ask Codex to send them again.'
    )
    expect(
      within(card).getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    expect(approve).not.toHaveBeenCalled()
  })

  test('question progress reflects completed questions and Ctrl+Enter sends all answers', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'keyboard',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              {
                id: 'theme',
                question: 'Theme?',
                isOther: false,
                options: [{ label: 'Dark' }],
              },
              {
                id: 'density',
                question: 'Density?',
                isOther: false,
                options: [{ label: 'Compact' }],
              },
            ],
          },
        }}
        onApprove={approve}
      />
    )
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(screen.getByText('1 of 2 answered')).toBeVisible()
    await user.click(screen.getByRole('radio', { name: 'Compact' }))
    await user.keyboard('{Control>}[Enter]{/Control}')
    expect(approve).toHaveBeenCalledWith('keyboard', {
      answers: {
        theme: { answers: ['Dark'] },
        density: { answers: ['Compact'] },
      },
    })
  })
})
