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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { CodexComposer } from '../components/composer'
import type { CodexQueuedTurn } from '../types'
import { status } from './fixtures'

const props = {
  status,
  model: 'codex-test',
  effort: 'high',
  mode: 'code' as const,
  onModel: vi.fn(),
  onEffort: vi.fn(),
  onMode: vi.fn(),
}
const queued: CodexQueuedTurn = {
  requestId: 'queued-request',
  prompt: 'Add a settings page',
  model: 'codex-test',
  group: 'default',
  effort: 'high',
  mode: 'code',
  conversationId: 'conversation-1',
  createdAt: 1,
  status: 'queued',
}

test('Enter during a running task queues the draft and clears it after acceptance', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(
    <CodexComposer {...props} running onSubmit={submit} onStop={vi.fn()} />
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Next task' },
  })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Next task', busyAction: 'queue' })
    )
  )
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
  expect(screen.getByRole('button', { name: 'Stop task' })).toBeEnabled()
})

test('a failed queue request preserves the draft and retries the same request', async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(undefined)
  render(<CodexComposer {...props} busy onSubmit={submit} />)
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Keep this request' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
  expect(screen.getByRole('textbox')).toHaveValue('Keep this request')
  await userEvent.click(screen.getByRole('button', { name: 'Queue message' }))
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
  expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0])
})

test('an explicit interrupt sends the draft with interrupt intent while another conversation runs', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  render(<CodexComposer {...props} busy onSubmit={submit} />)
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Do this first' },
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Interrupt and send' })
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Do this first',
      busyAction: 'interrupt',
    })
  )
  expect(
    screen.queryByRole('button', { name: 'Stop task' })
  ).not.toBeInTheDocument()
})

test('restored queue entries display their prompt and cancel only the selected request', async () => {
  const cancel = vi.fn().mockResolvedValue(undefined)
  render(
    <CodexComposer
      {...props}
      queuedTurns={[queued]}
      onCancelQueued={cancel}
      onSubmit={vi.fn()}
    />
  )
  const queue = screen.getByRole('region', { name: 'Queued messages' })
  expect(within(queue).getByText('Queued messages (1)')).toBeVisible()
  expect(within(queue).getByText(queued.prompt)).toBeVisible()
  await userEvent.click(
    within(queue).getByRole('button', {
      name: 'Cancel queued message: Add a settings page',
    })
  )
  expect(cancel).toHaveBeenCalledWith(queued.requestId)
})

test('a queued request that is starting shows progress and cannot be cancelled from the queue', async () => {
  const cancel = vi.fn()
  render(
    <CodexComposer
      {...props}
      queuedTurns={[{ ...queued, status: 'starting' }]}
      onCancelQueued={cancel}
      onSubmit={vi.fn()}
    />
  )
  expect(screen.getByText('Starting task…')).toBeVisible()
  const button = screen.getByRole('button', {
    name: 'Cancel queued message: Add a settings page',
  })
  expect(button).toBeDisabled()
  await userEvent.click(button)
  expect(cancel).not.toHaveBeenCalled()
})

test('a paused request with an unknown start result cannot be resumed but can still be cancelled', async () => {
  const resume = vi.fn()
  const cancel = vi.fn().mockResolvedValue(undefined)
  render(
    <CodexComposer
      {...props}
      queuedTurns={[{ ...queued, status: 'paused', canResume: false }]}
      onResumeQueued={resume}
      onCancelQueued={cancel}
      onSubmit={vi.fn()}
    />
  )
  const resumeButton = screen.getByRole('button', {
    name: 'Resume queued message: Add a settings page',
  })
  expect(resumeButton).toBeDisabled()
  await userEvent.click(resumeButton)
  expect(resume).not.toHaveBeenCalled()
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Cancel queued message: Add a settings page',
    })
  )
  expect(cancel).toHaveBeenCalledWith(queued.requestId)
})

test('a paused request can be resumed and cancellation failures keep its preview visible', async () => {
  const resume = vi.fn().mockResolvedValue(undefined)
  const cancel = vi.fn().mockRejectedValue(new Error('Cannot cancel'))
  render(
    <CodexComposer
      {...props}
      queuedTurns={[
        { ...queued, status: 'paused', error: 'Reconnect to continue' },
      ]}
      onCancelQueued={cancel}
      onResumeQueued={resume}
      onSubmit={vi.fn()}
    />
  )
  expect(screen.getByText(/^Paused/)).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Resume queued message: Add a settings page',
    })
  )
  expect(resume).toHaveBeenCalledWith(queued.requestId)
  await userEvent.click(
    screen.getByRole('button', {
      name: 'Cancel queued message: Add a settings page',
    })
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot cancel')
  expect(screen.getByText(queued.prompt)).toBeVisible()
})

test('the attachment menu opens the project file picker while idle and is disabled while busy', async () => {
  const upload = vi.fn()
  const { rerender } = render(
    <CodexComposer {...props} onUploadFiles={upload} onSubmit={vi.fn()} />
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Add files and more' })
  )
  await userEvent.click(
    screen.getByRole('menuitem', { name: 'Add photos & files' })
  )
  expect(upload).toHaveBeenCalledOnce()
  rerender(
    <CodexComposer {...props} busy onUploadFiles={upload} onSubmit={vi.fn()} />
  )
  expect(
    screen.getByRole('button', { name: 'Add files and more' })
  ).toBeDisabled()
})

test('uploaded file chips expose their paths and remove only the selected attachment reference', async () => {
  const remove = vi.fn()
  render(
    <CodexComposer
      {...props}
      uploadedFiles={['assets/example.png', 'notes.txt']}
      onRemoveUploadedFile={remove}
      onSubmit={vi.fn()}
    />
  )
  const attachments = screen.getByRole('list', { name: 'Uploaded files' })
  expect(within(attachments).getByText('assets/example.png')).toBeVisible()
  await userEvent.click(
    within(attachments).getByRole('button', {
      name: 'Remove attachment assets/example.png',
    })
  )
  expect(remove).toHaveBeenCalledWith('assets/example.png')
})

test('changing attachments after a failed send creates a new request identity', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('Offline'))
  const { rerender } = render(
    <CodexComposer {...props} uploadedFiles={['first.txt']} onSubmit={submit} />
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Review these files' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByRole('alert')
  rerender(
    <CodexComposer
      {...props}
      uploadedFiles={['second.txt']}
      onSubmit={submit}
    />
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByRole('alert')
  expect(submit.mock.calls[0][0].requestId).not.toBe(
    submit.mock.calls[1][0].requestId
  )
})
