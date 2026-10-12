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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { GitActionsPanel } from '../components/git-actions-panel'
import type { CodexGitStatus } from '../git-types'

const clients: QueryClient[] = []
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
const gitStatus: CodexGitStatus = {
  available: true,
  branch: 'codex/fix',
  head: 'abc123456789',
  statusVersion: 'review-version',
  dirty: true,
  detached: false,
  files: [
    { path: 'src/app.ts', indexStatus: ' ', worktreeStatus: 'M', status: 'M' },
    { path: 'docs.md', indexStatus: '?', worktreeStatus: '?', status: '??' },
  ],
  diff: '',
  remotes: [{ name: 'origin', url: 'https://github.com/acme/project.git' }],
  publishRemotes: [
    {
      name: 'origin',
      repository: 'acme/project',
      url: 'https://github.com/acme/project.git',
    },
  ],
  upstream: 'origin/codex/fix',
  ahead: 1,
  behind: 0,
  defaultBranch: 'main',
  commitSupported: true,
  commitReason: null,
  pushSupported: true,
  pushReason: null,
  pullRequestSupported: true,
  pullRequestReason: null,
  githubAuthenticated: true,
  ghAvailable: true,
}
function renderActions(
  input: {
    running?: boolean
    readOnly?: boolean
    onBusy?: (busy: boolean) => void
  } = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <GitActionsPanel
        id='project'
        actor='user'
        running={input.running ?? false}
        readOnly={input.readOnly}
        onBusy={input.onBusy}
      />
    </QueryClientProvider>
  )
}
afterEach(() => clients.splice(0).forEach((client) => client.clear()))

describe('Git review and publication', () => {
  test('commit waits for an explicit review submit and sends only selected files with the reviewed head', async () => {
    const user = userEvent.setup()
    let current = gitStatus
    vi.spyOn(api, 'get').mockImplementation(async () => response(current))
    const post = vi.spyOn(api, 'post').mockImplementation(async () => {
      current = {
        ...gitStatus,
        head: 'def123456789',
        files: [gitStatus.files[1]],
      }
      return response({
        status: current,
        commit: { sha: current.head, subject: 'Fix app' },
      })
    })
    renderActions()
    await user.click(
      await screen.findByRole('button', { name: 'Commit' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Commit changes' })
    expect(post).not.toHaveBeenCalled()
    expect(
      within(dialog).getByRole('button', { name: 'Commit changes' })
    ).toBeDisabled()
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Commit message' }),
      'Fix app'
    )
    await user.click(within(dialog).getByRole('checkbox', { name: /docs.md/ }))
    await user.click(
      within(dialog).getByRole('button', { name: 'Commit changes' })
    )
    expect(post).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/git/commit',
      {
        message: 'Fix app',
        paths: ['src/app.ts'],
        expectedHead: 'abc123456789',
        expectedStatusVersion: 'review-version',
      },
      expect.any(Object)
    )
    expect(await screen.findByText('Committed def12345')).toBeVisible()
    expect(post).toHaveBeenCalledOnce()
  })
  test('push failures preserve the existing commit result and retry only the explicit push', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue(response(gitStatus))
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(
        response({
          status: gitStatus,
          commit: { sha: gitStatus.head, subject: 'Fix app' },
        })
      )
      .mockRejectedValueOnce(new Error('Remote rejected push'))
      .mockResolvedValue(
        response({
          status: gitStatus,
          push: { remote: 'origin', branch: 'codex/fix', head: gitStatus.head },
        })
      )
    renderActions()
    await user.click(
      await screen.findByRole('button', { name: 'Commit' })
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Commit message' }),
      'Fix app'
    )
    await user.click(screen.getByRole('button', { name: 'Commit changes' }))
    await screen.findByText('Committed abc12345')
    await user.click(screen.getByRole('button', { name: 'Push' }))
    await user.click(screen.getByRole('button', { name: 'Push branch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Remote rejected push'
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Committed abc12345')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Push' }))
    await user.click(screen.getByRole('button', { name: 'Push branch' }))
    expect(await screen.findByText('Pushed codex/fix to origin')).toBeVisible()
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      '/api/codex/workspaces/project/git/commit',
      '/api/codex/workspaces/project/git/push',
      '/api/codex/workspaces/project/git/push',
    ])
  })
  test('pull requests default to draft and publish only the reviewed title base and body without an implicit push', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue(response(gitStatus))
    const post = vi.spyOn(api, 'post').mockResolvedValue(
      response({
        status: gitStatus,
        pullRequest: {
          url: 'https://github.com/acme/project/pull/42',
          number: 42,
        },
      })
    )
    renderActions()
    await user.click(await screen.findByRole('button', { name: 'Create PR' }))
    expect(
      screen.getByRole('checkbox', { name: 'Create as draft' })
    ).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue(
      'main'
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Pull request title' }),
      'Fix app'
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Description' }),
      'Correct the view'
    )
    await user.click(
      screen.getByRole('button', { name: 'Create pull request' })
    )
    expect(post).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/git/pull-request',
      {
        title: 'Fix app',
        body: 'Correct the view',
        base: 'main',
        draft: true,
        remote: 'origin',
        expectedHead: 'abc123456789',
      },
      expect.any(Object)
    )
    expect(
      await screen.findByRole('link', { name: 'Open pull request #42' })
    ).toHaveAttribute('href', 'https://github.com/acme/project/pull/42')
  })
  test('missing GitHub permissions expose an actionable connection entry while retaining local commit', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      response({
        ...gitStatus,
        githubAuthenticated: false,
        pushSupported: false,
        pushReason: 'github_auth_required',
        pullRequestSupported: false,
        pullRequestReason: 'github_auth_required',
      })
    )
    renderActions()
    expect(
      await screen.findByRole('button', { name: 'Manage GitHub connection' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Commit' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Push' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeDisabled()
  })
  test.each([{ running: true }, { readOnly: true }])(
    'running or archived workspaces prevent Git mutations: %j',
    async (input) => {
      vi.spyOn(api, 'get').mockResolvedValue(response(gitStatus))
      const post = vi.spyOn(api, 'post')
      renderActions(input)
      expect(
        await screen.findByRole('button', { name: 'Commit' })
      ).toBeDisabled()
      expect(
        screen.getByRole('button', { name: 'Push' })
      ).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Create PR' })).toBeDisabled()
      expect(post).not.toHaveBeenCalled()
    }
  )
  test('a pending Git operation disables dismissal and reports busy until the request completes', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue(response(gitStatus))
    let resolvePost: (value: AxiosResponse) => void = () => undefined
    vi.spyOn(api, 'post').mockReturnValue(
      new Promise<AxiosResponse>((resolve) => {
        resolvePost = resolve
      })
    )
    const onBusy = vi.fn()
    renderActions({ onBusy })
    await user.click(
      await screen.findByRole('button', { name: 'Push' })
    )
    await user.click(screen.getByRole('button', { name: 'Push branch' }))
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Push branch' })).toBeVisible()
    resolvePost(
      response({
        status: gitStatus,
        push: { remote: 'origin', branch: 'codex/fix', head: gitStatus.head },
      })
    )
    await screen.findByText('Pushed codex/fix to origin')
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false))
  })
})
