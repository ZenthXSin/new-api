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
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Codex } from '..'
import { EnvironmentPanel } from '../components/environment-panel'
import type { CodexEnvironment, CodexTurnInput } from '../types'
import { detail, environment, status } from './fixtures'

const panelProps = {
  loading: false,
  unavailable: false,
  pending: null,
  onStart: vi.fn(),
  onStop: vi.fn(),
  onRetry: vi.fn(),
  onSelect: vi.fn(),
}
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
async function renderEnvironment(initial: CodexEnvironment | Error) {
  const matchMedia = window.matchMedia
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...matchMedia(query),
    matches: query === '(min-width: 768px)',
  }))
  let current = initial
  const data = detail()
  const requests = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/status')) return response(status)
    if (url.endsWith('/tasks')) {
      return response({ tasks: [], total: 0, hasMore: false, nextOffset: null })
    }
    if (url.endsWith('/environments')) return response({ environments: [] })
    if (url.endsWith('/repository')) {
      return response({
        repository: {
          available: false,
          branch: null,
          head: null,
          detached: false,
          dirty: false,
          checkoutSupported: false,
          checkoutReason: 'not_repository',
          hasSubmodules: false,
          remotes: [],
          branches: [],
          branchesTruncated: false,
        },
      })
    }
    if (url.endsWith('/conversations')) return response({ conversations: [] })
    if (url.endsWith('/environment')) {
      if (current instanceof Error) throw current
      return response({ environment: current })
    }
    if (url.endsWith('/workspaces')) {
      return response({ workspaces: [data.workspace] })
    }
    if (url.endsWith('/events')) return response({ ...data, events: [] })
    if (url.endsWith('/files')) return response({ path: '', entries: [] })
    if (url.endsWith('/diff')) return response({ diff: '', files: [] })
    return response(data)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url.endsWith('/environment/start')) {
      current = { ...environment, status: 'running' }
    }
    if (url.endsWith('/environment/stop')) {
      current = { ...environment, status: 'stopped' }
    }
    if (url.endsWith('/turns')) return response(data)
    return response({ environment: current })
  })
  const onSelect = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => (
      <Codex workspaceId='project-1' onSelect={onSelect} onBack={vi.fn()} />
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/codex'] }),
    defaultPendingMinMs: 0,
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return {
    requests,
    post,
    onSelect,
    client,
    recover: () => {
      current = environment
    },
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

async function openEnvironmentSettings() {
  const triggers = await screen.findAllByRole('button', { name: 'Settings' })
  await userEvent.click(triggers[0])
  await userEvent.click(await screen.findByRole('tab', { name: 'Docker' }))
  return screen.getByRole('region', { name: 'Personal environment' })
}

describe('Personal environment controls', () => {
  test('environment details open from settings and Escape restores the workspace', async () => {
    await renderEnvironment(environment)
    expect(
      screen.queryByRole('region', { name: 'Personal environment' })
    ).not.toBeInTheDocument()
    const trigger = (
      await screen.findAllByRole('button', { name: 'Settings' })
    )[0]
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('tab', { name: 'Docker' }))
    expect(await screen.findByText('Storage limit')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Settings' })
      ).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
    expect(
      screen.getByRole('textbox', { name: 'Describe your coding task' })
    ).toBeVisible()
  })
  test('an idle environment error allows stopping the container to recover without deleting projects', async () => {
    const onStop = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          status: 'error',
          lastError: 'A process could not be stopped',
        }}
        onStop={onStop}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Environment error')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A process could not be stopped'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop environment' })
    )
    expect(onStop).toHaveBeenCalledOnce()
  })
  test('details explain one shared environment, persistent projects and actual resource limits', async () => {
    render(<EnvironmentPanel {...panelProps} environment={environment} />)
    expect(
      screen.getByText(
        'One personal environment shared by all your projects. Each project keeps its own files and conversation.'
      )
    ).toBeVisible()
    expect(screen.getByText('2,048 MB')).toBeVisible()
    expect(screen.getByText('5% · 2 vCPU')).toBeVisible()
    expect(screen.getByText('10 GiB')).toBeVisible()
    expect(
      screen.getByText(
        'Starting the environment does not send a model request. Sending a task wakes it automatically.'
      )
    ).toBeVisible()
  })
  test('an active project blocks environment stop and its name opens that project', async () => {
    const onSelect = vi.fn()
    const onStop = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          status: 'running',
          activeWorkspaceId: 'project-2',
          activeWorkspaceName: 'API service',
        }}
        onSelect={onSelect}
        onStop={onStop}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Stop environment' })
    ).toBeDisabled()
    expect(
      screen.getByText('Stop the active task before stopping your environment.')
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /API service/ }))
    expect(onSelect).toHaveBeenCalledWith('project-2', undefined)
    expect(onStop).not.toHaveBeenCalled()
  })
  test('loading and starting prevent duplicate environment actions and errors offer retry', async () => {
    const onRetry = vi.fn()
    const view = render(
      <EnvironmentPanel {...panelProps} loading unavailable onRetry={onRetry} />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading environment...'
    )
    expect(
      screen.getByRole('button', { name: 'Start environment' })
    ).toBeDisabled()
    view.rerender(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, status: 'starting' }}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Starting environment')
    expect(
      screen.getByRole('button', { name: 'Start environment' })
    ).toBeDisabled()
    view.rerender(
      <EnvironmentPanel
        {...panelProps}
        unavailable
        error='Connection lost'
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost')
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry environment' })
    )
    expect(onRetry).toHaveBeenCalledOnce()
  })
  test('creating and stopping an environment call only environment endpoints and keep project history', async () => {
    const app = await renderEnvironment({
      ...environment,
      status: 'not_created',
    })
    const environmentRegion = await openEnvironmentSettings()
    await waitFor(() =>
      expect(within(environmentRegion).getByRole('status')).toHaveTextContent(
        'Environment not created'
      )
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create and start environment' })
    )
    await waitFor(() =>
      expect(within(environmentRegion).getByRole('status')).toHaveTextContent(
        'Environment running'
      )
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop environment' })
    )
    await waitFor(() =>
      expect(within(environmentRegion).getByRole('status')).toHaveTextContent(
        'Environment sleeping'
      )
    )
    expect(app.post.mock.calls.map(([url]) => url)).toEqual([
      '/api/codex/environment/start',
      '/api/codex/environment/stop',
    ])
    expect(
      app.post.mock.calls.every(
        ([, body]) => Object.keys(body ?? {}).length === 0
      )
    ).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(
      screen.getByRole('textbox', { name: 'Describe your coding task' })
    ).toBeVisible()
  })
  test('another active project allows a parallel task and new projects while keeping file mutations blocked', async () => {
    const app = await renderEnvironment({
      ...environment,
      status: 'running',
      activeWorkspaceId: 'project-2',
      activeWorkspaceName: 'API service',
    })
    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Describe your coding task' })
      ).toBeVisible()
    )
    const textbox = screen.getByRole('textbox', {
      name: 'Describe your coding task',
    })
    fireEvent.change(textbox, { target: { value: 'Keep this task for later' } })
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled()
    expect(textbox).toHaveValue('Keep this task for later')
    expect(
      screen.queryByText(
        'Another conversation is running. You can queue this message or interrupt the active task.'
      )
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Project actions' })
    )
    expect(
      screen.getByRole('menuitem', { name: 'Delete project' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('menuitem', { name: 'Import ZIP' })
    ).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(
      screen.getByRole('button', { name: 'Review changes' })
    )
    expect(
      await screen.findByText(
        'Changes will be available when your environment is ready and no other project or read-only task is running.'
      )
    ).toBeVisible()
    expect(app.requests.mock.calls.some(([url]) => url.endsWith('/diff'))).toBe(
      false
    )
    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))
    await waitFor(() =>
      expect(
        app.requests.mock.calls.some(([url]) => url.endsWith('/files'))
      ).toBe(true)
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Close project inspector' })
    )
    expect(
      screen.queryByRole('button', { name: 'Open active project' })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() =>
      expect(app.post).toHaveBeenCalledWith(
        '/api/codex/workspaces/project-1/turns',
        expect.objectContaining({
          prompt: 'Keep this task for later',
        }),
        expect.anything()
      )
    )
    const submitted = app.post.mock.calls.find(([url]) =>
      url.endsWith('/turns')
    )?.[1] as CodexTurnInput
    expect(submitted.busyAction).toBeUndefined()
  })
  test('an unavailable environment blocks a task until retry succeeds without clearing the draft', async () => {
    const app = await renderEnvironment(new Error('Connection lost'))
    const textbox = await screen.findByRole('textbox', {
      name: 'Describe your coding task',
    })
    fireEvent.change(textbox, { target: { value: 'Preserved draft' } })
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
    const environmentRegion = await openEnvironmentSettings()
    await screen.findByRole(
      'button',
      { name: 'Retry environment' },
      { timeout: 3000 }
    )
    app.recover()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry environment' })
    )
    await waitFor(() =>
      expect(within(environmentRegion).getByRole('status')).toHaveTextContent(
        'Environment sleeping'
      )
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled()
    expect(textbox).toHaveValue('Preserved draft')
  })
  test('project deletion explains that the personal environment and other projects remain', async () => {
    await renderEnvironment(environment)
    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Describe your coding task' })
      ).toBeVisible()
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Project actions' })
    )
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Delete project' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        'This permanently deletes this project, its files, and all its conversations. Your personal environment and other projects are kept. Export anything you want to keep first.'
      )
    ).toBeVisible()
  })
})
