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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { ApprovalCard } from '../components/approval-card'
import type { CodexApproval } from '../types'

const command: CodexApproval = {
  id: 'command-1',
  method: 'item/commandExecution/requestApproval',
  params: {
    command: ['npm', 'test', '--', '--run'],
    cwd: '/workspace/example/project',
    reason: 'Run the checks for this change.',
  },
}

describe('ChatGPT inline approvals', () => {
  test('a long action keeps details collapsed and lets the user inspect the complete command and paths', async () => {
    const user = userEvent.setup()
    render(
      <ApprovalCard
        approval={{
          ...command,
          params: {
            ...command.params,
            permissions: {
              fileSystem: { read: ['/workspace/example/project/src'] },
            },
          },
        }}
        onApprove={vi.fn()}
      />
    )

    const commandDetails = screen.getByText('Command to run').closest('details')
    const paths = screen.getByText('Read access').closest('details')
    expect(commandDetails).not.toHaveAttribute('open')
    expect(paths).not.toHaveAttribute('open')
    await user.click(screen.getByText('Command to run'))
    expect(commandDetails).toHaveAttribute('open')
    expect(screen.getByText('/workspace/example/project')).toBeVisible()
    await user.click(screen.getByText('Read access'))
    expect(screen.getByText('/workspace/example/project/src')).toBeVisible()
  })

  test('single-choice questions support keyboard selection and a custom answer without sending both', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'question-1',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              {
                id: 'theme',
                question: 'Choose a theme',
                options: [{ label: 'Light' }, { label: 'Dark' }],
              },
            ],
          },
        }}
        onApprove={approve}
      />
    )

    await user.tab()
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus()
    await user.keyboard('[ArrowDown]')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    const answer = screen.getByRole('textbox', {
      name: 'Your answer: Choose a theme',
    })
    await user.type(answer, '  System preference  ')
    expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked()
    await user.keyboard('[Enter]')
    expect(approve).toHaveBeenCalledWith('question-1', {
      answers: { theme: { answers: ['System preference'] } },
    })
  })

  test('multiple selections and a written answer preserve the backend string-array contract', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'question-many',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              {
                id: 'checks',
                question: 'Which checks?',
                multiSelect: true,
                options: [{ label: 'Unit tests' }, { label: 'Browser tests' }],
              },
            ],
          },
        }}
        onApprove={approve}
      />
    )

    await user.click(screen.getByRole('checkbox', { name: 'Unit tests' }))
    await user.click(screen.getByRole('checkbox', { name: 'Browser tests' }))
    await user.type(screen.getByRole('textbox'), '  Accessibility  ')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(approve).toHaveBeenCalledWith('question-many', {
      answers: {
        checks: { answers: ['Unit tests', 'Browser tests', 'Accessibility'] },
      },
    })
  })

  test('secret answers remain masked and preserve meaningful spaces in the submitted value', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'secret',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              { id: 'password', question: 'Password', isSecret: true },
            ],
          },
        }}
        onApprove={approve}
      />
    )
    const input = screen.getByLabelText('Your answer: Password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('maxLength', '10000')
    await user.type(input, '  example  ')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(approve).toHaveBeenCalledWith('secret', {
      answers: { password: { answers: ['  example  '] } },
    })
  })

  test('every question needs an answer and choice-only questions do not offer unsupported free text', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'two-questions',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              { id: 'name', question: 'Project name?' },
              {
                id: 'storage',
                question: 'Storage?',
                isOther: false,
                options: [{ label: 'Local files' }, { label: 'Database' }],
              },
            ],
          },
        }}
        onApprove={approve}
      />
    )
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    await user.type(screen.getByRole('textbox'), 'Example')
    expect(submit).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: 'Local files' }))
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(approve).toHaveBeenCalledWith('two-questions', {
      answers: {
        name: { answers: ['Example'] },
        storage: { answers: ['Local files'] },
      },
    })
  })

  test('selecting 20 choices prevents a 21st answer and an over-limit custom answer explains how to recover', async () => {
    const user = userEvent.setup()
    const approve = vi.fn()
    const labels = [
      'Authentication',
      'Billing',
      'Catalog',
      'Dashboard',
      'Email',
      'Files',
      'Groups',
      'History',
      'Integrations',
      'Jobs',
      'Keys',
      'Logs',
      'Models',
      'Notifications',
      'Organizations',
      'Projects',
      'Quotas',
      'Reports',
      'Settings',
      'Teams',
      'Usage',
    ]
    render(
      <ApprovalCard
        approval={{
          id: 'limit',
          method: 'item/tool/requestUserInput',
          params: {
            questions: [
              {
                id: 'areas',
                question: 'Review which areas?',
                multiSelect: true,
                options: labels.map((label) => ({ label })),
              },
            ],
          },
        }}
        onApprove={approve}
      />
    )
    for (const label of labels.slice(0, 20)) {
      await user.click(screen.getByRole('checkbox', { name: label }))
    }
    expect(screen.getByRole('checkbox', { name: 'Usage' })).toBeDisabled()
    const answer = screen.getByRole('textbox')
    await user.type(answer, 'Accessibility')
    expect(answer).toHaveAttribute('aria-invalid', 'true')
    expect(answer).toHaveAccessibleDescription('Choose up to 20 answers.')
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Teams' }))
    expect(answer).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeEnabled()
    expect(approve).not.toHaveBeenCalled()
  })

  test('an in-flight decision announces its state, prevents duplicate submissions, and restores focus for retry on failure', async () => {
    const user = userEvent.setup()
    let rejectRequest: ((reason: Error) => void) | undefined
    const approve = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRequest = reject
          })
      )
      .mockResolvedValueOnce(undefined)
    render(<ApprovalCard approval={command} onApprove={approve} />)
    const allow = screen.getByRole('button', { name: 'Allow once' })
    await user.click(allow)
    expect(
      screen.getByRole('region', { name: 'Approval required' })
    ).toHaveAttribute('aria-busy', 'true')
    expect(allow).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Submitting...')
    await user.click(allow)
    expect(approve).toHaveBeenCalledTimes(1)

    await act(async () => {
      rejectRequest?.(new Error('Connection lost'))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection lost'
    )
    expect(allow).toBeEnabled()
    expect(allow).toHaveFocus()
    await user.keyboard('[Enter]')
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toHaveTextContent('Allowed')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('a new request does not retain the previous request answer or resolved state', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    const first: CodexApproval = {
      id: 'first',
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'name', question: 'Project name?' }] },
    }
    const view = render(<ApprovalCard approval={first} onApprove={approve} />)
    await user.type(screen.getByRole('textbox'), 'Original project')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    view.rerender(
      <ApprovalCard approval={{ ...first, id: 'second' }} onApprove={approve} />
    )
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
  })

  test('permission requests disclose turn scope and network access before an allow-once answer', async () => {
    const user = userEvent.setup()
    const approve = vi.fn().mockResolvedValue(undefined)
    render(
      <ApprovalCard
        approval={{
          id: 'permissions',
          method: 'item/permissions/requestApproval',
          params: { permissions: { network: { enabled: true } } },
        }}
        onApprove={approve}
      />
    )
    expect(screen.getByText('Network access')).toBeVisible()
    expect(screen.getByText('Access is limited to this turn.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(approve).toHaveBeenCalledWith('permissions', { decision: 'accept' })
  })

  test('malformed or missing questions show an actionable explanation without crashing or sending a decision', () => {
    const approve = vi.fn()
    render(
      <ApprovalCard
        approval={{
          id: 'missing',
          method: 'item/tool/requestUserInput',
          params: { questions: [null, { id: 2 }] },
        }}
        onApprove={approve}
      />
    )
    const card = screen.getByRole('region', { name: 'Codex needs your input' })
    expect(
      within(card).getByText('No questions were included in this request.')
    ).toBeVisible()
    expect(
      within(card).getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    expect(approve).not.toHaveBeenCalled()
  })
})

test('account changes show their tool arguments and offer explicit approval', async () => {
  const approve = vi.fn().mockResolvedValue(undefined)
  render(
    <ApprovalCard
      approval={{
        id: 'account-change',
        method: 'workbench/newapi/approval',
        params: {
          name: 'profile.update',
          arguments: { display_name: 'Owner' },
          reason: 'Update your profile',
        },
      }}
      onApprove={approve}
    />
  )
  expect(screen.getByText('Change New API settings?')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
  await waitFor(() =>
    expect(approve).toHaveBeenCalledWith('account-change', {
      decision: 'accept',
    })
  )
})
