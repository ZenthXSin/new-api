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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { ApprovalCard } from '../components/approval-card'

describe('Codex approval methods', () => {
  test('command approval sends an allow-once decision and locks repeat clicks', async () => {
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'command/1',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'npm test' },
        }}
        onApprove={approve}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(approve).toHaveBeenCalledWith('command/1', { decision: 'accept' })
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled()
  })
  test('failed approval remains actionable and displays its error', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('Connection lost'))
    render(
      <ApprovalCard
        approval={{
          id: '1',
          method: 'item/fileChange/requestApproval',
          params: {},
        }}
        onApprove={approve}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection lost'
    )
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled()
  })
  test('user questions require an answer and send the method-specific answer object', async () => {
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'question',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              {
                id: 'layout',
                question: 'Which layout?',
                options: [
                  { label: 'Compact', description: 'More space' },
                  { label: 'Wide' },
                ],
              },
            ],
          },
        }}
        onApprove={approve}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: 'Compact' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Submit answers' })
    )
    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith('question', {
        answers: { layout: { answers: ['Compact'] } },
      })
    )
  })
  test('unsupported MCP forms offer decline and never a misleading accept action', async () => {
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'mcp',
          method: 'mcpServer/elicitation/request',
          params: { message: 'Details' },
        }}
        onApprove={approve}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Allow once' })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(approve).toHaveBeenCalledWith('mcp', { decision: 'decline' })
  })
})
