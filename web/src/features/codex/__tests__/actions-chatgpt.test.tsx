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

import { QueuedTurns } from '../components/queued-turns'
import { WorkspaceActions } from '../components/workspace-actions'
import type { CodexQueuedTurn } from '../types'
import { workspace } from './fixtures'

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

function projectActions() {
  return {
    workspace,
    disabled: false,
    onRename: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
  }
}

describe('ChatGPT project menu', () => {
  test('opening a project menu gives project context and Escape restores keyboard focus', async () => {
    render(<WorkspaceActions {...projectActions()} />)
    const trigger = screen.getByRole('button', { name: 'Project actions' })
    expect(trigger).toHaveAttribute('aria-description', workspace.name)
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('menuitem', { name: 'Rename project' })
    ).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Import ZIP' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  test.each([
    ['Rename project', 'onRename'],
    ['Import ZIP', 'onImport'],
    ['Export project', 'onExport'],
    ['Archive project', 'onArchive'],
    ['Delete project', 'onDelete'],
  ] as const)(
    'choosing %s closes the menu and runs its project callback',
    async (label, callback) => {
      const props = projectActions()
      render(<WorkspaceActions {...props} />)
      const trigger = screen.getByRole('button', { name: 'Project actions' })
      await userEvent.click(trigger)
      await userEvent.click(screen.getByRole('menuitem', { name: label }))
      expect(props[callback]).toHaveBeenCalledOnce()
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    }
  )

  test('an archived project exposes restore and invokes the archive callback', async () => {
    const props = projectActions()
    render(
      <WorkspaceActions
        {...props}
        workspace={{ ...workspace, archived: true }}
      />
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Project actions' })
    )
    expect(
      screen.queryByRole('menuitem', { name: 'Archive project' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Restore project' })
    )
    expect(props.onArchive).toHaveBeenCalledOnce()
  })

  test('blocked mutations remain visible but cannot execute from the menu', async () => {
    const props = projectActions()
    render(<WorkspaceActions {...props} disabled />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Project actions' })
    )
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('aria-disabled', 'true')
    }
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Delete project' })
    )
    expect(props.onDelete).not.toHaveBeenCalled()
  })
})

describe('ChatGPT queued message actions', () => {
  test('an empty queue does not occupy space above the composer', () => {
    render(<QueuedTurns turns={[]} />)
    expect(
      screen.queryByRole('region', { name: 'Queued messages' })
    ).not.toBeInTheDocument()
  })

  test('queue preview can be collapsed and expanded with a keyboard without losing messages', async () => {
    render(<QueuedTurns turns={[queued]} />)
    expect(screen.getByText('Queued')).toBeVisible()
    const toggle = screen.getByRole('button', { name: 'Hide queued messages' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(
      screen.getByRole('button', { name: 'Show queued messages' })
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(queued.prompt)).not.toBeVisible()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByText(queued.prompt)).toBeVisible()
  })

  test('long queued prompts keep their full preview text while the queue scrolls within the composer', () => {
    const prompt =
      'Review the settings changes and document the validation behavior for every supported deployment environment. '
    render(
      <QueuedTurns
        turns={[
          { ...queued, prompt },
          { ...queued, requestId: 'second', prompt: 'Review changes' },
        ]}
      />
    )
    const list = screen.getByRole('list')
    expect(list).toHaveClass(
      'max-h-44',
      'overflow-y-auto',
      'overscroll-contain'
    )
    expect(screen.getByText(prompt.trim())).toHaveAttribute('title', prompt)
    expect(screen.getByText(prompt.trim())).toHaveClass(
      'line-clamp-2',
      'break-words'
    )
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  test('resuming a paused message announces progress on its resume control and blocks duplicate actions', async () => {
    let complete: () => void = () => undefined
    const resume = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    const cancel = vi.fn()
    render(
      <QueuedTurns
        turns={[{ ...queued, status: 'paused' }]}
        onResume={resume}
        onCancel={cancel}
      />
    )
    const resumeButton = screen.getByRole('button', {
      name: `Resume queued message: ${queued.prompt}`,
    })
    const cancelButton = screen.getByRole('button', {
      name: `Cancel queued message: ${queued.prompt}`,
    })
    await userEvent.click(resumeButton)
    expect(resume).toHaveBeenCalledWith(queued.requestId)
    expect(resumeButton).toHaveAttribute('aria-busy', 'true')
    expect(cancelButton).not.toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Resuming queued message…'
    )
    expect(resumeButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()
    await userEvent.click(resumeButton)
    expect(resume).toHaveBeenCalledOnce()
    await act(async () => {
      complete()
    })
    expect(resumeButton).toBeEnabled()
    expect(resumeButton).toHaveAttribute('aria-busy', 'false')
  })

  test('cancelling the chosen message shows progress until the server resolves', async () => {
    let complete: () => void = () => undefined
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    render(
      <QueuedTurns
        turns={[
          queued,
          { ...queued, requestId: 'second', prompt: 'Review changes' },
        ]}
        onCancel={cancel}
      />
    )
    const cancelButton = screen.getByRole('button', {
      name: `Cancel queued message: ${queued.prompt}`,
    })
    await userEvent.click(cancelButton)
    expect(cancel).toHaveBeenCalledWith(queued.requestId)
    expect(cancelButton).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Cancelling queued message…'
    )
    expect(
      screen.getByRole('button', {
        name: 'Cancel queued message: Review changes',
      })
    ).toBeDisabled()
    await act(async () => {
      complete()
    })
    expect(cancelButton).toBeEnabled()
  })

  test('a failed operation stays beside its message and Retry repeats that operation', async () => {
    const resume = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(undefined)
    render(
      <QueuedTurns
        turns={[{ ...queued, status: 'paused' }]}
        onResume={resume}
      />
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: `Resume queued message: ${queued.prompt}`,
      })
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Connection lost')
    expect(screen.getByText(queued.prompt)).toBeVisible()
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
    expect(resume).toHaveBeenNthCalledWith(2, queued.requestId)
  })

  test('an entry already starting cannot be cancelled and an unsafe paused entry cannot be resumed', async () => {
    const cancel = vi.fn()
    const resume = vi.fn()
    render(
      <QueuedTurns
        turns={[
          { ...queued, status: 'starting' },
          {
            ...queued,
            requestId: 'paused-request',
            prompt: 'Check deployment',
            status: 'paused',
            canResume: false,
          },
        ]}
        onCancel={cancel}
        onResume={resume}
      />
    )
    const cancelStarting = screen.getByRole('button', {
      name: `Cancel queued message: ${queued.prompt}`,
    })
    const resumeUnsafe = screen.getByRole('button', {
      name: 'Resume queued message: Check deployment',
    })
    expect(cancelStarting).toBeDisabled()
    expect(resumeUnsafe).toBeDisabled()
    await userEvent.click(cancelStarting)
    await userEvent.click(resumeUnsafe)
    expect(cancel).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', {
        name: 'Cancel queued message: Check deployment',
      })
    ).toBeEnabled()
  })

  test('removing a failed entry does not leak its error into a different queue', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('Cannot cancel'))
    const { rerender } = render(
      <QueuedTurns turns={[queued]} onCancel={cancel} />
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: `Cancel queued message: ${queued.prompt}`,
      })
    )
    await screen.findByRole('alert')
    rerender(
      <QueuedTurns
        turns={[{ ...queued, requestId: 'other', prompt: 'Inspect logs' }]}
        onCancel={cancel}
      />
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Inspect logs')).toBeVisible()
  })

  test('a failed resume cannot be retried after the server marks the request unsafe to restart', async () => {
    const resume = vi.fn().mockRejectedValue(new Error('Connection lost'))
    const { rerender } = render(
      <QueuedTurns
        turns={[{ ...queued, status: 'paused' }]}
        onResume={resume}
      />
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: `Resume queued message: ${queued.prompt}`,
      })
    )
    await screen.findByRole('alert')
    rerender(
      <QueuedTurns
        turns={[{ ...queued, status: 'paused', canResume: false }]}
        onResume={resume}
      />
    )
    const retry = within(screen.getByRole('alert')).getByRole('button', {
      name: 'Retry',
    })
    expect(retry).toBeDisabled()
    await userEvent.click(retry)
    expect(resume).toHaveBeenCalledOnce()
  })
})
