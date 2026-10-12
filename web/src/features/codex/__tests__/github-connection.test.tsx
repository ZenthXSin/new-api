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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { GitHubConnection } from '../components/github-connection'
import type { CodexGitHubStatus } from '../types'

const disconnected: CodexGitHubStatus = {
  configured: true,
  connected: false,
  capabilities: ['repositories', 'issues', 'pull_requests', 'workflows'],
  scopes: ['repo', 'workflow'],
}
const connected: CodexGitHubStatus = {
  ...disconnected,
  connected: true,
  login: 'octocat',
}
const response = (data: unknown): AxiosResponse =>
  ({ data: { success: true, data } }) as AxiosResponse
const originalLocation = window.location
const assign = vi.fn()
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, assign },
  })
})
afterEach(() => {
  client.clear()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  })
  vi.restoreAllMocks()
})

function renderConnection(actor = '1', onChanged = vi.fn()) {
  return {
    onChanged,
    ...render(
      <QueryClientProvider client={client}>
        <GitHubConnection actor={actor} onChanged={onChanged} />
      </QueryClientProvider>
    ),
  }
}

describe('GitHub connection', () => {
  test('configuration is unavailable while loading and an unconfigured site explains why authorization is disabled', async () => {
    let resolveStatus: (value: AxiosResponse) => void = () => undefined
    vi.spyOn(api, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        })
    )
    renderConnection()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading GitHub connection...'
    )
    expect(
      screen.queryByRole('button', { name: 'Connect GitHub' })
    ).not.toBeInTheDocument()

    await act(async () =>
      resolveStatus(
        response({
          ...disconnected,
          configured: false,
          reason: 'Configure the GitHub OAuth application first.',
        })
      )
    )

    expect(
      await screen.findByRole('button', { name: 'Connect GitHub' })
    ).toBeDisabled()
    expect(
      screen.getByText('Configure the GitHub OAuth application first.')
    ).toBeVisible()
  })

  test('a failed status request can be retried before connecting', async () => {
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(new Error('GitHub connection unavailable'))
      .mockResolvedValue(response(disconnected))
    renderConnection()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub connection unavailable'
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Retry GitHub connection' })
    )

    expect(
      await screen.findByRole('button', { name: 'Connect GitHub' })
    ).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('connecting opens the verified GitHub authorization page and prevents duplicate submissions', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response(disconnected))
    let resolveAuthorization: (value: AxiosResponse) => void = () => undefined
    const post = vi.spyOn(api, 'post').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuthorization = resolve
        })
    )
    renderConnection()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect GitHub' })
    )
    expect(
      screen.getByRole('button', { name: 'Opening GitHub...' })
    ).toBeDisabled()

    const url =
      'https://github.com/login/oauth/authorize?client_id=app&state=single-use-state'
    await act(async () => resolveAuthorization(response({ url })))

    await waitFor(() => expect(assign).toHaveBeenCalledWith(url))
    expect(post).toHaveBeenCalledWith(
      '/api/codex/github/authorize',
      {},
      expect.any(Object)
    )
    expect(post).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: 'Opening GitHub...' })
    ).toBeDisabled()
  })

  test('a rejected authorization request stays on the page and allows retry', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response(disconnected))
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce({
        data: {
          success: false,
          message: 'Authorization temporarily unavailable',
        },
      })
      .mockResolvedValue(
        response({
          url: 'https://github.com/login/oauth/authorize?state=new-state',
        })
      )
    renderConnection()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect GitHub' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Authorization temporarily unavailable'
    )
    expect(assign).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Connect GitHub' })
    )

    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(post).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test.each([
    'https://github.com.evil.example/login/oauth/authorize',
    'javascript:alert(1)',
    'https://user:password@github.com/login/oauth/authorize',
  ])(
    'an authorization URL outside the GitHub OAuth boundary is rejected: %s',
    async (url) => {
      vi.spyOn(api, 'get').mockResolvedValue(response(disconnected))
      vi.spyOn(api, 'post').mockResolvedValue(response({ url }))
      renderConnection()
      await userEvent.click(
        await screen.findByRole('button', { name: 'Connect GitHub' })
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'GitHub returned an invalid authorization link. Please try again.'
      )
      expect(assign).not.toHaveBeenCalled()
      expect(
        screen.getByRole('button', { name: 'Connect GitHub' })
      ).toBeEnabled()
    }
  )

  test('a connected account shows its granted capabilities and only disconnects after explicit confirmation', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(response(connected))
    const remove = vi.spyOn(api, 'delete').mockResolvedValue(response({}))
    const app = renderConnection()
    expect(await screen.findByText('@octocat')).toBeVisible()
    const permissions = screen.getByRole('list', { name: 'GitHub permissions' })
    expect(
      within(permissions).getByText('Read and write repositories and commits')
    ).toBeVisible()
    expect(
      within(permissions).getByText('Create and update pull requests')
    ).toBeVisible()
    await userEvent.click(screen.getByText('Granted GitHub scopes'))
    expect(screen.getByText('repo, workflow')).toBeVisible()

    await userEvent.click(
      screen.getByRole('button', { name: 'Disconnect GitHub' })
    )
    expect(remove).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', {
      name: 'Disconnect GitHub?',
    })
    expect(
      within(dialog).getByText(
        'Codex will lose access through this connection. Your repositories, project files, and conversations will be kept.'
      )
    ).toBeVisible()
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' })
    )
    expect(remove).not.toHaveBeenCalled()

    await userEvent.click(
      screen.getByRole('button', { name: 'Disconnect GitHub' })
    )
    get.mockResolvedValue(response(disconnected))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Confirm disconnect',
      })
    )

    expect(
      await screen.findByRole('button', { name: 'Connect GitHub' })
    ).toBeEnabled()
    expect(screen.queryByText('@octocat')).not.toBeInTheDocument()
    expect(remove).toHaveBeenCalledWith('/api/codex/github', expect.any(Object))
    expect(remove).toHaveBeenCalledOnce()
    await waitFor(() => expect(app.onChanged).toHaveBeenCalledOnce())
  })

  test('a disconnect failure preserves the connected account and keeps the confirmation open for retry', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response(connected))
    const remove = vi
      .spyOn(api, 'delete')
      .mockRejectedValue(new Error('GitHub could not be disconnected'))
    const app = renderConnection()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect GitHub' })
    )
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Confirm disconnect' })
    )

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'GitHub could not be disconnected'
    )
    expect(
      within(dialog).getByRole('button', { name: 'Confirm disconnect' })
    ).toBeEnabled()
    expect(screen.getByText('@octocat')).toBeInTheDocument()
    expect(remove).toHaveBeenCalledOnce()
    expect(app.onChanged).not.toHaveBeenCalled()
  })

  test('switching the site account hides the previous account connection without reusing its cached identity', async () => {
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(response(connected))
      .mockResolvedValue(
        response({ ...disconnected, capabilities: [], scopes: [] })
      )
    const app = renderConnection()
    expect(await screen.findByText('@octocat')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Disconnect GitHub' })
    )
    await screen.findByRole('dialog')

    app.rerender(
      <QueryClientProvider client={client}>
        <GitHubConnection actor='2' />
      </QueryClientProvider>
    )

    expect(screen.queryByText('@octocat')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Connect GitHub' })
    ).toBeEnabled()
    expect(
      screen.queryByRole('list', { name: 'GitHub permissions' })
    ).not.toBeInTheDocument()
  })
})
