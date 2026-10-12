import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CloudEnvironmentsPanel } from '../components/cloud-environments-panel'
import { cloudCapabilities, cloudEnvironment } from './cloud-environment-fixtures'

let client: QueryClient
const response = (data: unknown) => ({ data: { success: true, data } })
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(() => { client.clear(); vi.restoreAllMocks() })

function renderPanel(actor = 'first', initialCreate = false) {
  const onStartTask = vi.fn()
  const onManageDocker = vi.fn()
  const result = render(<QueryClientProvider client={client}><CloudEnvironmentsPanel actor={actor} initialCreate={initialCreate} onStartTask={onStartTask} onManageDocker={onManageDocker} /></QueryClientProvider>)
  return { ...result, onStartTask, onManageDocker }
}

describe('Cloud environment management', () => {
  test('repository and environment search filters saved environments without removing Docker management', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response({ environments: [cloudEnvironment], capabilities: cloudCapabilities }))
    const { onManageDocker } = renderPanel()
    expect(await screen.findByRole('button', { name: 'Developer portal' })).toBeVisible()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search environments' }), 'missing')
    expect(screen.getByText('No environments match your search.')).toBeVisible()
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search environments' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search environments' }), 'example/portal')
    expect(screen.getByRole('button', { name: 'Developer portal' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Manage Docker' }))
    expect(onManageDocker).toHaveBeenCalledOnce()
  })

  test('a service error keeps creation unavailable and can be retried', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('Cloud service unavailable')).mockResolvedValue(response({ environments: [] }))
    renderPanel()
    expect(await screen.findByRole('alert')).toHaveTextContent('Cloud service unavailable')
    expect(screen.getByRole('button', { name: 'Create environment' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Create your first environment')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Create environment' })).toBeEnabled()
  })

  test('creating from selected GitHub repositories saves a draft and opens the setup workspace', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/codex/github') return response({ configured: true, connected: true, login: 'octocat', scopes: [], capabilities: [] })
      if (url === '/api/codex/github/repositories') return response({ repositories: [{ id: 7, name: 'portal', fullName: 'example/portal', cloneUrl: 'https://github.com/example/portal.git', defaultBranch: 'main', private: true }], hasMore: false })
      if (url === '/api/codex/environments/environment-1') return response({ environment: cloudEnvironment })
      return response({ environments: [], capabilities: cloudCapabilities })
    })
    const post = vi.spyOn(api, 'post').mockResolvedValue(response({ environment: cloudEnvironment }))
    renderPanel('first', true)
    const dialog = await screen.findByRole('dialog', { name: 'Create a cloud environment' })
    expect(within(dialog).getByRole('button', { name: 'Get started' })).toBeDisabled()
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: 'example/portal' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Get started' }))
    expect(await screen.findByRole('region', { name: 'Cloud environment setup' })).toBeVisible()
    expect(post).toHaveBeenCalledWith('/api/codex/environments', expect.objectContaining({ name: 'portal', config: expect.objectContaining({ repositories: [{ url: 'https://github.com/example/portal.git', branch: 'main', path: 'example-portal' }] }) }), expect.any(Object))
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled()
  })

  test('deletion requires a confirmation and failed deletion keeps the environment available', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response({ environments: [cloudEnvironment] }))
    const remove = vi.spyOn(api, 'delete').mockRejectedValue(new Error('Environment is busy'))
    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Developer portal' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete environment' }))
    expect(remove).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Delete environment' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Environment is busy')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Developer portal' })).toBeVisible()
  })

  test('personal vault explains the actual environment secret support without inventing a shared vault', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response({ environments: [] }))
    renderPanel()
    await userEvent.click(screen.getByRole('button', { name: 'Personal vault' }))
    expect(screen.getByText(/A shared personal vault is not available/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add secret' })).not.toBeInTheDocument()
  })
})
