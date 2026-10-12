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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { codexApi } from '../api'
import { BulkManagement } from '../components/bulk-management'
import { detail, workspace } from './fixtures'

const projects = [
  workspace,
  { ...workspace, id: 'project-2', name: 'API project' },
  {
    ...workspace,
    id: 'busy',
    name: 'Running project',
    status: 'running' as const,
  },
]
beforeEach(() => {
  vi.spyOn(codexApi, 'conversations').mockResolvedValue({
    conversations: [
      {
        id: 'conversation-1',
        name: 'Review code',
        status: 'idle',
        createdAt: 1,
        updatedAt: 2,
        turnCount: 1,
      },
    ],
  })
})
function renderManager(onComplete = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <BulkManagement
        actor='fixture'
        workspaces={projects}
        onComplete={onComplete}
      />
    </QueryClientProvider>
  )
}
test('select all archives eligible projects and leaves running projects untouched', async () => {
  const update = vi.spyOn(codexApi, 'update').mockResolvedValue({ workspace })
  renderManager()
  expect(
    screen.getByRole('checkbox', { name: 'Select Running project' })
  ).toBeDisabled()
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all visible items' })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Archive selected' })
  )
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  expect(update).toHaveBeenCalledWith('project-1', { archived: true })
  expect(update).toHaveBeenCalledWith('project-2', { archived: true })
  expect(update).not.toHaveBeenCalledWith('busy', expect.anything())
})
test('a partial project failure keeps only failed items selected for retry', async () => {
  vi.spyOn(codexApi, 'update').mockImplementation(async (id) => {
    if (id === 'project-2') throw new Error('Storage unavailable')
    return { workspace }
  })
  renderManager()
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all visible items' })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Archive selected' })
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('API project')
  expect(
    screen.getByRole('checkbox', { name: 'Select API project' })
  ).toBeChecked()
  expect(
    screen.getByRole('checkbox', { name: 'Select Website project' })
  ).not.toBeChecked()
})
test('bulk conversation deletion requires confirmation and uses the correct project for every conversation', async () => {
  const remove = vi.spyOn(codexApi, 'deleteConversation').mockResolvedValue({
    deleted: true,
    conversationId: 'replacement',
    workspace,
    conversations: [],
  })
  const completed = vi.fn()
  renderManager(completed)
  await userEvent.click(screen.getByRole('button', { name: 'Conversations' }))
  await screen.findByRole('checkbox', {
    name: 'Select Website project / Review code',
  })
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all visible items' })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
  expect(remove).not.toHaveBeenCalled()
  await userEvent.click(
    screen.getByRole('button', { name: 'Confirm deletion' })
  )
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
  expect(remove).toHaveBeenCalledWith('project-1', 'conversation-1')
  expect(remove).toHaveBeenCalledWith('project-2', 'conversation-1')
  expect(completed).toHaveBeenCalledWith(
    expect.objectContaining({
      deletedConversations: expect.arrayContaining([
        {
          workspaceId: 'project-1',
          conversationId: 'conversation-1',
          replacementId: 'replacement',
        },
      ]),
    })
  )
})
test('filtering by a name limits select all and changing sections clears selection', async () => {
  vi.spyOn(codexApi, 'updateConversation').mockResolvedValue(detail())
  renderManager()
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Filter items' }),
    'API'
  )
  await userEvent.click(
    screen.getByRole('checkbox', { name: 'Select all visible items' })
  )
  expect(
    screen.queryByRole('checkbox', { name: 'Select Website project' })
  ).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Conversations' }))
  expect(
    screen.getByRole('button', { name: 'Archive selected' })
  ).toBeDisabled()
})
