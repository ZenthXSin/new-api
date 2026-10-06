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
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { AuthorizeSearchParams } from '../api'
import { AuthorizeScreen } from '../authorize-screen'

const baseParams = {
  client_id: 'test-rp-client',
  redirect_uri: 'https://rp.example.com/cb',
  scope: 'full',
  state: 'st4te',
  nonce: 'n0nce',
  resource: ['urn:new-api:dashboard', 'urn:new-api:relay'],
}

const originalAdapter = api.defaults.adapter
const originalLocation = window.location
const replaceMock = vi.fn()
let client: QueryClient

function preview() {
  return {
    success: true,
    require_consent: true,
    consent_token: 'single-use-consent',
    resources: baseParams.resource,
    client: { name: 'Test RP', description: 'An external application' },
    scopes: ['openid', 'profile:read', 'wallet:write'],
    capabilities: [
      {
        scope: 'openid',
        label: 'Confirm your identity',
        description: '',
        resource: 'urn:new-api:dashboard',
        sensitive: false,
        min_role: 1,
      },
      {
        scope: 'profile:read',
        label: 'Read account profile',
        description: 'View account information.',
        resource: 'urn:new-api:dashboard',
        sensitive: false,
        min_role: 1,
      },
      {
        scope: 'wallet:write',
        label: 'Manage account wallet',
        description: 'Use account balance.',
        resource: 'urn:new-api:dashboard',
        sensitive: true,
        min_role: 1,
      },
    ],
  }
}

function apiResponse(config: InternalAxiosRequestConfig, data: unknown) {
  return { config, data, status: 200, statusText: 'OK', headers: {} }
}

function renderScreen(params: AuthorizeSearchParams = baseParams) {
  return render(
    <QueryClientProvider client={client}>
      <AuthorizeScreen {...params} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.getState().auth.setUser({ id: 1, username: 'alice', role: 1 })
  replaceMock.mockClear()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, replace: replaceMock },
  })
})

afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  })
  vi.restoreAllMocks()
})

test('shows OAuth errors without loading consent or displaying untrusted diagnostic details', () => {
  const adapter = vi.fn()
  api.defaults.adapter = adapter
  renderScreen({
    ...baseParams,
    error: 'invalid_request',
    error_description: '<img src=x onerror=alert(1)>',
  })
  expect(screen.getByText('Authorization failed')).toBeVisible()
  expect(screen.queryByText(/onerror/)).not.toBeInTheDocument()
  expect(adapter).not.toHaveBeenCalled()
})

test('asks signed-out visitors to sign in without loading consent', () => {
  useAuthStore.getState().auth.reset()
  const adapter = vi.fn()
  api.defaults.adapter = adapter
  renderScreen()
  expect(screen.getByText('Sign in to continue')).toBeVisible()
  expect(adapter).not.toHaveBeenCalled()
})

test('approves the displayed full snapshot with its single-use token and resource list', async () => {
  const posts: unknown[] = []
  api.defaults.adapter = async (config) => {
    if (config.method === 'get') {
      const query = new URL(config.url || '', 'https://new-api.example')
        .searchParams
      expect(query.getAll('resource')).toEqual(baseParams.resource)
      return apiResponse(config, preview())
    }
    posts.push(JSON.parse(config.data))
    return apiResponse(config, {
      success: true,
      redirect:
        'https://rp.example.com/cb?code=abc&state=st4te&iss=https%3A%2F%2Fnew-api.example',
    })
  }
  renderScreen()
  await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(replaceMock).toHaveBeenCalledWith(
      'https://rp.example.com/cb?code=abc&state=st4te&iss=https%3A%2F%2Fnew-api.example'
    )
  )
  expect(posts).toEqual([
    expect.objectContaining({
      approve: true,
      scope: 'full',
      selected_scopes: ['openid', 'profile:read', 'wallet:write'],
      consent_token: 'single-use-consent',
      resources: baseParams.resource,
    }),
  ])
  expect(screen.getByText('Authorization complete')).toBeVisible()
})

test('lets keyboard users reduce permissions and removes the sensitive warning when deselected', async () => {
  const posts: unknown[] = []
  api.defaults.adapter = async (config) => {
    if (config.method === 'get') return apiResponse(config, preview())
    posts.push(JSON.parse(config.data))
    return apiResponse(config, {
      success: true,
      redirect: 'https://rp.example.com/cb?code=abc&state=st4te',
    })
  }
  renderScreen()
  const sensitive = await screen.findByRole('checkbox', {
    name: 'Manage account wallet Sensitive',
  })
  expect(screen.getByText('Sensitive permissions selected')).toBeVisible()
  sensitive.focus()
  await userEvent.keyboard('[Space]')
  expect(sensitive).not.toBeChecked()
  expect(
    screen.queryByText('Sensitive permissions selected')
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('checkbox', { name: 'Select all requested permissions' })
  ).toBePartiallyChecked()
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(posts).toEqual([
      expect.objectContaining({ selected_scopes: ['openid', 'profile:read'] }),
    ])
  )
})

test('disables approval for an empty selection and restores the displayed snapshot with select all', async () => {
  api.defaults.adapter = async (config) => apiResponse(config, preview())
  renderScreen()
  const selectAll = await screen.findByRole('checkbox', {
    name: 'Select all requested permissions',
  })
  await userEvent.click(selectAll)
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
  await userEvent.click(selectAll)
  expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  expect(
    screen.getByRole('checkbox', { name: 'Manage account wallet Sensitive' })
  ).toBeChecked()
})

test('denies with no selected permissions and never displays a success heading', async () => {
  const posts: unknown[] = []
  api.defaults.adapter = async (config) => {
    if (config.method === 'get') return apiResponse(config, preview())
    posts.push(JSON.parse(config.data))
    return apiResponse(config, {
      success: true,
      redirect: 'https://rp.example.com/cb?error=access_denied&state=st4te',
    })
  }
  renderScreen()
  await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))
  await waitFor(() =>
    expect(replaceMock).toHaveBeenCalledWith(
      'https://rp.example.com/cb?error=access_denied&state=st4te'
    )
  )
  expect(posts).toEqual([
    expect.objectContaining({ approve: false, selected_scopes: [] }),
  ])
  expect(screen.getByText('Authorization denied')).toBeVisible()
  expect(screen.queryByText('Authorization complete')).not.toBeInTheDocument()
})

test('escapes long application metadata and omits unsafe application links', async () => {
  api.defaults.adapter = async (config) =>
    apiResponse(config, {
      ...preview(),
      client: {
        name: `<script>alert(1)</script>${'long'.repeat(100)}`,
        description: '<img src=x onerror=alert(1)>',
        uri: 'javascript:alert(1)',
      },
    })
  const view = renderScreen()
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible()
  expect(view.container.querySelector('img, script')).toBeNull()
  expect(
    screen
      .getByText('<img src=x onerror=alert(1)>')
      .closest('[data-slot=card-header]')
  ).toHaveClass('min-w-0', 'grid-cols-[minmax(0,1fr)]')
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(
    screen.getByText('Application address: https://rp.example.com')
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
})

test.each(['business', 'http'])(
  'hides %s failure details and never leaves an actionable stale request',
  async (kind) => {
    const errorToast = vi.spyOn(toast, 'error')
    api.defaults.adapter = async (config) => {
      const response = apiResponse(config, {
        success: false,
        message: 'PRIVATE database stack trace',
      })
      if (kind === 'http') {
        throw new AxiosError(
          'PRIVATE server failure',
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          { ...response, status: 503 }
        )
      }
      return response
    }
    renderScreen()
    expect(
      await screen.findByText('Failed to load authorization request')
    ).toBeVisible()
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Approve' })
    ).not.toBeInTheDocument()
    expect(errorToast).not.toHaveBeenCalled()
    expect(replaceMock).not.toHaveBeenCalled()
  }
)

test('refreshes a failed single-use transaction and requires reviewing it again', async () => {
  let getCount = 0
  api.defaults.adapter = async (config) => {
    if (config.method === 'get') {
      getCount += 1
      return apiResponse(config, {
        ...preview(),
        consent_token: `transaction-${getCount}`,
      })
    }
    return apiResponse(config, {
      success: false,
      message: 'PRIVATE failed transaction',
    })
  }
  renderScreen()
  await userEvent.click(
    await screen.findByRole('checkbox', {
      name: 'Manage account wallet Sensitive',
    })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
  expect(
    await screen.findByText(
      'The request has been refreshed. Review the permissions before trying again.'
    )
  ).toBeVisible()
  expect(getCount).toBe(2)
  expect(
    screen.getByRole('checkbox', { name: 'Manage account wallet Sensitive' })
  ).not.toBeChecked()
  expect(replaceMock).not.toHaveBeenCalled()
  expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
})

test('rejects unsafe successful redirects and obtains a new transaction', async () => {
  api.defaults.adapter = async (config) =>
    apiResponse(
      config,
      config.method === 'get'
        ? preview()
        : { success: true, redirect: 'javascript:alert(1)' }
    )
  renderScreen()
  await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  expect(
    await screen.findByText('Failed to process authorization')
  ).toBeVisible()
  expect(replaceMock).not.toHaveBeenCalled()
})

test('ignores an old consent POST after the browser switches to another authorization request', async () => {
  let finishPost: ((value: ReturnType<typeof apiResponse>) => void) | undefined
  let postConfig: InternalAxiosRequestConfig | undefined
  api.defaults.adapter = async (config) => {
    if (config.method === 'get') {
      const second = config.url?.includes('second-client')
      return apiResponse(config, {
        ...preview(),
        client: { name: second ? 'Second client' : 'Test RP', description: '' },
      })
    }
    postConfig = config
    return new Promise((resolve) => {
      finishPost = resolve
    })
  }
  const view = renderScreen()
  await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
  view.rerender(
    <QueryClientProvider client={client}>
      <AuthorizeScreen {...baseParams} client_id='second-client' />
    </QueryClientProvider>
  )
  expect(await screen.findByText(/Second client/)).toBeVisible()
  await act(async () => {
    if (finishPost && postConfig) {
      finishPost(
        apiResponse(postConfig, {
          success: true,
          redirect: 'https://rp.example.com/cb?code=old&state=st4te',
        })
      )
    }
  })
  expect(replaceMock).not.toHaveBeenCalled()
  expect(screen.getByText(/Second client/)).toBeVisible()
})

test('clears authorization controls immediately when the signed-in account disappears', async () => {
  api.defaults.adapter = async (config) => apiResponse(config, preview())
  renderScreen()
  await screen.findByRole('button', { name: 'Approve' })
  act(() => useAuthStore.getState().auth.reset())
  expect(screen.getByText('Sign in to continue')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Approve' })
  ).not.toBeInTheDocument()
})

test('rejects a preview redirect without a user decision', async () => {
  api.defaults.adapter = async (config) =>
    apiResponse(config, {
      success: true,
      require_consent: false,
      redirect: 'https://rp.example.com/cb?code=unapproved&state=st4te',
    })
  renderScreen()
  expect(
    await screen.findByText('Failed to load authorization request')
  ).toBeVisible()
  expect(replaceMock).not.toHaveBeenCalled()
})

test.each([
  { scopes: [] },
  { consent_token: undefined },
  { scopes: ['full'] },
  { capabilities: [{ scope: 'openid', label: 'Sign in' }] },
  { capabilities: [] },
  { resources: [] },
])(
  'fails closed when the consent snapshot is incomplete: %j',
  async (override) => {
    api.defaults.adapter = async (config) =>
      apiResponse(config, { ...preview(), ...override })
    renderScreen()
    expect(
      await screen.findByText('Failed to load authorization request')
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Approve' })
    ).not.toBeInTheDocument()
  }
)

test('ignores an old consent GET after a new request has loaded', async () => {
  let finishOld: ((value: ReturnType<typeof apiResponse>) => void) | undefined
  let oldConfig: InternalAxiosRequestConfig | undefined
  api.defaults.adapter = async (config) => {
    if (config.url?.includes('second-client')) {
      return apiResponse(config, {
        ...preview(),
        client: { name: 'Second client', description: '' },
      })
    }
    oldConfig = config
    return new Promise((resolve) => {
      finishOld = resolve
    })
  }
  const view = renderScreen()
  await waitFor(() => expect(oldConfig).toBeDefined())
  view.rerender(
    <QueryClientProvider client={client}>
      <AuthorizeScreen {...baseParams} client_id='second-client' />
    </QueryClientProvider>
  )
  expect(await screen.findByText(/Second client/)).toBeVisible()
  await act(async () => {
    if (finishOld && oldConfig) finishOld(apiResponse(oldConfig, preview()))
  })
  expect(screen.queryByText(/Test RP/)).not.toBeInTheDocument()
  expect(screen.getByText(/Second client/)).toBeVisible()
  expect(replaceMock).not.toHaveBeenCalled()
})
