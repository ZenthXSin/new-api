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
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import { getHostedActionApproval, executeHostedActionStep } from '../api'
import { HostedOAuthAction } from '../index'
import type { HostedActionApproval } from '../types'

let client: QueryClient
const originalAdapter = api.defaults.adapter
const identity = { userID: 7, sessionID: 'session-one' }
const requestID = 'action-one'

function bundle(userID = 7, sid = 'session-one'): AuthBundle {
  return {
    access_token: 'panel-token',
    token_type: 'Bearer',
    access_expires_at: 9999999999,
    user: { id: userID, username: `account-${userID}`, role: 100 },
    session: {
      sid,
      current: true,
      login_method: 'password',
      ip: '',
      user_agent: '',
      created_at: 1,
      last_active_at: 1,
      expires_at: 9999999999,
    },
  }
}
function approval(
  overrides: Partial<HostedActionApproval> = {}
): HostedActionApproval {
  return {
    action_id: requestID,
    client_name: '<img src=x onerror=alert(1)> App',
    operation: 'apikey.reveal',
    label: 'Reveal an API key',
    status: 'pending',
    expires_at: 9999999999,
    parameters: { id: 123 },
    current_step_id: 'execute',
    approval_nonce: 'nonce-one',
    has_two_factor: false,
    share_result: false,
    steps: [
      {
        id: 'execute',
        label: 'Reveal API key',
        method: 'POST',
        path: '/api/token/123/key',
        fields: [],
        state: 'pending',
      },
    ],
    ...overrides,
  }
}
function response(config: InternalAxiosRequestConfig, data: unknown) {
  return { config, data, headers: {}, status: 200, statusText: 'OK' }
}
function renderPage() {
  return render(
    <QueryClientProvider client={client}>
      <HostedOAuthAction actionID={requestID} />
    </QueryClientProvider>
  )
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  useAuthStore.getState().auth.setBundle(bundle())
})
afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  localStorage.clear()
})

test('shows the app, account and immutable target before password approval and reveals output only on demand', async () => {
  const user = userEvent.setup()
  let approved = false
  const requests: string[] = []
  api.defaults.adapter = async (config) => {
    requests.push(config.url ?? '')
    if (config.url?.endsWith('/approval')) {
      return response(config, {
        success: true,
        data: approval({ status: approved ? 'approved' : 'pending' }),
      })
    }
    if (config.url?.endsWith('/status') || config.url === '/api/user/passkey') {
      return response(config, { success: true, data: { enabled: false } })
    }
    if (config.url?.endsWith('/approve')) {
      expect(JSON.parse(config.data)).toEqual({
        approval_nonce: 'nonce-one',
        verification_password: 'my-local-password',
      })
      expect(config.skipAuthRefresh).toBe(true)
      approved = true
      return response(config, { success: true, data: { status: 'approved' } })
    }
    expect(config.url).toBe('/api/oauth2/actions/action-one/steps/execute')
    expect(JSON.parse(config.data)).toEqual({
      approval_nonce: 'nonce-one',
      input: {},
    })
    return response(config, {
      success: true,
      data: { key: 'sk-private-value' },
      action_status: 'completed',
    })
  }
  renderPage()
  expect(
    await screen.findByText('<img src=x onerror=alert(1)> App')
  ).toBeVisible()
  expect(screen.getByText('account-7')).toBeVisible()
  expect(screen.getByText('123')).toBeVisible()
  expect(document.querySelector('img')).toBeNull()
  await user.type(
    screen.getByLabelText('Current password'),
    'my-local-password'
  )
  await user.click(screen.getByRole('button', { name: 'Approve request' }))
  await user.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(
    await screen.findByText(
      'The requested action is complete. You can return to the app.'
    )
  ).toBeVisible()
  expect(screen.queryByDisplayValue('sk-private-value')).toBeNull()
  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )
  expect(screen.getByDisplayValue('sk-private-value')).toBeVisible()
  await user.click(
    screen.getByRole('button', { name: 'Clear sensitive result' })
  )
  expect(screen.queryByDisplayValue('sk-private-value')).toBeNull()
  expect(requests.filter((url) => url.endsWith('/steps/execute'))).toHaveLength(
    1
  )
  expect(localStorage.length).toBe(0)
})

test('rejects without requesting a password or running any action step', async () => {
  const user = userEvent.setup()
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/approval')) {
      return response(config, { success: true, data: approval() })
    }
    expect(config.url).toBe('/api/oauth2/actions/action-one/reject')
    expect(JSON.parse(config.data)).toEqual({ approval_nonce: 'nonce-one' })
    return response(config, { success: true })
  }
  renderPage()
  await user.click(
    await screen.findByRole('button', { name: 'Reject request' })
  )
  expect(
    await screen.findByText(
      'You rejected this request. No further steps will run.'
    )
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
})

test('an expired request cannot be approved or executed and a malicious return URI is not linked', async () => {
  api.defaults.adapter = async (config) =>
    response(config, {
      success: true,
      data: approval({
        status: 'expired',
        expires_at: 1,
        return_uri: 'javascript:alert(1)',
      }),
    })
  renderPage()
  expect(
    await screen.findByText(
      'The request has expired. Start a new request from the app.'
    )
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Approve request' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Return to app' })).toBeNull()
})

test('sharing a credential explicitly explains the irreversible copy before approval', async () => {
  api.defaults.adapter = async (config) =>
    response(config, { success: true, data: approval({ share_result: true }) })
  renderPage()
  expect(
    await screen.findByText('This app will receive the full credential')
  ).toBeVisible()
  expect(
    screen.getByText(
      'Only approve if you trust this app. Revoking OAuth access will not remove credential copies already received by the app.'
    )
  ).toBeVisible()
})

test.each([200, 503])(
  'keeps raw server failures out of the page and global toasts for HTTP %s',
  async (status) => {
    const errorToast = vi.spyOn(toast, 'error')
    api.defaults.adapter = async (config) => {
      const res = {
        ...response(config, {
          success: false,
          message: 'RAW_PRIVATE_SERVER_VALUE',
        }),
        status,
      }
      if (status !== 200) {
        throw new AxiosError(
          'RAW_PRIVATE_SERVER_VALUE',
          'ERR_BAD_RESPONSE',
          config,
          undefined,
          res
        )
      }
      return res
    }
    renderPage()
    expect(
      await screen.findByText(
        'Unable to load this app request. Reload the page or start again from the app.'
      )
    ).toBeVisible()
    expect(screen.queryByText('RAW_PRIVATE_SERVER_VALUE')).toBeNull()
    expect(errorToast).not.toHaveBeenCalled()
  }
)

test('a late response cannot display another account action after the session changes', async () => {
  let resolveFirst: (() => void) | undefined
  api.defaults.adapter = async (config) => {
    if (config.headers.Authorization === 'Bearer panel-token') {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
    }
    return response(config, {
      success: true,
      data: approval({ client_name: 'Previous account private app' }),
    })
  }
  renderPage()
  await waitFor(() => expect(resolveFirst).toBeDefined())
  await act(async () => {
    useAuthStore.getState().auth.reset()
    resolveFirst?.()
  })
  expect(
    await screen.findByText(
      'Sign in to your account to review this app request.'
    )
  ).toBeVisible()
  expect(screen.queryByText('Previous account private app')).toBeNull()
})

test('a completed step applies a same-session auth rotation without showing its token', async () => {
  api.defaults.adapter = async (config) =>
    response(config, {
      success: true,
      data: {
        access_token: 'rotated-private-token',
        token_type: 'Bearer',
        access_expires_at: 9999999999,
        session: bundle().session,
        backup_codes: ['backup-one'],
      },
      action_status: 'completed',
    })
  const result = await executeHostedActionStep(
    requestID,
    'execute',
    'nonce-one',
    {},
    identity
  )
  expect(result.action_status).toBe('completed')
  expect(useAuthStore.getState().auth.accessToken).toBe('rotated-private-token')
})

test('a mismatched action id is rejected even if the response is successful', async () => {
  api.defaults.adapter = async (config) =>
    response(config, {
      success: true,
      data: approval({ action_id: 'another-action' }),
    })
  await expect(getHostedActionApproval(requestID, identity)).rejects.toThrow(
    'Unable to load this app request'
  )
})

test('a failed authenticator check stays in the verification dialog and never approves the request', async () => {
  const user = userEvent.setup()
  const errorToast = vi.spyOn(toast, 'error')
  const urls: string[] = []
  api.defaults.adapter = async (config) => {
    urls.push(config.url ?? '')
    if (config.url?.endsWith('/approval')) {
      return response(config, {
        success: true,
        data: approval({ has_two_factor: true }),
      })
    }
    if (config.url === '/api/user/2fa/status') {
      return response(config, { success: true, data: { enabled: true } })
    }
    if (config.url === '/api/user/passkey') {
      return response(config, { success: true, data: { enabled: false } })
    }
    expect(config.url).toBe('/api/verify')
    expect(JSON.parse(config.data)).toEqual({
      method: '2fa',
      scope: 'channel.key.read',
      code: '123456',
    })
    return response(config, {
      success: false,
      message: 'RAW_SECRET_VERIFICATION_ERROR',
    })
  }
  renderPage()
  await user.click(
    await screen.findByRole('button', { name: 'Approve request' })
  )
  await user.type(
    await screen.findByPlaceholderText('Enter verification code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: /^Verify$/ }))
  expect(
    await screen.findAllByText(
      'Verification failed or was cancelled. Please try again.'
    )
  ).not.toHaveLength(0)
  expect(screen.queryByText('RAW_SECRET_VERIFICATION_ERROR')).toBeNull()
  expect(urls.some((url) => url.endsWith('/approve'))).toBe(false)
  expect(errorToast).not.toHaveBeenCalled()
})

test('cancelling a pending verification prevents a late proof from approving the action', async () => {
  const user = userEvent.setup()
  let finishVerification: (() => void) | undefined
  let approved = false
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/approval')) {
      return response(config, {
        success: true,
        data: approval({ has_two_factor: true }),
      })
    }
    if (config.url === '/api/user/2fa/status') {
      return response(config, { success: true, data: { enabled: true } })
    }
    if (config.url === '/api/user/passkey') {
      return response(config, { success: true, data: { enabled: false } })
    }
    if (config.url === '/api/verify') {
      await new Promise<void>((resolve) => {
        finishVerification = resolve
      })
      return response(config, {
        success: true,
        data: { proof_token: 'one-proof' },
      })
    }
    approved = true
    return response(config, { success: true })
  }
  const view = renderPage()
  await user.click(
    await screen.findByRole('button', { name: 'Approve request' })
  )
  await user.type(
    await screen.findByPlaceholderText('Enter verification code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: /^Verify$/ }))
  await waitFor(() => expect(finishVerification).toBeDefined())
  view.unmount()
  await act(async () => {
    finishVerification?.()
  })
  expect(approved).toBe(false)
})

test('a refreshed MFA setup without its local secret requires a new request instead of presenting an unusable code form', async () => {
  api.defaults.adapter = async (config) =>
    response(config, {
      success: true,
      data: approval({
        status: 'approved',
        operation: 'mfa.setup',
        current_step_id: 'enable',
        steps: [
          {
            id: 'setup',
            label: 'Generate authenticator setup',
            method: 'POST',
            path: '/api/user/2fa/setup',
            fields: [],
            state: 'completed',
          },
          {
            id: 'enable',
            label: 'Confirm authenticator code',
            method: 'POST',
            path: '/api/user/2fa/enable',
            fields: [
              {
                name: 'code',
                label: 'Authenticator code',
                type: 'code',
                required: true,
              },
            ],
            state: 'pending',
          },
        ],
      }),
    })
  renderPage()
  expect(
    await screen.findByText(
      'The temporary verification data is no longer available. Start a new request from the app.'
    )
  ).toBeVisible()
  expect(screen.queryByLabelText('Authenticator code')).toBeNull()
  expect(screen.getByRole('button', { name: 'Reject request' })).toBeVisible()
})

test('a server-authorized first-factor setup asks for explicit approval without requesting nonexistent credentials', async () => {
  const user = userEvent.setup()
  let approved = false
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/approval')) {
      return response(config, {
        success: true,
        data: approval({
          operation: 'mfa.setup',
          bootstrap_allowed: true,
          bootstrap_operation: true,
          has_password: false,
          status: approved ? 'approved' : 'pending',
        }),
      })
    }
    expect(config.url).toBe('/api/oauth2/actions/action-one/approve')
    expect(JSON.parse(config.data)).toEqual({ approval_nonce: 'nonce-one' })
    approved = true
    return response(config, { success: true })
  }
  renderPage()
  expect(
    await screen.findByText(
      'Your recent sign-in allows you to set up your first verification method. Confirm that you requested this setup.'
    )
  ).toBeVisible()
  expect(screen.queryByLabelText('Current password')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Approve request' }))
  expect(await screen.findByRole('button', { name: 'Continue' })).toBeVisible()
  expect(approved).toBe(true)
})

test('data-result sharing describes the requested data without claiming a credential will be shared', async () => {
  api.defaults.adapter = async (config) =>
    response(config, {
      success: true,
      data: approval({
        operation: 'sessions.list',
        share_result: true,
        result_kind: 'data',
      }),
    })
  renderPage()
  expect(
    await screen.findByText('This app will receive the operation result.')
  ).toBeVisible()
  expect(
    screen.queryByText('This app will receive the full credential')
  ).toBeNull()
})

test('reuses the same action proof for a channel reveal instead of consuming the authenticator code twice', async () => {
  const user = userEvent.setup()
  let approved = false
  let verifyCount = 0
  api.defaults.adapter = async (config) => {
    if (config.url?.endsWith('/approval')) {
      return response(config, {
        success: true,
        data: approval({
          operation: 'channel.key.reveal',
          has_two_factor: true,
          status: approved ? 'approved' : 'pending',
          steps: [
            {
              id: 'execute',
              label: 'Reveal channel credential',
              method: 'POST',
              path: '/api/channel/123/key',
              fields: [],
              proof_scope: 'channel.key.read',
              state: 'pending',
            },
          ],
        }),
      })
    }
    if (config.url === '/api/user/2fa/status') {
      return response(config, { success: true, data: { enabled: true } })
    }
    if (config.url === '/api/user/passkey') {
      return response(config, { success: true, data: { enabled: false } })
    }
    if (config.url === '/api/verify') {
      verifyCount += 1
      return response(config, {
        success: true,
        data: { proof_token: 'verified-action-proof' },
      })
    }
    expect(config.headers['X-Security-Proof']).toBe('verified-action-proof')
    if (config.url?.endsWith('/approve')) {
      approved = true
      return response(config, { success: true })
    }
    expect(config.url).toBe('/api/oauth2/actions/action-one/steps/execute')
    return response(config, {
      success: true,
      data: { key: 'channel-credential' },
      action_status: 'completed',
    })
  }
  renderPage()
  await user.click(
    await screen.findByRole('button', { name: 'Approve request' })
  )
  await user.type(
    await screen.findByPlaceholderText('Enter verification code'),
    '123456'
  )
  await user.click(screen.getByRole('button', { name: /^Verify$/ }))
  await user.click(await screen.findByRole('button', { name: 'Continue' }))
  expect(
    await screen.findByText(
      'The requested action is complete. You can return to the app.'
    )
  ).toBeVisible()
  expect(verifyCount).toBe(1)
})
