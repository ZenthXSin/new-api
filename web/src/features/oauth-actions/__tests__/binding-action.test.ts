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
import { waitFor } from '@testing-library/react'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  OAUTH_BIND_CALLBACK_MESSAGE,
  TELEGRAM_BIND_RESULT_MESSAGE,
} from '@/features/auth/constants'
import { resolveOAuthCallbackMode } from '@/features/auth/lib/oauth-callback-mode'
import { api } from '@/lib/api'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import {
  completeHostedTelegramBinding,
  startHostedBinding,
} from '../lib/binding-action'

const bundle: AuthBundle = {
  access_token: 'session-only-token',
  token_type: 'Bearer',
  access_expires_at: 2000000000,
  user: { id: 7, username: 'alice', role: 1 },
  session: {
    sid: 'session-a',
    current: true,
    login_method: 'password',
    ip: '127.0.0.1',
    user_agent: 'test',
    created_at: 1900000000,
    last_active_at: 1900000000,
    expires_at: 2000000000,
  },
}
const flow = { flow_token: 'one-time-binding-flow', expires_at: 2000000000 }
const telegramFlow = {
  ...flow,
  callback_url: `/api/oauth/telegram/bind/${flow.flow_token}`,
}
const authorization = {
  id: 42,
  auth_date: 1900000000,
  hash: 'signed-assertion',
  username: 'telegram-user',
}
const requests: InternalAxiosRequestConfig[] = []
const originalAdapter = api.defaults.adapter
let status: Record<string, unknown>
let failure: 'business' | 'http' | null
let waitExchange: Promise<void> | null
let popup: Window
let replace: ReturnType<typeof vi.fn>

function postResult(
  source: Window,
  data: unknown,
  origin = window.location.origin
) {
  const event = new MessageEvent('message', { origin, data })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

beforeEach(() => {
  useAuthStore.getState().auth.setBundle(bundle)
  sessionStorage.clear()
  requests.length = 0
  failure = null
  waitExchange = null
  status = { github_oauth: true, github_client_id: 'configured-client' }
  replace = vi.fn()
  popup = {
    closed: false,
    location: { replace },
    sessionStorage,
    close: vi.fn(() => {
      Object.defineProperty(popup, 'closed', {
        value: true,
        configurable: true,
      })
    }),
    postMessage: vi.fn(),
  } as unknown as Window
  vi.spyOn(window, 'open').mockReturnValue(popup)
  vi.spyOn(toast, 'error').mockReturnValue('error')
  api.defaults.adapter = async (config) => {
    requests.push(config)
    const response = { config, status: 200, statusText: 'OK', headers: {} }
    if (config.url === '/api/status') {
      return { ...response, data: { success: true, data: status } }
    }
    await waitExchange
    if (failure === 'http') {
      throw new AxiosError(
        'raw-provider-secret',
        'ERR_BAD_RESPONSE',
        config,
        undefined,
        { ...response, status: 503, data: { message: 'raw-provider-secret' } }
      )
    }
    return {
      ...response,
      data: {
        success: failure !== 'business',
        message: failure ? 'raw-provider-secret' : '',
      },
    }
  }
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('hosted provider binding', () => {
  test('only the exact popup, origin, provider and state can finish the binding', async () => {
    const promise = startHostedBinding('oauth-bind', flow, {
      provider: 'github',
    })
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(
      resolveOAuthCallbackMode('github', flow.flow_token, {
        opener: { closed: false },
        storage: sessionStorage,
      })
    ).toBe('bind')
    expect(
      new URL(String(replace.mock.calls[0]?.[0])).searchParams.get('state')
    ).toBe(flow.flow_token)
    const callback = {
      type: OAUTH_BIND_CALLBACK_MESSAGE,
      provider: 'github',
      state: flow.flow_token,
      code: 'provider-code',
    }
    postResult(window, callback)
    postResult(popup, callback, 'https://attacker.example')
    postResult(popup, { ...callback, state: 'other-flow' })
    postResult(popup, { ...callback, provider: 'oidc' })
    expect(requests.filter((request) => request.url !== '/api/status')).toEqual(
      []
    )

    postResult(popup, callback)
    postResult(popup, callback)

    await expect(promise).resolves.toEqual({ flow_token: flow.flow_token })
    const exchanges = requests.filter(
      (request) => request.url === '/api/oauth/github'
    )
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]?.headers.Authorization).toBe(
      'Bearer session-only-token'
    )
    expect(exchanges[0]?.params).toEqual({
      state: flow.flow_token,
      code: 'provider-code',
    })
    expect(popup.close).toHaveBeenCalled()
  })

  test.each(['business', 'http'] as const)(
    '%s upstream failure is private and cannot complete the action',
    async (mode) => {
      failure = mode
      const promise = startHostedBinding('oauth-bind', flow, {
        provider: 'github',
      })
      const result = expect(promise).rejects.toThrow('OAuth failed')
      await waitFor(() => expect(replace).toHaveBeenCalled())
      postResult(popup, {
        type: OAUTH_BIND_CALLBACK_MESSAGE,
        provider: 'github',
        state: flow.flow_token,
        code: 'provider-code',
      })
      await result
      expect(toast.error).not.toHaveBeenCalled()
      expect(
        JSON.stringify(vi.mocked(popup.postMessage).mock.calls)
      ).not.toContain('raw-provider-secret')
    }
  )

  test('switching sessions aborts a pending binding and ignores its late response', async () => {
    let finishExchange: () => void = () => undefined
    waitExchange = new Promise<void>((resolve) => {
      finishExchange = resolve
    })
    const promise = startHostedBinding('oauth-bind', flow, {
      provider: 'github',
    })
    const result = expect(promise).rejects.toThrow('OAuth failed')
    await waitFor(() => expect(replace).toHaveBeenCalled())
    postResult(popup, {
      type: OAUTH_BIND_CALLBACK_MESSAGE,
      provider: 'github',
      state: flow.flow_token,
      code: 'provider-code',
    })
    await waitFor(() => expect(requests).toHaveLength(2))
    useAuthStore.getState().auth.setBundle({
      ...bundle,
      session: { ...bundle.session, sid: 'session-b' },
    })
    finishExchange()
    await result
    expect(popup.postMessage).not.toHaveBeenCalled()
    expect(popup.close).toHaveBeenCalled()
  })

  test('cancelling the hosted action closes its popup before any code can be exchanged', async () => {
    const abort = new AbortController()
    const promise = startHostedBinding(
      'oauth-bind',
      flow,
      { provider: 'github' },
      abort.signal
    )
    const result = expect(promise).rejects.toThrow('OAuth failed')
    await waitFor(() => expect(replace).toHaveBeenCalled())
    abort.abort()
    postResult(popup, {
      type: OAUTH_BIND_CALLBACK_MESSAGE,
      provider: 'github',
      state: flow.flow_token,
      code: 'provider-code',
    })
    await result
    expect(requests.filter((request) => request.url !== '/api/status')).toEqual(
      []
    )
  })

  test('provider rejection does not exchange or complete the flow', async () => {
    const promise = startHostedBinding('oauth-bind', flow, {
      provider: 'github',
    })
    const result = expect(promise).rejects.toThrow('OAuth failed')
    await waitFor(() => expect(replace).toHaveBeenCalled())
    postResult(popup, {
      type: OAUTH_BIND_CALLBACK_MESSAGE,
      provider: 'github',
      state: flow.flow_token,
      error: 'access_denied',
    })
    await result
    expect(requests).toHaveLength(1)
  })

  test('custom provider configuration opens the registered HTTPS endpoint', async () => {
    status = {
      custom_oauth_providers: [
        {
          slug: 'example',
          client_id: 'example-client',
          authorization_endpoint: 'https://identity.example/authorize',
          scopes: 'openid profile',
        },
      ],
    }
    const promise = startHostedBinding('oauth-bind', flow, {
      provider: 'example',
    })
    await waitFor(() => expect(replace).toHaveBeenCalled())
    const url = new URL(String(replace.mock.calls[0]?.[0]))
    expect(url.origin).toBe('https://identity.example')
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${window.location.origin}/oauth/example`
    )
    postResult(popup, {
      type: OAUTH_BIND_CALLBACK_MESSAGE,
      provider: 'example',
      state: flow.flow_token,
      code: 'provider-code',
    })
    await expect(promise).resolves.toEqual({ flow_token: flow.flow_token })
  })

  test('a malicious provider URL cannot navigate the popup', async () => {
    status = {
      custom_oauth_providers: [
        {
          slug: 'example',
          client_id: 'example-client',
          authorization_endpoint: 'javascript:alert(1)',
        },
      ],
    }
    await expect(
      startHostedBinding('oauth-bind', flow, { provider: 'example' })
    ).rejects.toThrow('OAuth failed')
    expect(replace).not.toHaveBeenCalled()
  })

  test('closing the authorization popup stops the pending operation', async () => {
    vi.useFakeTimers()
    const promise = startHostedBinding('oauth-bind', flow, {
      provider: 'github',
    })
    const result = expect(promise).rejects.toThrow('OAuth failed')
    popup.close()
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(requests.filter((request) => request.url !== '/api/status')).toEqual(
      []
    )
  })

  test('a blocked popup or expired flow is a recoverable failure', async () => {
    vi.mocked(window.open).mockReturnValue(null)
    await expect(
      startHostedBinding('oauth-bind', flow, { provider: 'github' })
    ).rejects.toThrow()
    await expect(
      startHostedBinding(
        'oauth-bind',
        { ...flow, expires_at: 1 },
        { provider: 'github' }
      )
    ).rejects.toThrow()
    expect(requests).toEqual([])
  })
})

describe('hosted Telegram binding', () => {
  test('a signed widget result goes only to the exact same-origin flow and requires a matching callback', async () => {
    const promise = completeHostedTelegramBinding(
      telegramFlow,
      authorization,
      popup
    )
    expect(replace).toHaveBeenCalledTimes(1)
    const url = new URL(String(replace.mock.calls[0]?.[0]))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe(telegramFlow.callback_url)
    expect(url.searchParams.get('hash')).toBe(authorization.hash)
    const callback = {
      type: TELEGRAM_BIND_RESULT_MESSAGE,
      flow_token: flow.flow_token,
      success: true,
    }
    postResult(window, callback)
    postResult(popup, callback, 'https://attacker.example')
    postResult(popup, { ...callback, flow_token: 'other-flow' })
    expect(popup.close).not.toHaveBeenCalled()
    postResult(popup, callback)
    await expect(promise).resolves.toEqual({ flow_token: flow.flow_token })
    expect(sessionStorage.length).toBe(0)
  })

  test('a forged callback URL cannot receive the signed Telegram assertion', async () => {
    await expect(
      completeHostedTelegramBinding(
        { ...telegramFlow, callback_url: 'https://attacker.example/bind' },
        authorization,
        popup
      )
    ).rejects.toThrow('OAuth failed')
    expect(replace).not.toHaveBeenCalled()
  })

  test('an expired Telegram binding stops waiting at its server expiry', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T12:00:00Z') })
    const expires = Math.floor(Date.now() / 1000) + 1
    const promise = completeHostedTelegramBinding(
      { ...telegramFlow, expires_at: expires },
      authorization,
      popup
    )
    const result = expect(promise).rejects.toThrow('OAuth failed')
    await vi.advanceTimersByTimeAsync(999)
    expect(popup.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(popup.close).toHaveBeenCalled()
  })

  test('cancellation removes Telegram completion listeners and closes the popup', async () => {
    const abort = new AbortController()
    const promise = completeHostedTelegramBinding(
      telegramFlow,
      authorization,
      popup,
      abort.signal
    )
    const result = expect(promise).rejects.toThrow('OAuth failed')
    abort.abort()
    postResult(popup, {
      type: TELEGRAM_BIND_RESULT_MESSAGE,
      flow_token: flow.flow_token,
      success: true,
    })
    await result
    expect(popup.close).toHaveBeenCalled()
  })
})
