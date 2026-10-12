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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CreateWorkspaceDialog } from '../components/create-workspace'
import type { CodexSshConnection } from '../types'

const connection: CodexSshConnection = {
  id: 'server-1',
  name: 'Development',
  host: 'dev.example.com',
  port: 22,
  username: 'developer',
  authType: 'key',
  fingerprint: 'SHA256:trusted-host-key',
  createdAt: '2026-10-07T00:00:00Z',
}
const disconnected = {
  configured: true,
  connected: false,
  scopes: [],
  capabilities: [],
}
const response = (data: unknown): AxiosResponse =>
  ({ data: { success: true, data } }) as AxiosResponse
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.spyOn(api, 'get').mockResolvedValue(response(disconnected))
})
afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
})

function renderProject(
  overrides: Partial<Parameters<typeof CreateWorkspaceDialog>[0]> = {}
) {
  const props = {
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn(async () => undefined),
    ...overrides,
  }
  const view = render(
    <QueryClientProvider client={client}>
      <CreateWorkspaceDialog {...props} />
    </QueryClientProvider>
  )
  return {
    ...view,
    props,
    update: (next: Partial<typeof props>) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <CreateWorkspaceDialog {...props} {...next} />
        </QueryClientProvider>
      ),
  }
}

describe('ChatGPT-style project creation', () => {
  test('an unavailable environment disables every project input while cancellation remains available', async () => {
    const view = renderProject({ disabled: true, initialSource: 'git' })

    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeDisabled()
    expect(
      screen.getByRole('textbox', { name: 'Repository URL' })
    ).toBeDisabled()
    expect(
      screen.getByRole('textbox', { name: 'Branch (optional)' })
    ).toBeDisabled()
    expect(
      screen.getByRole('radio', { name: /Import repository/ })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(view.props.onClose).toHaveBeenCalledOnce()
    expect(view.props.onCreate).not.toHaveBeenCalled()
  })

  test('cancelling a draft and opening again starts with a clean form', async () => {
    const view = renderProject()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Abandoned'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    view.update({ open: false })
    view.update({ open: true })

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      ''
    )
    expect(view.props.onCreate).not.toHaveBeenCalled()
  })

  test('opening focuses the project name and Enter creates a trimmed blank project', async () => {
    const view = renderProject()
    const name = screen.getByRole('textbox', { name: 'Project name' })
    await waitFor(() => expect(name).toHaveFocus())
    await userEvent.type(name, '  Website  {Enter}')

    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({ name: 'Website' })
    )
    expect(view.props.onClose).toHaveBeenCalledOnce()
  })

  test('switching sources using the keyboard updates the selection and clears hidden validation errors', async () => {
    const view = renderProject({ initialSource: 'git' })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Website'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a public HTTPS repository URL'
    )
    const repository = screen.getByRole('radio', { name: /Import repository/ })
    repository.focus()
    await userEvent.keyboard('{ArrowLeft}')

    expect(screen.getByRole('radio', { name: /Blank project/ })).toBeChecked()
    expect(
      screen.queryByRole('textbox', { name: 'Repository URL' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({ name: 'Website' })
    )
  })

  test('submitting a project locks editing and dismissal until the request finishes, then permits retry after failure', async () => {
    let rejectCreation: (reason: Error) => void = () => undefined
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, reject) => {
            rejectCreation = reject
          })
      )
      .mockResolvedValue(undefined)
    const view = renderProject({ onCreate: create })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Website'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )

    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Creating project...')
    await userEvent.keyboard('{Escape}')
    expect(view.props.onClose).not.toHaveBeenCalled()
    await act(async () => rejectCreation(new Error('Environment unavailable')))

    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent('Environment unavailable')
    await waitFor(() => expect(error).toHaveFocus())
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'Website'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() => expect(view.props.onClose).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledTimes(2)
  })

  test('the close control discards validation errors and Escape dismisses a fresh draft', async () => {
    const view = renderProject()
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a project name.'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    view.update({ open: false })
    view.update({ open: true })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(view.props.onClose).toHaveBeenCalledTimes(2)
    expect(view.props.onCreate).not.toHaveBeenCalled()
  })

  test('connected GitHub repositories can be paged and a private selection fills the empty name and imports its URL', async () => {
    const first = {
      id: 1,
      name: 'website',
      fullName: 'octocat/website',
      private: true,
      cloneUrl: 'https://github.com/octocat/website.git',
      defaultBranch: 'main',
    }
    const second = {
      ...first,
      id: 2,
      name: 'docs',
      fullName: 'octocat/docs',
      cloneUrl: 'https://github.com/octocat/docs.git',
    }
    vi.mocked(api.get)
      .mockResolvedValueOnce(
        response({ ...disconnected, connected: true, login: 'octocat' })
      )
      .mockResolvedValueOnce(response({ repositories: [first], hasMore: true }))
      .mockResolvedValueOnce(
        response({ repositories: [second], hasMore: false })
      )
    const view = renderProject({ initialSource: 'git' })
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Your GitHub repositories' })
      ).toBeEnabled()
    )
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    )
    expect(api.get).toHaveBeenCalledWith(
      '/api/codex/github/repositories',
      expect.objectContaining({ params: { page: 2, limit: 50 } })
    )
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Your GitHub repositories' })
      ).toBeEnabled()
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Your GitHub repositories' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'octocat/docs · Private' })
    )

    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'docs'
    )
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toHaveValue(
      second.cloneUrl
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({
        name: 'docs',
        repositoryUrl: second.cloneUrl,
      })
    )
  })

  test('an empty GitHub repository list still permits importing a URL', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(response({ ...disconnected, connected: true }))
      .mockResolvedValueOnce(response({ repositories: [], hasMore: false }))
    const view = renderProject({ initialSource: 'git' })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No repositories found. Paste a repository URL below.'
    )
    expect(
      screen.getByRole('combobox', { name: 'Your GitHub repositories' })
    ).toBeDisabled()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Public project'
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Repository URL' }),
      'https://github.com/owner/project.git'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({
        name: 'Public project',
        repositoryUrl: 'https://github.com/owner/project.git',
      })
    )
  })

  test('GitHub status and repository lookup failures can be retried without losing a typed URL', async () => {
    vi.mocked(api.get)
      .mockRejectedValueOnce(new Error('GitHub unavailable'))
      .mockResolvedValueOnce(response({ ...disconnected, connected: true }))
      .mockRejectedValueOnce(new Error('Repository lookup unavailable'))
      .mockResolvedValueOnce(response({ repositories: [], hasMore: false }))
    renderProject({ initialSource: 'git' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub unavailable'
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Repository URL' }),
      'https://github.com/owner/project.git'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry GitHub connection' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Repository lookup unavailable'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No repositories found.'
    )
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toHaveValue(
      'https://github.com/owner/project.git'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('a remote project validates its directory and submits the selected saved connection', async () => {
    const view = renderProject({
      initialSource: 'ssh',
      connections: [connection],
    })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Remote project'
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Remote server' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: /Development/ })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Remote project directory' }),
      '/home/developer/../project'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter an absolute remote project directory.'
    )
    expect(
      screen.getByRole('textbox', { name: 'Remote project directory' })
    ).toHaveAttribute('aria-invalid', 'true')
    expect(view.props.onCreate).not.toHaveBeenCalled()
    await userEvent.clear(
      screen.getByRole('textbox', { name: 'Remote project directory' })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Remote project directory' }),
      '/home/developer/project'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({
        name: 'Remote project',
        remote: { connectionId: 'server-1', path: '/home/developer/project' },
      })
    )
  })

  test('an empty SSH connection list explains how to manage connections and keeps the draft', async () => {
    const manage = vi.fn()
    const view = renderProject({
      initialSource: 'ssh',
      onManageConnections: manage,
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'No SSH servers connected yet.'
    )
    expect(
      screen.getByRole('combobox', { name: 'Remote server' })
    ).toBeDisabled()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Remote draft'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Manage connections' })
    )
    expect(manage).toHaveBeenCalledOnce()
    view.update({ open: false })
    view.update({ open: true, connections: [connection] })
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'Remote draft'
    )
  })

  test('returning from connection management preserves a manually selected SSH source and its directory', async () => {
    const view = renderProject({ onManageConnections: vi.fn() })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Remote draft'
    )
    await userEvent.click(screen.getByRole('radio', { name: /Remote server/ }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Remote project directory' }),
      '/home/developer/project'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Manage connections' })
    )
    view.update({ open: false })
    view.update({ open: true, connections: [connection] })

    expect(screen.getByRole('radio', { name: /Remote server/ })).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'Remote draft'
    )
    expect(
      screen.getByRole('textbox', { name: 'Remote project directory' })
    ).toHaveValue('/home/developer/project')
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Remote server' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: /Development/ })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({
        name: 'Remote draft',
        remote: {
          connectionId: connection.id,
          path: '/home/developer/project',
        },
      })
    )
  })

  test('a removed saved SSH connection cannot be submitted from a stale selection', async () => {
    const view = renderProject({
      initialSource: 'ssh',
      connections: [connection],
    })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Remote project'
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Remote server' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: /Development/ })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Remote project directory' }),
      '/home/developer/project'
    )
    view.update({ connections: [] })
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a remote server.'
    )
    expect(
      screen.getByRole('combobox', { name: 'Remote server' })
    ).toHaveAttribute('aria-invalid', 'true')
    expect(view.props.onCreate).not.toHaveBeenCalled()
  })

  test('an invalid hidden repository never blocks creating a blank project', async () => {
    const view = renderProject({ initialSource: 'git' })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Website'
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), {
      target: { value: `https://github.com/${'a'.repeat(2048)}` },
    })
    await userEvent.click(screen.getByRole('radio', { name: /Blank project/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({ name: 'Website' })
    )
  })

  test('a repository import sends the requested branch and keeps it after an import failure', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Requested branch does not exist'))
      .mockResolvedValue(undefined)
    const view = renderProject({ initialSource: 'git', onCreate: create })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Release project'
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Repository URL' }),
      'https://github.com/owner/project.git'
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Branch (optional)' }),
      'release/2026.10'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Requested branch does not exist'
    )
    expect(create).toHaveBeenCalledWith({
      name: 'Release project',
      repositoryUrl: 'https://github.com/owner/project.git',
      branch: 'release/2026.10',
    })
    expect(view.props.onClose).not.toHaveBeenCalled()
    expect(
      screen.getByRole('textbox', { name: 'Branch (optional)' })
    ).toHaveValue('release/2026.10')
    await userEvent.clear(
      screen.getByRole('textbox', { name: 'Branch (optional)' })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Branch (optional)' }),
      'main'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(create).toHaveBeenLastCalledWith({
        name: 'Release project',
        repositoryUrl: 'https://github.com/owner/project.git',
        branch: 'main',
      })
    )
    expect(view.props.onClose).toHaveBeenCalledOnce()
  })

  test.each([
    '--upload-pack=command',
    'feature/../other',
    'release//latest',
    'feature/',
    'feature.lock',
  ])(
    'an unsupported branch %s receives field feedback before creation',
    async (branch) => {
      const view = renderProject({ initialSource: 'git' })
      fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
        target: { value: 'Release project' },
      })
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Repository URL' }),
        { target: { value: 'https://github.com/owner/project.git' } }
      )
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Branch (optional)' }),
        { target: { value: branch } }
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Create project' })
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Enter a valid repository branch (up to 200 characters).'
      )
      expect(
        screen.getByRole('textbox', { name: 'Branch (optional)' })
      ).toHaveAttribute('aria-invalid', 'true')
      expect(view.props.onCreate).not.toHaveBeenCalled()
    }
  )

  test('a selected GitHub repository can import a custom branch instead of its default branch', async () => {
    const repository = {
      id: 1,
      name: 'website',
      fullName: 'octocat/website',
      private: false,
      cloneUrl: 'https://github.com/octocat/website.git',
      defaultBranch: 'main',
    }
    vi.mocked(api.get)
      .mockResolvedValueOnce(response({ ...disconnected, connected: true }))
      .mockResolvedValueOnce(
        response({ repositories: [repository], hasMore: false })
      )
    const view = renderProject({ initialSource: 'git' })
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Your GitHub repositories' })
      ).toBeEnabled()
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Your GitHub repositories' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: 'octocat/website' })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Branch (optional)' }),
      '  feature/new-ui  '
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )

    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({
        name: 'website',
        repositoryUrl: repository.cloneUrl,
        branch: 'feature/new-ui',
      })
    )
  })

  test('switching from a repository to blank or SSH hides the branch and never submits its draft', async () => {
    const view = renderProject({
      initialSource: 'git',
      connections: [connection],
    })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Branch (optional)' }),
      'feature/unfinished'
    )
    await userEvent.click(screen.getByRole('radio', { name: /Blank project/ }))
    expect(
      screen.queryByRole('textbox', { name: 'Branch (optional)' })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Remote server/ }))
    expect(
      screen.queryByRole('textbox', { name: 'Branch (optional)' })
    ).not.toBeInTheDocument()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Remote project'
    )
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Remote server' })
    )
    await userEvent.click(
      await screen.findByRole('option', { name: /Development/ })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Remote project directory' }),
      '/home/developer/project'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )

    await waitFor(() =>
      expect(view.props.onCreate).toHaveBeenCalledWith({
        name: 'Remote project',
        remote: {
          connectionId: connection.id,
          path: '/home/developer/project',
        },
      })
    )
  })

  test('cancelling a repository draft clears the entered branch before reopening', async () => {
    const view = renderProject({ initialSource: 'git' })
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Branch (optional)' }),
      'feature/unfinished'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    view.update({ open: false })
    view.update({ open: true })

    expect(
      screen.getByRole('textbox', { name: 'Branch (optional)' })
    ).toHaveValue('')
    expect(view.props.onCreate).not.toHaveBeenCalled()
  })
})

test('administrators can create a project in an existing host directory', async () => {
  const view = renderProject({ allowHost: true, initialSource: 'host' })
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Project name' }),
    'Host service'
  )
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Host project directory' }),
    '/root/project'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Create project' }))
  await waitFor(() =>
    expect(view.props.onCreate).toHaveBeenCalledWith({
      name: 'Host service',
      host: { path: '/root/project' },
    })
  )
})

test('ordinary users do not see the host project source', () => {
  renderProject()
  expect(screen.queryByRole('radio', { name: 'Host' })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('textbox', { name: 'Host project directory' })
  ).not.toBeInTheDocument()
})

test('a relative host directory is rejected before creating a project', async () => {
  const view = renderProject({ allowHost: true, initialSource: 'host' })
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Project name' }),
    'Host service'
  )
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Host project directory' }),
    '../project'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Create project' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Enter an absolute host project directory.'
  )
  expect(view.props.onCreate).not.toHaveBeenCalled()
})
