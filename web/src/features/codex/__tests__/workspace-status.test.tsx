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
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Codex } from '..'
import { detail, environment, status } from './fixtures'

const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
const warning =
  'Project history could not be saved. Export important files and retry after storage is available.'
function renderWorkspace(
  persistenceError = false,
  workspaceId: string | undefined = 'project-1'
) {
  let saved = !persistenceError
  const data = detail()
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/status')) return response(status)
    if (url.endsWith('/environment')) return response({ environment })
    if (url.endsWith('/workspaces')) {
      return response({ workspaces: [data.workspace] })
    }
    if (url.endsWith('/events')) {
      return response({
        events: [],
        nextCursor: 0,
        workspace: data.workspace,
        pendingApprovals: [],
        persistenceError: !saved,
      })
    }
    if (url.endsWith('/diff')) {
      return response({ diff: '', files: [], truncated: false })
    }
    return response({ ...data, persistenceError: !saved })
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Codex workspaceId={workspaceId} onSelect={vi.fn()} onBack={vi.fn()} />
    </QueryClientProvider>
  )
  return {
    restore: () => {
      saved = true
    },
    client,
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})
describe('Codex project persistence and mobile controls', () => {
  test('wide screens expose keyboard-accessible resizing between conversation and project review', async () => {
    const original = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: query === '(min-width: 1024px)',
    }))
    renderWorkspace()
    await screen.findByText('Saved project')
    await userEvent.click(
      screen.getByRole('button', { name: 'Review changes' })
    )
    const separator = await screen.findByRole('separator', {
      name: 'Resize conversation and project panels',
    })
    expect(separator).toHaveAttribute('tabindex', '0')
    expect(
      screen.getByRole('textbox', { name: 'Describe your coding task' })
    ).toBeVisible()
    expect(
      screen.getByRole('region', { name: 'Project inspector' })
    ).toBeVisible()
  })
  test('the repository import entry opens Git import immediately and a normal project starts blank', async () => {
    renderWorkspace(false, '')
    const importButton = await screen.findByRole('button', {
      name: 'Import a repository',
    })
    await waitFor(() => expect(importButton).toBeEnabled())
    await userEvent.click(importButton)
    expect(
      await screen.findByRole('textbox', { name: 'Repository URL' })
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(
      screen.queryByRole('textbox', { name: 'Repository URL' })
    ).not.toBeInTheDocument()
  })
  test('project actions support arrow navigation and Escape returns focus to their trigger', async () => {
    renderWorkspace()
    await screen.findByText('Saved project')
    const trigger = screen.getByRole('button', { name: 'Project actions' })
    await userEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Rename project' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'Import ZIP' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })
  test('failed cloud saves warn visibly and never label the project as saved', async () => {
    renderWorkspace(true)
    expect(await screen.findByText(warning)).toBeVisible()
    expect(screen.getByText('Project not saved')).toBeVisible()
    expect(screen.queryByText('Saved project')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })
  test('retrying after storage recovery removes the warning and restores saved status', async () => {
    const app = renderWorkspace(true)
    await screen.findByText(warning)
    app.restore()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.queryByText(warning)).not.toBeInTheDocument()
    )
    expect(screen.getByText('Saved project')).toBeVisible()
  })
  test('header icon buttons keep explicit accessible names and open their controls', async () => {
    renderWorkspace()
    await screen.findByText('Saved project')
    const create = screen.getByRole('button', { name: 'New project' })
    const review = screen.getByRole('button', { name: 'Review changes' })
    expect(create).toHaveAttribute('aria-label', 'New project')
    expect(review).toHaveAttribute('aria-label', 'Review changes')
    await userEvent.click(create)
    expect(await screen.findByRole('dialog')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(review)
    expect(
      await screen.findByRole('region', { name: 'Project inspector' })
    ).toBeVisible()
  })
})
