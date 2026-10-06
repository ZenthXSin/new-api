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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { StrictMode } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { OAuthProviders } from '@/features/auth/components/oauth-providers'
import {
  consumeOAuthLoginRedirect,
  markOAuthBindPopup,
  rememberOAuthLoginRedirect,
} from '@/features/auth/lib/oauth-callback-mode'
import type { SystemStatus } from '@/features/auth/types'
import { api } from '@/lib/api'
import { parseRouterSearch, stringifyRouterSearch } from '@/lib/router-search'
import { Route as OAuthRoute } from '@/routes/oauth/$provider'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

const authorizationPath =
  '/authorize?client_id=external-app&state=client-state&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback'
const hostedPath = '/oauth-actions/action-id?state=hosted-state'
const providerState = 'provider-state'
const bundle: AuthBundle = {
  access_token: 'test-session-token',
  token_type: 'Bearer',
  access_expires_at: 2000000000,
  user: { id: 7, username: 'alice', role: 1 },
  session: {
    sid: 'test-session',
    current: true,
    login_method: 'oauth',
    ip: '127.0.0.1',
    user_agent: 'test-browser',
    created_at: 1900000000,
    last_active_at: 1900000000,
    expires_at: 2000000000,
  },
}
const status: SystemStatus = {
  github_oauth: true,
  github_client_id: 'github-client',
  discord_oauth: true,
  discord_client_id: 'discord-client',
  oidc_enabled: true,
  oidc_client_id: 'oidc-client',
  oidc_authorization_endpoint: 'https://identity.example/authorize',
  linuxdo_oauth: true,
  linuxdo_client_id: 'linuxdo-client',
  custom_oauth_providers: [
    {
      id: 1,
      name: 'Example Identity',
      slug: 'example-identity',
      icon: '',
      client_id: 'custom-client',
      authorization_endpoint: 'https://custom.example/authorize',
      scopes: 'openid profile',
    },
  ],
}

const originalAdapter = api.defaults.adapter
const requests: InternalAxiosRequestConfig[] = []
let callbackFailure: 'business' | 'http' | null
let pendingCallback: Promise<void> | null

async function renderOAuth(initialEntry: string, target = authorizationPath) {
  const rootRoute = createRootRoute({ component: Outlet })
  const callbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/oauth/$provider',
    component: OAuthRoute.options.component,
  })
  const signInRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sign-in',
    component: () => <OAuthProviders status={status} redirectTo={target} />,
  })
  const authorizeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/authorize',
    component: () => <h1>Authorization request</h1>,
  })
  const hostedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/oauth-actions/$action',
    component: () => <h1>Hosted action</h1>,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <h1>Dashboard</h1>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      callbackRoute,
      signInRoute,
      authorizeRoute,
      hostedRoute,
      dashboardRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPendingMinMs: 0,
    parseSearch: parseRouterSearch,
    stringifySearch: stringifyRouterSearch,
  })
  await router.load()
  const view = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  )
  return { router, ...view }
}

beforeEach(() => {
  sessionStorage.clear()
  useAuthStore.getState().auth.reset()
  requests.length = 0
  callbackFailure = null
  pendingCallback = null
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  vi.spyOn(toast, 'success').mockReturnValue('success-toast')
  vi.spyOn(toast, 'error').mockReturnValue('error-toast')
  api.defaults.adapter = async (config) => {
    requests.push(config)
    const response = { config, status: 200, statusText: 'OK', headers: {} }
    if (config.url === '/api/user/auth/logout') {
      return { ...response, data: { success: true } }
    }
    if (config.url === '/api/oauth/state') {
      return {
        ...response,
        data: { success: true, data: { flow_token: providerState } },
      }
    }
    if (config.url?.startsWith('/api/oauth/')) {
      await pendingCallback
      if (callbackFailure === 'http') {
        throw new AxiosError(
          'raw-provider-secret',
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          {
            ...response,
            status: 503,
            data: { message: 'raw-provider-secret' },
          }
        )
      }
      if (callbackFailure === 'business') {
        return {
          ...response,
          data: { success: false, message: 'raw-provider-secret' },
        }
      }
      return { ...response, data: { success: true, data: bundle } }
    }
    throw new Error(`Unexpected authentication request: ${config.url}`)
  }
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('external provider login return destination', () => {
  test.each([
    ['github', 'GitHub'],
    ['discord', 'Discord'],
    ['oidc', 'OIDC'],
    ['linuxdo', 'LinuxDO'],
    ['example-identity', 'Example Identity'],
  ])(
    '%s returns to the OAuth consent page after the provider round trip',
    async (provider, label) => {
      const { router } = await renderOAuth('/sign-in')
      await userEvent.click(
        screen.getByRole('button', {
          name: new RegExp(`Continue with ${label}$`),
        })
      )
      await waitFor(() => expect(window.open).toHaveBeenCalled())
      const openedURL = String(vi.mocked(window.open).mock.calls[0]?.[0])
      expect(new URL(openedURL).searchParams.get('state')).toBe(providerState)
      expect(openedURL).not.toContain('external-app')

      await act(async () => {
        await router.navigate({
          href: `/oauth/${provider}?code=provider-code&state=${providerState}`,
        })
      })

      await screen.findByRole('heading', { name: 'Authorization request' })
      expect(router.state.location.href).toBe(authorizationPath)
      expect(useAuthStore.getState().auth.user?.id).toBe(bundle.user.id)
      expect(consumeOAuthLoginRedirect(provider, providerState)).toBeNull()
      expect(
        requests.filter((request) => request.url === `/api/oauth/${provider}`)
      ).toHaveLength(1)
    }
  )

  test('a hosted action survives the provider redirect and ignores an injected callback redirect', async () => {
    rememberOAuthLoginRedirect('github', providerState, hostedPath)
    const { router } = await renderOAuth(
      `/oauth/github?code=provider-code&state=${providerState}&redirect=%2Fauthorize%3Fclient_id%3Dattacker`
    )

    await screen.findByRole('heading', { name: 'Hosted action' })
    expect(router.state.location.href).toBe(hostedPath)
  })

  test('a callback without a matching local return marker uses the dashboard', async () => {
    rememberOAuthLoginRedirect('oidc', providerState, authorizationPath)
    const { router } = await renderOAuth(
      `/oauth/github?code=provider-code&state=${providerState}&redirect=https%3A%2F%2Fattacker.example`
    )

    await screen.findByRole('heading', { name: 'Dashboard' })
    expect(router.state.location.href).toBe('/dashboard')
    expect(consumeOAuthLoginRedirect('oidc', providerState)).toBe(
      authorizationPath
    )
  })

  test.each(['business', 'http'] as const)(
    '%s failure returns to sign-in with the original destination and a safe message',
    async (failure) => {
      callbackFailure = failure
      rememberOAuthLoginRedirect('github', providerState, authorizationPath)
      const { router } = await renderOAuth(
        `/oauth/github?code=provider-code&state=${providerState}`
      )

      await screen.findByRole('button', { name: /Continue with GitHub$/ })
      expect(router.state.location.search).toEqual({
        redirect: authorizationPath,
      })
      expect(useAuthStore.getState().auth.user).toBeNull()
      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(toast.error).toHaveBeenCalledWith('OAuth failed')
      expect(
        requests.filter((request) => request.url === '/api/oauth/github')
      ).toHaveLength(1)
    }
  )

  test('provider rejection preserves the return destination when the user tries login again', async () => {
    callbackFailure = 'business'
    rememberOAuthLoginRedirect('github', providerState, authorizationPath)
    const { router } = await renderOAuth(
      `/oauth/github?error=access_denied&state=${providerState}`
    )

    await screen.findByRole('button', { name: /Continue with GitHub$/ })
    expect(router.state.location.search).toEqual({
      redirect: authorizationPath,
    })
  })

  test('a callback missing state cannot exchange a code or adopt an injected destination', async () => {
    const { router } = await renderOAuth(
      '/oauth/github?code=provider-code&redirect=%2Fauthorize'
    )

    await screen.findByRole('button', { name: /Continue with GitHub$/ })
    expect(requests).toEqual([])
    expect(router.state.location.href).toBe('/sign-in')
  })

  test.each([
    '123',
    'true',
    'null',
    '"quoted-state"',
    ' state with whitespace ',
  ])(
    'opaque OAuth code and state %s survive router parsing without alteration',
    async (state) => {
      rememberOAuthLoginRedirect('github', state, authorizationPath)
      const params = new URLSearchParams({ code: state, state })
      await renderOAuth(`/oauth/github?${params.toString()}`)

      await screen.findByRole('heading', { name: 'Authorization request' })
      expect(requests[0]?.params).toMatchObject({ code: state, state })
    }
  )

  test.each([
    'code=one&code=two&state=provider-state',
    'code=one&state=first&state=second',
    'code=one&state=provider-state&error=access_denied',
  ])(
    'ambiguous callback parameters %s fail without exchanging a code',
    async (params) => {
      const { router } = await renderOAuth(`/oauth/github?${params}`)

      await screen.findByRole('button', { name: /Continue with GitHub$/ })
      expect(requests).toEqual([])
      expect(router.state.location.href).toBe('/sign-in')
    }
  )

  test('a late callback cannot replace a different session started while it was pending', async () => {
    let finishCallback: () => void = () => undefined
    pendingCallback = new Promise<void>((resolve) => {
      finishCallback = resolve
    })
    rememberOAuthLoginRedirect('github', providerState, authorizationPath)
    const { router } = await renderOAuth(
      `/oauth/github?code=provider-code&state=${providerState}`
    )
    await waitFor(() => expect(requests).toHaveLength(1))
    const newSession = {
      ...bundle,
      user: { id: 8, username: 'bob', role: 1 },
      session: { ...bundle.session, sid: 'different-session' },
    }

    await act(async () => {
      useAuthStore.getState().auth.setBundle(newSession)
      finishCallback()
      await pendingCallback
    })

    expect(useAuthStore.getState().auth.user?.id).toBe(8)
    expect(router.state.location.pathname).toBe('/oauth/github')
    expect(toast.success).not.toHaveBeenCalled()
  })

  test('a binding popup does not consume the normal login return destination', async () => {
    const opener = { closed: false, postMessage: vi.fn() }
    const originalOpener = window.opener
    Object.defineProperty(window, 'opener', {
      configurable: true,
      value: opener,
    })
    rememberOAuthLoginRedirect('github', providerState, authorizationPath)
    markOAuthBindPopup(sessionStorage, 'github', providerState)
    try {
      await renderOAuth(
        `/oauth/github?code=provider-code&state=${providerState}`
      )

      await screen.findByRole('heading', {
        name: 'Binding your GitHub account',
      })
      expect(requests).toEqual([])
      expect(opener.postMessage).toHaveBeenCalled()
      expect(consumeOAuthLoginRedirect('github', providerState)).toBe(
        authorizationPath
      )
    } finally {
      Object.defineProperty(window, 'opener', {
        configurable: true,
        value: originalOpener,
      })
    }
  })
})
