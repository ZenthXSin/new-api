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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { SidebarTasks } from '../components/sidebar-tasks'
import type { CodexTask } from '../types'

const task: CodexTask = {
  id: 'project-1:task-1',
  workspaceId: 'project-1',
  conversationId: 'task-1',
  title: 'Fix checkout',
  workspaceName: 'Store',
  createdAt: 1,
  updatedAt: 2,
  status: 'idle',
  latestTurnStatus: 'completed',
  turnCount: 1,
  mode: 'code',
  model: 'codex',
  queuedCount: 0,
  approvalCount: 0,
  archived: false,
  workspaceArchived: false,
  conversationArchived: false,
  source: 'local',
}
const callbacks = () => ({
  loading: false,
  onRetry: vi.fn(),
  onSelect: vi.fn(),
  onRename: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
})

test('selecting a task keeps the workspace and conversation identity and highlights the exact selected task', async () => {
  const props = callbacks()
  render(
    <SidebarTasks
      {...props}
      tasks={[task]}
      workspaceId='project-1'
      conversationId='task-1'
    />
  )
  const entry = screen.getByRole('button', { name: 'Open task Fix checkout' })
  expect(entry).toHaveAttribute('aria-current', 'page')
  entry.focus()
  await userEvent.keyboard('{Enter}')
  expect(props.onSelect).toHaveBeenCalledWith('project-1', 'task-1')
})

test('a running task stays navigable while its destructive actions are unavailable', async () => {
  const props = callbacks()
  render(
    <SidebarTasks
      {...props}
      tasks={[{ ...task, status: 'running', latestTurnStatus: 'completed' }]}
    />
  )
  expect(screen.getByLabelText('Running')).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Open task Fix checkout' })
  )
  expect(props.onSelect).toHaveBeenCalledWith('project-1', 'task-1')
  await userEvent.click(
    screen.getByRole('button', { name: 'Task options for Fix checkout' })
  )
  expect(screen.getByRole('menuitem', { name: 'Delete task' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
})

test('selecting an archived task reveals its history automatically and restore uses the task identity', async () => {
  const props = callbacks()
  const archived = { ...task, archived: true, conversationArchived: true }
  render(
    <SidebarTasks
      {...props}
      tasks={[archived]}
      workspaceId='project-1'
      conversationId='task-1'
    />
  )
  expect(
    screen.getByRole('button', { name: 'Show archived tasks' })
  ).toHaveAttribute('aria-pressed', 'true')
  expect(
    screen.getByRole('button', { name: 'Open task Fix checkout' })
  ).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Task options for Fix checkout' })
  )
  await userEvent.click(screen.getByRole('menuitem', { name: 'Restore task' }))
  expect(props.onArchive).toHaveBeenCalledWith(archived)
})

test('task loading failures expose retry and pending pagination prevents duplicate loads', async () => {
  const props = callbacks()
  const { rerender } = render(
    <SidebarTasks {...props} tasks={[]} error='Task history unavailable' />
  )
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Task history unavailable'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(props.onRetry).toHaveBeenCalledOnce()
  const onLoadMore = vi.fn()
  rerender(
    <SidebarTasks
      {...props}
      tasks={[task]}
      hasMore
      loadingMore
      onLoadMore={onLoadMore}
    />
  )
  expect(
    screen.getByRole('button', { name: 'Loading tasks...' })
  ).toBeDisabled()
  await userEvent.click(
    screen.getByRole('button', { name: 'Loading tasks...' })
  )
  expect(onLoadMore).not.toHaveBeenCalled()
})
