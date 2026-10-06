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
import { AxiosError } from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { SecretRevealDialog } from '../components/client-form-dialog'
import { OauthProviderSection } from '../oauth-provider-section'
import type { OauthClient } from '../types'

const originalAdapter = api.defaults.adapter
const client: OauthClient = {
  id: 1,
  client_id: 'app1',
  name: 'Existing app',
  description: '',
  redirect_uris: ['https://example.com/callback'],
  scopes: ['openid', 'relay:invoke'],
  is_public: false,
  enabled: true,
  created_time: 1,
  last_used_at: 0,
}
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

function renderSection() {
  return render(
    <QueryClientProvider client={queryClient}>
      <OauthProviderSection
        serverAddress='https://example.com'
        defaultValues={{
          'oauth_provider.enabled': true,
          'oauth_provider.issuer': 'https://example.com/oidc',
          'oauth_provider.access_token_ttl_minutes': 15,
        }}
      />
    </QueryClientProvider>
  )
}

test('reveals a rotated secret only once and never stores it in query or mutation caches', async () => {
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data:
        config.method === 'get'
          ? [client]
          : { client_secret: 'rotated-secret-sentinel' },
    },
  })
  renderSection()
  await screen.findByText('Existing app')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Reset secret' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Reset secret',
    })
  )
  expect(await screen.findByText('rotated-secret-sentinel')).toBeVisible()
  expect(
    JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state)
    )
  ).not.toContain('rotated-secret-sentinel')
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state)
    )
  ).not.toContain('rotated-secret-sentinel')
  await user.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() =>
    expect(
      screen.queryByText('rotated-secret-sentinel')
    ).not.toBeInTheDocument()
  )
  await user.click(screen.getByRole('button', { name: 'Reset secret' }))
  expect(screen.queryByText('rotated-secret-sentinel')).not.toBeInTheDocument()
})

test('retains a failed reset confirmation for retry and hides the server diagnostic', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data:
      config.method === 'get'
        ? { success: true, data: [client] }
        : { success: false, message: 'Private reset diagnostic' },
  })
  renderSection()
  await screen.findByText('Existing app')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Reset secret' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Reset secret',
    })
  )
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith('Failed to reset client secret')
  )
  expect(screen.getByRole('alertdialog')).toBeVisible()
  expect(screen.queryByText(/Private reset/)).not.toBeInTheDocument()
  expect(errorToast).toHaveBeenCalledTimes(1)
})

test('shows an error instead of an empty client table for HTTP failures and recovers on retry', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  let failure = true
  api.defaults.adapter = async (config) => {
    if (failure) {
      throw new AxiosError(
        'Private administrator diagnostic',
        'ERR_BAD_RESPONSE',
        config,
        undefined,
        {
          config,
          status: 503,
          statusText: 'Service Unavailable',
          headers: {},
          data: { message: 'Private administrator diagnostic' },
        }
      )
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success: true, data: [] },
    }
  }
  renderSection()
  expect(await screen.findByText('Failed to load OAuth clients')).toBeVisible()
  expect(
    screen.queryByText('No OAuth clients configured yet.')
  ).not.toBeInTheDocument()
  expect(errorToast).not.toHaveBeenCalled()
  failure = false
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
  expect(
    await screen.findByText('No OAuth clients configured yet.')
  ).toBeVisible()
})

test('clears the visible secret and client list immediately when the signed-in account changes', async () => {
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data:
        config.method === 'get'
          ? [client]
          : { client_secret: 'account-change-secret-sentinel' },
    },
  })
  renderSection()
  await screen.findByText('Existing app')
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Reset secret' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Reset secret',
    })
  )
  expect(
    await screen.findByText('account-change-secret-sentinel')
  ).toBeVisible()
  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 2, username: 'ordinary', role: 1 })
  )
  expect(
    screen.queryByText('account-change-secret-sentinel')
  ).not.toBeInTheDocument()
  expect(screen.queryByText('Existing app')).not.toBeInTheDocument()
})

test('keeps failed deletion open and lists explicit permissions without exposing a secret action for public clients', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data:
      config.method === 'get'
        ? { success: true, data: [{ ...client, is_public: true }] }
        : { success: false, message: 'Private delete diagnostic' },
  })
  renderSection()
  await screen.findByText('Existing app')
  expect(
    screen.getByRole('button', { name: 'Public clients have no secret' })
  ).toBeDisabled()
  const user = userEvent.setup()
  await user.click(screen.getByText('2 permissions'))
  expect(screen.getByText('relay:invoke')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
  )
  await waitFor(() =>
    expect(errorToast).toHaveBeenCalledWith('Failed to delete client')
  )
  expect(screen.getByRole('alertdialog')).toBeVisible()
  expect(screen.queryByText(/Private delete/)).not.toBeInTheDocument()
})

test('keeps long credentials inside the secret dialog grid on narrow screens', () => {
  const secret = 'secret-value-'.repeat(40)
  render(
    <SecretRevealDialog
      open
      clientId={'client-'.repeat(35)}
      secret={secret}
      onOpenChange={() => undefined}
    />
  )
  const dialog = screen.getByRole('dialog', { name: 'Client secret' })
  expect(dialog).toHaveClass('min-w-0', 'grid-cols-[minmax(0,1fr)]')
  expect(within(dialog).getByText(secret)).toHaveClass('min-w-0', 'truncate')
  expect(within(dialog).getByRole('button', { name: 'Done' })).toBeVisible()
})
