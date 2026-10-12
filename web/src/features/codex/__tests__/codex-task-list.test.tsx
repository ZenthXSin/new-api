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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodexTaskList } from '../components/codex-task-list'
import type { CodexTask } from '../types'

const ready: CodexTask = {
  id: 'conversation:website:homepage',
  workspaceId: 'website',
  conversationId: 'homepage',
  title: 'Build the homepage',
  workspaceName: 'Website',
  createdAt: 1,
  updatedAt: 1000,
  status: 'idle',
  latestTurnStatus: null,
  turnCount: 0,
  mode: 'code',
  model: 'codex-test',
  queuedCount: 0,
  approvalCount: 0,
  archived: false,
  workspaceArchived: false,
  conversationArchived: false,
  source: 'local',
}
const done: CodexTask = {
  ...ready,
  id: 'conversation:api:routes',
  workspaceId: 'api',
  conversationId: 'routes',
  title: 'Review API routes',
  workspaceName: 'API',
  repository: 'acme/backend',
  updatedAt: 2000,
  latestTurnStatus: 'completed',
  turnCount: 1,
}
const archived: CodexTask = {
  ...ready,
  id: 'conversation:website:old',
  conversationId: 'old',
  title: 'Update old navigation',
  updatedAt: 3000,
  archived: true,
  conversationArchived: true,
}

function listProps() {
  return {
    tasks: [ready, done, archived],
    loading: false,
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
  }
}

describe('Codex homepage task list', () => {
  test('active tasks sort newest first and distinguish a completed turn from an idle task that never ran', () => {
    render(<CodexTaskList {...listProps()} />)
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    const rows = within(
      screen.getByRole('list', { name: 'Tasks' })
    ).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Review API routes')
    expect(rows[0]).toHaveTextContent('acme/backend')
    expect(rows[0]).toHaveTextContent('Completed')
    expect(rows[1]).toHaveTextContent('Website')
    expect(rows[1]).toHaveTextContent('Ready')
    expect(screen.queryByText('Update old navigation')).not.toBeInTheDocument()
  })

  test('keyboard tab navigation switches to archived tasks and exposes the matching panel', async () => {
    render(<CodexTaskList {...listProps()} />)
    screen.getByRole('tab', { name: 'Tasks' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Archive' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Archive')
    expect(
      screen.getByRole('button', { name: 'Open task Update old navigation' })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Open task Review API routes' })
    ).not.toBeInTheDocument()
  })

  test('typing filters task titles immediately and clearing restores only the current tab', async () => {
    render(<CodexTaskList {...listProps()} />)
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search tasks' }),
      ' HOMEPAGE '
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('listitem')).toHaveTextContent('Build the homepage')
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear task search' })
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('Update old navigation')).not.toBeInTheDocument()
  })

  test('title filtering does not fabricate a message or project-name match and Enter forwards the query to full search', async () => {
    const onSearch = vi.fn()
    render(<CodexTaskList {...listProps()} onSearch={onSearch} />)
    await userEvent.type(screen.getByRole('searchbox'), 'acme/backend')
    expect(screen.getByRole('status')).toHaveTextContent('No matching tasks.')
    await userEvent.keyboard('{Enter}')
    expect(onSearch).toHaveBeenCalledWith('acme/backend')
    await userEvent.click(
      screen.getByRole('button', { name: 'Search all task messages' })
    )
    expect(onSearch).toHaveBeenCalledTimes(2)
  })

  test('opening a task passes its workspace and conversation rather than the current workspace', async () => {
    const props = listProps()
    render(<CodexTaskList {...props} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Open task Review API routes' })
    )
    expect(props.onSelect).toHaveBeenCalledWith('api', 'routes')
  })

  test('rename archive and delete menus pass the exact task without opening it', async () => {
    const props = listProps()
    render(<CodexTaskList {...props} />)
    const trigger = screen.getByRole('button', {
      name: 'Task actions for Review API routes',
    })
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename task' }))
    expect(props.onRename).toHaveBeenCalledWith(done)
    await userEvent.click(trigger)
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Archive task' })
    )
    expect(props.onArchive).toHaveBeenCalledWith(done)
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete task' }))
    expect(props.onDelete).toHaveBeenCalledWith(done)
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  test('an archived conversation offers restore while an archived project explains why task changes are disabled', async () => {
    const props = listProps()
    const { rerender } = render(<CodexTaskList {...props} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Archive' }))
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Task actions for Update old navigation',
      })
    )
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Restore task' })
    )
    expect(props.onArchive).toHaveBeenCalledWith(archived)
    rerender(
      <CodexTaskList
        {...props}
        tasks={[{ ...archived, workspaceArchived: true }]}
      />
    )
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Task actions for Update old navigation',
      })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Restore task' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('menuitem', { name: 'Delete task' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText('Restore the project to manage this task.')
    ).toBeVisible()
  })

  test('running tasks cannot be archived or deleted and Escape returns focus to their action menu', async () => {
    const props = listProps()
    render(
      <CodexTaskList {...props} tasks={[{ ...ready, status: 'running' }]} />
    )
    expect(screen.getByText('Running')).toBeVisible()
    const trigger = screen.getByRole('button', {
      name: 'Task actions for Build the homepage',
    })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(
      screen.getByRole('menuitem', { name: 'Archive task' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('menuitem', { name: 'Delete task' })
    ).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  test.each([
    {
      changes: { status: 'waiting_approval', approvalCount: 1 },
      label: 'Waiting for approval',
    },
    { changes: { status: 'starting' }, label: 'Starting' },
    { changes: { status: 'error' }, label: 'Failed' },
    { changes: { latestTurnStatus: 'failed' }, label: 'Failed' },
    { changes: { status: 'interrupted' }, label: 'Interrupted' },
    { changes: { queuedCount: 1 }, label: 'Queued' },
  ] as { changes: Partial<CodexTask>; label: string }[])(
    'task state $label reflects the API rather than a fabricated completion badge',
    ({ changes, label }) => {
      render(
        <CodexTaskList {...listProps()} tasks={[{ ...ready, ...changes }]} />
      )
      expect(screen.getByRole('listitem')).toHaveTextContent(label)
      expect(screen.queryByText('Completed')).not.toBeInTheDocument()
    }
  )

  test('loading retains existing task rows and errors expose a retry action without a false empty state', async () => {
    const props = listProps()
    const { rerender } = render(<CodexTaskList {...props} loading />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading tasks...')
    expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    rerender(
      <CodexTaskList
        {...props}
        tasks={[]}
        error='Tasks are temporarily unavailable.'
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Tasks are temporarily unavailable.'
    )
    expect(screen.queryByText('No tasks yet.')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })

  test('empty active and archive tabs use distinct states', async () => {
    render(<CodexTaskList {...listProps()} tasks={[]} />)
    expect(screen.getByRole('status')).toHaveTextContent('No tasks yet.')
    await userEvent.click(screen.getByRole('tab', { name: 'Archive' }))
    expect(screen.getByRole('status')).toHaveTextContent('No archived tasks.')
  })

  test('paginated task lists expose a working load-more action and prevent duplicate requests while it is pending', async () => {
    const props = listProps()
    const onLoadMore = vi.fn()
    const { rerender } = render(
      <CodexTaskList {...props} hasMore onLoadMore={onLoadMore} />
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Load more tasks' })
    )
    expect(onLoadMore).toHaveBeenCalledOnce()
    rerender(
      <CodexTaskList {...props} hasMore loadingMore onLoadMore={onLoadMore} />
    )
    expect(
      screen.getByRole('button', { name: 'Loading tasks...' })
    ).toBeDisabled()
    rerender(
      <CodexTaskList {...props} hasMore={false} onLoadMore={onLoadMore} />
    )
    expect(
      screen.queryByRole('button', { name: 'Load more tasks' })
    ).not.toBeInTheDocument()
  })

  test('title filtering explains the available older tasks instead of implying all titles have been searched', async () => {
    render(<CodexTaskList {...listProps()} hasMore onLoadMore={vi.fn()} />)
    await userEvent.type(screen.getByRole('searchbox'), 'older task')
    expect(
      screen.getByText(
        'More tasks are available. Load more to search older titles.'
      )
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Load more tasks' })
    ).toBeEnabled()
  })

  test('disabled mutations do not prevent opening a task and invalid timestamps do not render an invalid date', async () => {
    const props = listProps()
    const longTitle = 'A very long task title '.repeat(20)
    render(
      <CodexTaskList
        {...props}
        disabled
        tasks={[{ ...ready, title: longTitle, updatedAt: Number.NaN }]}
      />
    )
    await userEvent.click(
      screen.getByRole('button', { name: `Open task ${longTitle}`.trim() })
    )
    expect(props.onSelect).toHaveBeenCalledWith('website', 'homepage')
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', {
        name: `Task actions for ${longTitle}`.trim(),
      })
    )
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('aria-disabled', 'true')
    }
  })
})
