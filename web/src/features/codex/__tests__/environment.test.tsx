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
import type { CodexEnvironment } from '../types'
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
function renderEnvironment(initial: CodexEnvironment | Error) {
  let current = initial
  const data = detail()
  const requests = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/status')) return response(status)
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
    return response({ environment: current })
  })
  const onSelect = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Codex workspaceId='project-1' onSelect={onSelect} onBack={vi.fn()} />
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

describe('Personal environment controls', () => {
  test('environment details stay out of the workspace until opened and Escape returns focus to the trigger', async () => {
    render(<EnvironmentPanel {...panelProps} environment={environment} />)
    const trigger = screen.getByRole('button', {
      name: 'Personal environment details',
    })
    expect(screen.queryByText('Storage limit')).not.toBeInTheDocument()
    await userEvent.click(trigger)
    expect(await screen.findByText('Storage limit')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    )
    expect(trigger).toHaveFocus()
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Personal environment details' })
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
    const details = screen.getByRole('button', {
      name: 'Personal environment details',
    })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText(
        'One personal environment shared by all your projects. Each project keeps its own files and conversation.'
      )
    ).toBeVisible()
    expect(screen.getByText('2 GiB')).toBeVisible()
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Personal environment details' })
    )
    expect(
      screen.getByRole('button', { name: 'Stop environment' })
    ).toBeDisabled()
    expect(
      screen.getByText('Stop the active task before stopping your environment.')
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /API service/ }))
    expect(onSelect).toHaveBeenCalledWith('project-2')
    expect(onStop).not.toHaveBeenCalled()
  })
  test('loading and starting prevent duplicate environment actions and errors offer retry', async () => {
    const onRetry = vi.fn()
    const view = render(
      <EnvironmentPanel {...panelProps} loading unavailable onRetry={onRetry} />
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Personal environment details' })
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
  test('manual start and stop call only environment endpoints and keep project history', async () => {
    const app = renderEnvironment(environment)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal environment details' })
      ).toHaveAttribute('title', 'Environment sleeping')
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Personal environment details' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Start environment' })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal environment details' })
      ).toHaveAttribute('title', 'Environment running')
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop environment' })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal environment details' })
      ).toHaveAttribute('title', 'Environment sleeping')
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
      screen.getByRole('heading', { name: 'Website project' })
    ).toBeVisible()
  })
  test('another active project blocks sending and mutations while preserving the draft and file browsing', async () => {
    const app = renderEnvironment({
      ...environment,
      status: 'running',
      activeWorkspaceId: 'project-2',
      activeWorkspaceName: 'API service',
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal environment details' })
      ).toHaveAttribute('title', 'Environment running')
    )
    const textbox = screen.getByRole('textbox', {
      name: 'Describe your coding task',
    })
    fireEvent.change(textbox, { target: { value: 'Keep this task for later' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New project' })).toBeDisabled()
    expect(textbox).toHaveValue('Keep this task for later')
    expect(
      screen.getByText(
        'Another project is using your environment. Finish or stop its task before starting a new one.'
      )
    ).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Project actions' })
    )
    expect(
      screen.getByRole('button', { name: 'Delete project' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import ZIP' })).toBeDisabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Close project actions' })
    )
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
    await userEvent.click(
      screen.getByRole('button', { name: 'Open active project' })
    )
    expect(app.onSelect).toHaveBeenCalledWith('project-2')
    expect(app.post).not.toHaveBeenCalled()
  })
  test('an unavailable environment blocks a task until retry succeeds without clearing the draft', async () => {
    const app = renderEnvironment(new Error('Connection lost'))
    const textbox = await screen.findByRole('textbox', {
      name: 'Describe your coding task',
    })
    fireEvent.change(textbox, { target: { value: 'Preserved draft' } })
    await userEvent.click(
      screen.getByRole('button', { name: 'Personal environment details' })
    )
    await screen.findByRole(
      'button',
      { name: 'Retry environment' },
      { timeout: 3000 }
    )
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
    app.recover()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry environment' })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal environment details' })
      ).toHaveAttribute('title', 'Environment sleeping')
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled()
    expect(textbox).toHaveValue('Preserved draft')
  })
  test('project deletion explains that the personal environment and other projects remain', async () => {
    renderEnvironment(environment)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Personal environment details' })
      ).toHaveAttribute('title', 'Environment sleeping')
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Project actions' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete project' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        'This permanently deletes this project, its files, and its conversation. Your personal environment and other projects are kept. Export anything you want to keep first.'
      )
    ).toBeVisible()
  })
})
