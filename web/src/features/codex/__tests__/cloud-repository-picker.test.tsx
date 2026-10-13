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
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CloudRepositoryPicker } from '../components/cloud-repository-picker'
import type { CodexGitHubRepository, CodexGitHubStatus } from '../types'

const connected: CodexGitHubStatus = {
  configured: true,
  connected: true,
  login: 'octocat',
  capabilities: ['repositories'],
  scopes: ['repo'],
}
const frontend: CodexGitHubRepository = {
  id: 1,
  name: 'web',
  fullName: 'team/web',
  cloneUrl: 'https://github.com/team/web.git',
  private: true,
  defaultBranch: 'main',
}
const backend: CodexGitHubRepository = {
  id: 2,
  name: 'api',
  fullName: 'team/api',
  cloneUrl: 'https://github.com/team/api.git',
  private: false,
  defaultBranch: 'release',
}
const docs: CodexGitHubRepository = {
  id: 3,
  name: 'docs',
  fullName: 'team/docs',
  cloneUrl: 'https://github.com/team/docs.git',
  private: false,
  defaultBranch: 'docs',
}
const response = (data: unknown): AxiosResponse =>
  ({ data: { success: true, data } }) as AxiosResponse
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
})

function ControlledPicker(props: {
  actor?: string
  initialValue?: CodexGitHubRepository[]
  disabled?: boolean
  onChange?: (repositories: CodexGitHubRepository[]) => void
  onManageConnection?: () => void
}) {
  const [value, setValue] = useState(props.initialValue ?? [])
  return (
    <CloudRepositoryPicker
      actor={props.actor ?? '1'}
      value={value}
      onChange={(repositories) => {
        setValue(repositories)
        props.onChange?.(repositories)
      }}
      disabled={props.disabled}
      onManageConnection={props.onManageConnection}
    />
  )
}

function renderPicker(props: Parameters<typeof ControlledPicker>[0] = {}) {
  return render(
    <QueryClientProvider client={client}>
      <ControlledPicker {...props} />
    </QueryClientProvider>
  )
}

function mockRepositories(repositories = [frontend, backend]) {
  return vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/codex/github') return response(connected)
    return response({ repositories, hasMore: false })
  })
}

test('refreshing GitHub App permissions reveals a newly authorized private repository and keeps the existing selection', async () => {
  let accessGranted = false
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/codex/github') {
      return response({
        ...connected,
        scopes: [],
        capabilities: ['app_permissions'],
        applicationType: 'github_app',
        repositoryAccessUrl:
          'https://github.com/apps/fixture-workbench/installations/new',
      })
    }
    return response({
      repositories: accessGranted ? [backend, frontend] : [backend],
      hasMore: false,
    })
  })
  const user = userEvent.setup()
  renderPicker({ initialValue: [backend] })
  await screen.findByRole('checkbox', { name: backend.fullName })
  expect(
    screen.queryByRole('checkbox', { name: frontend.fullName })
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Grant repository access' })
  ).toHaveAttribute(
    'href',
    'https://github.com/apps/fixture-workbench/installations/new'
  )

  accessGranted = true
  await user.click(screen.getByRole('button', { name: 'Refresh repositories' }))

  expect(
    await screen.findByRole('checkbox', { name: frontend.fullName })
  ).toBeEnabled()
  expect(screen.getByRole('checkbox', { name: backend.fullName })).toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: frontend.fullName }))
  expect(
    screen.getByRole('checkbox', { name: frontend.fullName })
  ).toBeChecked()
})

test('status loading does not offer repositories until GitHub confirms a connection', async () => {
  let resolveStatus: (value: AxiosResponse) => void = () => undefined
  const get = vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/api/codex/github') {
      return new Promise((resolve) => {
        resolveStatus = resolve
      })
    }
    return Promise.resolve(
      response({ repositories: [frontend], hasMore: false })
    )
  })
  renderPicker()
  expect(screen.getByRole('status')).toHaveTextContent(
    'Loading GitHub connection...'
  )
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(get).toHaveBeenCalledOnce()

  await act(async () => resolveStatus(response(connected)))

  expect(
    await screen.findByRole('checkbox', { name: frontend.fullName })
  ).toBeEnabled()
})

test('multiple repository choices and Space keyboard selection return full repository records', async () => {
  mockRepositories()
  const onChange = vi.fn()
  const user = userEvent.setup()
  renderPicker({ onChange })
  const web = await screen.findByRole('checkbox', { name: frontend.fullName })
  web.focus()
  await user.keyboard(' ')
  await user.click(screen.getByRole('checkbox', { name: backend.fullName }))

  expect(onChange).toHaveBeenLastCalledWith([frontend, backend])
  expect(web).toBeChecked()
  expect(screen.getByRole('status')).toHaveTextContent('2 selected')
  expect(
    screen.getByRole('checkbox', { name: 'Select all matching repositories' })
  ).toBeChecked()
  expect(screen.getByLabelText('Private repository')).toBeVisible()

  await user.click(web)

  expect(onChange).toHaveBeenLastCalledWith([backend])
  expect(
    screen.getByRole('checkbox', { name: 'Select all matching repositories' })
  ).toBePartiallyChecked()
})

test('search and select all affect only matching repositories and preserve hidden selections', async () => {
  mockRepositories([frontend, backend, docs])
  const onChange = vi.fn()
  const user = userEvent.setup()
  renderPicker({ initialValue: [docs], onChange })
  const search = await screen.findByRole('searchbox', {
    name: 'Search repositories',
  })
  await screen.findByRole('checkbox', { name: frontend.fullName })
  await user.type(search, ' WEB ')
  expect(
    screen.queryByRole('checkbox', { name: backend.fullName })
  ).not.toBeInTheDocument()
  const selectAll = screen.getByRole('checkbox', {
    name: 'Select all matching repositories',
  })
  await user.click(selectAll)
  expect(onChange).toHaveBeenLastCalledWith([docs, frontend])
  expect(screen.getByRole('status')).toHaveTextContent('2 selected')

  await user.click(selectAll)

  expect(onChange).toHaveBeenLastCalledWith([docs])
  await user.clear(search)
  expect(screen.getByRole('checkbox', { name: docs.fullName })).toBeChecked()
})

test('loading additional pages keeps selections and shows newly matching repositories without duplicates', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url, options) => {
    if (url === '/api/codex/github') return response(connected)
    if (options?.params?.page === 2) {
      return response({ repositories: [frontend, docs], hasMore: false })
    }
    return response({ repositories: [frontend, backend], hasMore: true })
  })
  const user = userEvent.setup()
  renderPicker({ initialValue: [frontend] })
  await screen.findByRole('checkbox', { name: frontend.fullName })
  await user.type(screen.getByRole('searchbox'), 'docs')
  expect(screen.getByText('No matching repositories')).toBeVisible()
  expect(
    screen.getByText(
      'Search includes loaded repositories. Load more to search the rest.'
    )
  ).toBeVisible()

  await user.click(
    screen.getByRole('button', { name: 'Load more repositories' })
  )

  expect(
    await screen.findByRole('checkbox', { name: docs.fullName })
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Load more repositories' })
  ).not.toBeInTheDocument()
  expect(get).toHaveBeenCalledWith(
    '/api/codex/github/repositories',
    expect.objectContaining({ params: { page: 2, limit: 50 } })
  )
  await user.clear(screen.getByRole('searchbox'))
  expect(
    screen.getAllByRole('checkbox', { name: frontend.fullName })
  ).toHaveLength(1)
  expect(
    screen.getByRole('checkbox', { name: frontend.fullName })
  ).toBeChecked()
})

test('a failed next page preserves visible repositories and retries that page', async () => {
  let pageTwoAttempts = 0
  vi.spyOn(api, 'get').mockImplementation(async (url, options) => {
    if (url === '/api/codex/github') return response(connected)
    if (options?.params?.page === 2) {
      pageTwoAttempts += 1
      if (pageTwoAttempts === 1) {
        throw new Error('More repositories unavailable')
      }
      return response({ repositories: [docs], hasMore: false })
    }
    return response({ repositories: [frontend], hasMore: true })
  })
  const user = userEvent.setup()
  renderPicker({ initialValue: [frontend] })
  await user.click(
    await screen.findByRole('button', { name: 'Load more repositories' })
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'More repositories unavailable'
  )
  expect(
    screen.getByRole('checkbox', { name: frontend.fullName })
  ).toBeChecked()

  await user.click(
    screen.getByRole('button', { name: 'Retry loading repositories' })
  )

  expect(
    await screen.findByRole('checkbox', { name: docs.fullName })
  ).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('failed initial repository requests show an actionable retry without an empty state', async () => {
  let repositoryAttempts = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/codex/github') return response(connected)
    repositoryAttempts += 1
    if (repositoryAttempts === 1) {
      throw new Error('Repository access unavailable')
    }
    return response({ repositories: [frontend], hasMore: false })
  })
  renderPicker()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Repository access unavailable'
  )
  expect(
    screen.queryByText('No repositories available')
  ).not.toBeInTheDocument()

  await userEvent.click(
    screen.getByRole('button', { name: 'Retry loading repositories' })
  )

  expect(
    await screen.findByRole('checkbox', { name: frontend.fullName })
  ).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('failed GitHub status requests can recover before repository loading starts', async () => {
  let statusAttempts = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/codex/github') {
      statusAttempts += 1
      if (statusAttempts === 1) throw new Error('GitHub status unavailable')
      return response(connected)
    }
    return response({ repositories: [frontend], hasMore: false })
  })
  renderPicker()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'GitHub status unavailable'
  )
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()

  await userEvent.click(
    screen.getByRole('button', { name: 'Retry GitHub connection' })
  )

  expect(
    await screen.findByRole('checkbox', { name: frontend.fullName })
  ).toBeVisible()
})

test.each([
  { connected: false },
  { configured: false, connected: false },
  { revocationPending: true },
])(
  'unavailable GitHub connection %j opens management and never requests repositories',
  async (state) => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue(response({ ...connected, ...state }))
    const onManageConnection = vi.fn()
    renderPicker({ onManageConnection })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Manage GitHub connection' })
    )

    expect(onManageConnection).toHaveBeenCalledOnce()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalledWith(
      '/api/codex/github/repositories',
      expect.anything()
    )
  }
)

test('without a management callback disconnected accounts can use the existing GitHub authorization control', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    response({ ...connected, connected: false })
  )
  renderPicker()
  expect(
    await screen.findByRole('button', { name: 'Connect GitHub' })
  ).toBeEnabled()
})

test('an unconfigured site explains why direct GitHub authorization is unavailable', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(
    response({
      ...connected,
      configured: false,
      connected: false,
      reason: 'GitHub application unavailable',
    })
  )
  renderPicker()
  expect(
    await screen.findByText('GitHub application unavailable')
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled()
})

test('disabled selection cannot search, change repositories or manage the connection', async () => {
  mockRepositories()
  const onChange = vi.fn()
  const onManageConnection = vi.fn()
  renderPicker({ disabled: true, onChange, onManageConnection })
  const web = await screen.findByRole('checkbox', { name: frontend.fullName })
  expect(web).toBeDisabled()
  expect(
    screen.getByRole('checkbox', { name: 'Select all matching repositories' })
  ).toBeDisabled()
  expect(screen.getByRole('searchbox')).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'Manage GitHub connection' })
  ).toBeDisabled()
  await userEvent.click(web)
  expect(onChange).not.toHaveBeenCalled()
  expect(onManageConnection).not.toHaveBeenCalled()
})

test('empty repository lists disable select all and distinguish zero access from a search miss', async () => {
  mockRepositories([])
  renderPicker()
  expect(await screen.findByText('No repositories available')).toBeVisible()
  expect(
    screen.getByRole('checkbox', { name: 'Select all matching repositories' })
  ).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('0 selected')
})

test('switching actors immediately hides the previous account repositories and clears search', async () => {
  const get = mockRepositories()
  const view = renderPicker()
  await screen.findByRole('checkbox', { name: frontend.fullName })
  await userEvent.type(screen.getByRole('searchbox'), 'web')
  get.mockImplementation(async (url) => {
    if (url === '/api/codex/github') {
      return response({ ...connected, login: 'another-user' })
    }
    return response({ repositories: [docs], hasMore: false })
  })

  view.rerender(
    <QueryClientProvider client={client}>
      <ControlledPicker actor='2' />
    </QueryClientProvider>
  )

  expect(
    screen.queryByRole('checkbox', { name: frontend.fullName })
  ).not.toBeInTheDocument()
  expect(
    await screen.findByRole('checkbox', { name: docs.fullName })
  ).toBeVisible()
  expect(screen.getByRole('searchbox')).toHaveValue('')
  await waitFor(() => expect(screen.getByText('another-user')).toBeVisible())
})
