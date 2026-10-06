import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { narrowOauthGrant, revokeOauthGrant } from '../api'
import { AuthorizedAppsCard } from '../components/authorized-apps-card'
import type { OAuthGrant } from '../types'

const originalAdapter = api.defaults.adapter
let queryClient: QueryClient
const grant: OAuthGrant = {
  id: 8,
  user_id: 1,
  client_id: 'external-client',
  client_name: 'External Studio',
  scopes: ['profile:read', 'relay:invoke'],
  resources: ['urn:new-api:dashboard', 'urn:new-api:relay'],
  created_at: 1790937000,
  expires_at: 1791937000,
  revoked_at: 0,
  active: true,
}
const catalog = {
  catalog_version: '2026-10-02',
  granted_scopes: null,
  resources: grant.resources,
  capabilities: [
    {
      scope: 'profile:read',
      label: 'Read account',
      description: 'View your account.',
      resource: grant.resources[0],
      sensitive: false,
      min_role: 1,
    },
    {
      scope: 'relay:invoke',
      label: 'Call models',
      description: 'Spend account balance.',
      resource: grant.resources[1],
      sensitive: true,
      min_role: 1,
    },
    {
      scope: 'channel:read',
      label: 'Read channels',
      description: 'Read administrator channels.',
      resource: grant.resources[0],
      sensitive: true,
      min_role: 10,
    },
  ],
}

function renderCard() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthorizedAppsCard />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  useAuthStore.getState().auth.setUser({ id: 1, username: 'alice', role: 1 })
})

afterEach(() => {
  queryClient.clear()
  useAuthStore.getState().auth.reset()
  api.defaults.adapter = originalAdapter
})

test('shows an empty state after the account has no authorizations', async () => {
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data: config.url?.endsWith('capabilities') ? catalog : [],
    },
  })
  renderCard()
  expect(await screen.findByText('No authorized applications')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Revoke access' })
  ).not.toBeInTheDocument()
})

test('removes only selected permissions and cannot add an unrelated capability', async () => {
  const requests: { method?: string; url?: string; body: unknown }[] = []
  let scopes = grant.scopes
  api.defaults.adapter = async (config) => {
    if (config.method === 'patch') {
      const body = JSON.parse(config.data) as { scopes: string[] }
      requests.push({ method: config.method, url: config.url, body })
      scopes = body.scopes
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        success: true,
        data: config.url?.endsWith('capabilities')
          ? catalog
          : [{ ...grant, scopes }],
      },
    }
  }
  renderCard()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Manage permissions' })
  )
  const dialog = screen.getByRole('dialog', {
    name: 'Manage application permissions',
  })
  expect(
    within(dialog).queryByRole('checkbox', { name: 'Read channels' })
  ).not.toBeInTheDocument()
  expect(
    within(dialog).getByRole('button', { name: 'Save permissions' })
  ).toBeDisabled()
  await user.click(
    within(dialog).getByRole('checkbox', { name: /Call models/ })
  )
  await user.click(
    within(dialog).getByRole('button', { name: 'Save permissions' })
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(requests).toEqual([
    {
      method: 'patch',
      url: '/api/oauth2/grants/8',
      body: { scopes: ['profile:read'] },
    },
  ])
})

test('requires confirmation before revoking and refreshes the real server result', async () => {
  let revoked = false
  api.defaults.adapter = async (config) => {
    if (config.method === 'delete') revoked = true
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        success: true,
        data: config.url?.endsWith('capabilities')
          ? catalog
          : [{ ...grant, active: !revoked }],
      },
    }
  }
  renderCard()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Revoke access' }))
  expect(revoked).toBe(false)
  const dialog = screen.getByRole('alertdialog', {
    name: 'Revoke application access?',
  })
  await user.click(
    within(dialog).getByRole('button', { name: 'Revoke access' })
  )
  expect(await screen.findByText('Inactive')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Revoke access' })
  ).not.toBeInTheDocument()
})

test('keeps a failed revocation visible without claiming success or leaking raw errors', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  const successToast = vi.spyOn(toast, 'success')
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data:
      config.method === 'delete'
        ? { success: false, message: 'private-database-token' }
        : {
            success: true,
            data: config.url?.endsWith('capabilities') ? catalog : [grant],
          },
  })
  renderCard()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Revoke access' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Revoke access',
    })
  )
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith(
      'Unable to revoke application access'
    )
  )
  expect(successToast).not.toHaveBeenCalled()
  expect(screen.getByRole('alertdialog')).toBeVisible()
  expect(document.body.textContent).not.toContain('private-database-token')
})

test('closes old account grant dialogs immediately when the signed-in identity changes', async () => {
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data: config.url?.endsWith('capabilities')
        ? catalog
        : [grant].filter(() => useAuthStore.getState().auth.user?.id === 1),
    },
  })
  renderCard()
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Manage permissions' })
  )
  expect(screen.getByRole('dialog')).toBeVisible()
  act(() =>
    useAuthStore.getState().auth.setUser({ id: 2, username: 'bob', role: 1 })
  )
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByText('External Studio')).not.toBeInTheDocument()
  expect(await screen.findByText('No authorized applications')).toBeVisible()
})

test('a rejected grant list is an error state and never an empty authorization list', async () => {
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: config.url?.endsWith('capabilities')
      ? { success: true, data: catalog }
      : { success: false, message: 'private authorization storage details' },
  })
  renderCard()
  expect(
    await screen.findByText('Unable to load authorized applications')
  ).toBeVisible()
  expect(
    screen.queryByText('No authorized applications')
  ).not.toBeInTheDocument()
  expect(document.body.textContent).not.toContain(
    'private authorization storage details'
  )
})

test('mutation API rejects business failures without triggering global raw toasts', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: { success: false, message: 'secret grant data' },
  })
  await expect(narrowOauthGrant(8, ['profile:read'])).rejects.toThrow(
    'Unable to update application permissions'
  )
  await expect(revokeOauthGrant(8)).rejects.toThrow(
    'Unable to revoke application access'
  )
  expect(errorToast).not.toHaveBeenCalled()
})

test('loads authorizations in StrictMode without reusing an aborted Axios request', async () => {
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data: config.url?.endsWith('capabilities') ? catalog : [grant],
    },
  })
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthorizedAppsCard />
      </QueryClientProvider>
    </StrictMode>
  )
  expect(await screen.findByText('External Studio')).toBeVisible()
  expect(
    screen.queryByText('Unable to load authorized applications')
  ).not.toBeInTheDocument()
})

test('keeps long application names wrappable within the card column', async () => {
  const clientName = 'ExternalStudio'.repeat(30)
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data: config.url?.endsWith('capabilities')
        ? catalog
        : [{ ...grant, client_name: clientName }],
    },
  })
  renderCard()
  const heading = await screen.findByRole('heading', { name: clientName })
  expect(heading).toHaveClass(
    'min-w-0',
    'max-w-full',
    '[overflow-wrap:anywhere]'
  )
  expect(heading.closest('[data-slot="card"]')).toHaveClass(
    'min-w-0',
    'max-w-full'
  )
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible()
})
