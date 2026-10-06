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
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ClientFormDialog } from '../components/client-form-dialog'
import type { OauthClient } from '../types'

const originalAdapter = api.defaults.adapter
const client: OauthClient = {
  id: 1,
  client_id: 'app1',
  name: 'Existing app',
  description: '',
  redirect_uris: ['https://example.com/callback'],
  scopes: ['openid', 'profile:read'],
  is_public: false,
  enabled: true,
  created_time: 1,
  last_used_at: 0,
}
const capabilities = [
  {
    scope: 'openid',
    label: 'Sign in',
    description: 'Identify account',
    resource: 'urn:new-api:dashboard',
    sensitive: false,
    min_role: 1,
  },
  {
    scope: 'profile',
    label: 'Profile',
    description: 'View profile',
    resource: 'urn:new-api:dashboard',
    sensitive: false,
    min_role: 1,
  },
  {
    scope: 'email',
    label: 'Email address',
    description: 'View email',
    resource: 'urn:new-api:dashboard',
    sensitive: false,
    min_role: 1,
  },
  {
    scope: 'profile:read',
    label: 'Read account',
    description: 'Read account information',
    resource: 'urn:new-api:dashboard',
    sensitive: false,
    min_role: 1,
  },
  {
    scope: 'relay:invoke',
    label: 'Call models',
    description: 'Use account balance',
    resource: 'urn:new-api:relay',
    sensitive: true,
    min_role: 1,
  },
]
let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  useAuthStore.getState().auth.setUser({ id: 1, username: 'root', role: 100 })
})

afterEach(() => {
  queryClient.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
})

function renderForm(
  existing: OauthClient | null = null,
  onSecretCreated = vi.fn()
) {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <ClientFormDialog
        open
        onOpenChange={onOpenChange}
        client={existing}
        onSecretCreated={onSecretCreated}
      />
    </QueryClientProvider>
  )
  return { onOpenChange, onSecretCreated }
}

test('selects the current capability snapshot and creates a client without caching the one-time secret', async () => {
  let submitted: Record<string, unknown> | undefined
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') submitted = JSON.parse(config.data)
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        success: true,
        data:
          config.method === 'get'
            ? {
                capabilities,
                resources: ['urn:new-api:dashboard', 'urn:new-api:relay'],
                catalog_version: '1',
              }
            : { client, client_secret: 'one-time-secret-sentinel' },
      },
    }
  }
  const callbacks = renderForm()
  const user = userEvent.setup()
  await screen.findByRole('checkbox', { name: 'Call models' })
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Test app')
  await user.type(
    screen.getByRole('textbox', { name: 'Redirect URIs' }),
    'https://example.com/callback'
  )
  await user.click(
    screen.getByRole('button', { name: 'Select all current permissions' })
  )
  expect(screen.getByRole('checkbox', { name: 'Call models' })).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() =>
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false)
  )
  expect(submitted?.scopes).toEqual(capabilities.map((item) => item.scope))
  expect(callbacks.onSecretCreated).toHaveBeenCalledWith(
    'app1',
    'one-time-secret-sentinel'
  )
  expect(
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state)
    )
  ).not.toContain('one-time-secret-sentinel')
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state)
    )
  ).not.toContain('one-time-secret-sentinel')
})

test('preserves existing permissions and locks the authentication type while allowing keyboard permission changes', async () => {
  let submitted: Record<string, unknown> | undefined
  api.defaults.adapter = async (config) => {
    if (config.method === 'put') submitted = JSON.parse(config.data)
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        success: true,
        data: config.method === 'get' ? { capabilities } : client,
      },
    }
  }
  renderForm(client)
  const readAccount = await screen.findByRole('checkbox', {
    name: 'Read account',
  })
  expect(readAccount).toBeChecked()
  expect(
    screen.getByRole('checkbox', { name: 'Call models' })
  ).not.toBeChecked()
  expect(
    screen.getByRole('switch', { name: 'Public client (PKCE)' })
  ).toHaveAttribute('aria-disabled', 'true')
  const user = userEvent.setup()
  await user.click(screen.getByRole('textbox', { name: 'Search permissions' }))
  await user.type(
    screen.getByRole('textbox', { name: 'Search permissions' }),
    'Call models'
  )
  expect(
    screen.queryByRole('checkbox', { name: 'Read account' })
  ).not.toBeInTheDocument()
  const invoke = screen.getByRole('checkbox', { name: 'Call models' })
  invoke.focus()
  await user.keyboard(' ')
  expect(invoke).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(submitted?.scopes).toEqual([
      'openid',
      'profile:read',
      'relay:invoke',
    ])
  )
})

test('keeps the form blocked on a failed capability catalog and allows an explicit retry', async () => {
  let failed = true
  let mutations = 0
  api.defaults.adapter = async (config) => {
    if (config.method !== 'get') mutations++
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: failed
        ? { success: false, message: 'Private catalog sentinel' }
        : { success: true, data: { capabilities } },
    }
  }
  renderForm(client)
  expect(
    await screen.findByText('Unable to load application permissions')
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(screen.queryByText(/Private catalog/)).not.toBeInTheDocument()
  failed = false
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('checkbox', { name: 'Read account' })
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  expect(mutations).toBe(0)
})

test('retains the dialog after a failed create and shows one generic error without exposing server details', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  const defaultError = vi.fn()
  queryClient.setDefaultOptions({
    queries: { retry: false },
    mutations: { onError: defaultError },
  })
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data:
      config.method === 'get'
        ? { success: true, data: { capabilities } }
        : { success: false, message: 'Private credential diagnostic sentinel' },
  })
  const callbacks = renderForm()
  await screen.findByRole('checkbox', { name: 'Sign in' })
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Test app')
  await user.type(
    screen.getByRole('textbox', { name: 'Redirect URIs' }),
    'https://example.com/callback'
  )
  await user.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith('Failed to create client')
  )
  expect(errorToast).toHaveBeenCalledTimes(1)
  expect(defaultError).not.toHaveBeenCalled()
  expect(callbacks.onOpenChange).not.toHaveBeenCalled()
  expect(callbacks.onSecretCreated).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Test app')
})
