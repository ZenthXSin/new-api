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
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { Otp } from '@/features/auth/otp'
import { SignIn } from '@/features/auth/sign-in'
import { api } from '@/lib/api'
import { Route as OtpRoute } from '@/routes/(auth)/otp'
import { Route as SignInRoute } from '@/routes/(auth)/sign-in'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

const authorizationPath =
  '/authorize?client_id=example-app&state=opaque-state&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback'
const bundle: AuthBundle = {
  access_token: 'test-session-token',
  token_type: 'Bearer',
  access_expires_at: 2000000000,
  user: { id: 7, username: 'alice', role: 1 },
  session: {
    sid: 'test-session',
    current: true,
    login_method: 'password_2fa',
    ip: '127.0.0.1',
    user_agent: 'test-browser',
    created_at: 1900000000,
    last_active_at: 1900000000,
    expires_at: 2000000000,
  },
}

const originalAdapter = api.defaults.adapter
const requests: Array<{ url: string; data: unknown }> = []
let queryClient: QueryClient
let rejectNextOTP = false

async function renderAuthentication(initialEntry: string) {
  const rootRoute = createRootRoute({ component: Outlet })
  const authRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '(auth)',
    component: Outlet,
  })
  const signInRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/sign-in',
    validateSearch: SignInRoute.options.validateSearch,
    component: SignIn,
  })
  const otpRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/otp',
    validateSearch: OtpRoute.options.validateSearch,
    component: Otp,
  })
  const authorizeRoute = createRoute({
    getParentRoute: () => authRoute,
    path: '/authorize',
    component: () => <h1>Authorization request</h1>,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <h1>Dashboard</h1>,
  })
  const routeTree = rootRoute.addChildren([
    authRoute.addChildren([signInRoute, otpRoute, authorizeRoute]),
    dashboardRoute,
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPendingMinMs: 0,
  })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return router
}

async function submitPassword() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Username or Email'), 'alice')
  await user.type(screen.getByLabelText('Password'), 'correct-password')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByRole('heading', { name: 'Two-factor Authentication' })
  return user
}

async function submitOTP() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Verification Code' }), {
    target: { value: '123456' },
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Verify and Sign In' })
  )
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  localStorage.clear()
  sessionStorage.clear()
  useAuthStore.getState().auth.reset()
  requests.length = 0
  rejectNextOTP = false
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  queryClient.setQueryData(['status'], {
    password_login_enabled: true,
    register_enabled: false,
  })
  api.defaults.adapter = async (config) => {
    const data: unknown = config.data
      ? JSON.parse(String(config.data))
      : undefined
    requests.push({ url: config.url ?? '', data })
    let responseData: unknown
    let success = true
    if (config.url === '/api/user/login?turnstile=') {
      responseData = { require_2fa: true, flow_token: 'test-pending-flow' }
    } else if (config.url === '/api/user/login/2fa') {
      success = !rejectNextOTP
      rejectNextOTP = false
      responseData = success ? bundle : undefined
    } else {
      throw new Error(`Unexpected authentication request: ${config.url}`)
    }
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success, data: responseData },
    }
  }
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  queryClient.clear()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  sessionStorage.clear()
})

describe('two-factor login return destination', () => {
  test('password and authenticator login return to the original OAuth request', async () => {
    const router = await renderAuthentication(
      `/sign-in?redirect=${encodeURIComponent(authorizationPath)}`
    )
    await submitPassword()
    expect(router.state.location.search).toEqual({
      redirect: authorizationPath,
    })
    expect(useAuthStore.getState().auth.user).toBeNull()
    expect(useAuthStore.getState().auth.accessToken).toBeNull()

    await submitOTP()

    await screen.findByRole('heading', { name: 'Authorization request' })
    expect(router.state.location.href).toBe(authorizationPath)
    expect(
      requests.find((request) => request.url === '/api/user/login/2fa')?.data
    ).toEqual({ code: '123456', flow_token: 'test-pending-flow' })
    expect(useAuthStore.getState().auth.pending2FAFlowToken).toBeNull()
  })

  test('backup-code login returns to the original OAuth request', async () => {
    const router = await renderAuthentication(
      `/otp?redirect=${encodeURIComponent(authorizationPath)}`
    )
    useAuthStore.getState().auth.setPending2FAFlowToken('test-pending-flow')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Use backup code' }))
    await user.type(screen.getByLabelText('Backup Code'), 'ABCD1234')
    await user.click(screen.getByRole('button', { name: 'Verify and Sign In' }))

    await screen.findByRole('heading', { name: 'Authorization request' })
    expect(router.state.location.href).toBe(authorizationPath)
    expect(
      requests.find((request) => request.url === '/api/user/login/2fa')?.data
    ).toEqual({ code: 'ABCD1234', flow_token: 'test-pending-flow' })
  })

  test('a rejected second factor preserves the destination for a successful retry', async () => {
    const router = await renderAuthentication(
      `/otp?redirect=${encodeURIComponent(authorizationPath)}`
    )
    useAuthStore.getState().auth.setPending2FAFlowToken('test-pending-flow')
    rejectNextOTP = true
    await submitOTP()

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(
      screen.getByRole('heading', { name: 'Two-factor Authentication' })
    ).toBeVisible()
    expect(router.state.location.search).toEqual({
      redirect: authorizationPath,
    })
    expect(useAuthStore.getState().auth.user).toBeNull()

    await submitOTP()

    await screen.findByRole('heading', { name: 'Authorization request' })
    expect(router.state.location.href).toBe(authorizationPath)
  })

  test.each(['Back to login', 'Re-login'])(
    '%s keeps the original OAuth destination when restarting login',
    async (label) => {
      const router = await renderAuthentication(
        `/otp?redirect=${encodeURIComponent(authorizationPath)}`
      )
      await userEvent.click(
        screen.getByRole(label === 'Re-login' ? 'link' : 'button', {
          name: label,
        })
      )

      await screen.findByRole('button', { name: 'Sign in' })
      expect(router.state.location.search).toEqual({
        redirect: authorizationPath,
      })
    }
  )

  test('an expired pending flow returns to sign-in with its OAuth destination', async () => {
    const router = await renderAuthentication(
      `/otp?redirect=${encodeURIComponent(authorizationPath)}`
    )
    await submitOTP()

    await screen.findByRole('button', { name: 'Sign in' })
    expect(router.state.location.search).toEqual({
      redirect: authorizationPath,
    })
    expect(requests).toEqual([])
  })

  test.each([
    'https://attacker.example/callback',
    '//attacker.example/callback',
    'javascript:alert(1)',
  ])(
    'rejects unsafe destination %s before the OTP page and returns to dashboard',
    async (target) => {
      const router = await renderAuthentication(
        `/sign-in?redirect=${encodeURIComponent(target)}`
      )
      await submitPassword()
      expect(router.state.location.search).toEqual({})

      await submitOTP()

      await screen.findByRole('heading', { name: 'Dashboard' })
      expect(router.state.location.href).toBe('/dashboard')
    }
  )

  test('a forged OTP redirect is rejected after successful authentication', async () => {
    const router = await renderAuthentication(
      '/otp?redirect=javascript%3Aalert(1)'
    )
    useAuthStore.getState().auth.setPending2FAFlowToken('test-pending-flow')
    await submitOTP()

    await screen.findByRole('heading', { name: 'Dashboard' })
    await waitFor(() => expect(router.state.location.href).toBe('/dashboard'))
  })
})
