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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { IdentityBindingHelp } from '../components/identity-binding-help'

let client: QueryClient
let publicStatus: Record<string, unknown>
let failure: 'business' | 'transport' | undefined
let failStatus: boolean
const originalAdapter = api.defaults.adapter
const originalTurnstile = window.turnstile
const requests: InternalAxiosRequestConfig[] = []
const defaultMutationError = vi.fn()
const rawSensitiveMessage = 'RAW_SENSITIVE_BACKEND_VALUE'
const email = 'fixed@example.com'

function renderHelp(
  props: {
    operation?: string
    parameters?: Record<string, unknown>
    disabled?: boolean
  } = {}
) {
  return render(
    <QueryClientProvider client={client}>
      <IdentityBindingHelp
        operation={props.operation ?? 'identity.email_bind'}
        parameters={props.parameters ?? { email }}
        disabled={props.disabled}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  useAuthStore.getState().auth.reset()
  publicStatus = {}
  failure = undefined
  failStatus = false
  requests.length = 0
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false, onError: defaultMutationError },
    },
  })
  api.defaults.adapter = async (config) => {
    requests.push(config)
    if (config.url === '/api/status' && !failStatus) {
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { success: true, data: publicStatus },
      }
    }
    if (config.url !== '/api/verification' && config.url !== '/api/status') {
      throw new Error('Unexpected URL')
    }
    const response = {
      config,
      status: failure === 'transport' || failStatus ? 503 : 200,
      statusText: 'Response',
      headers: {},
      data: {
        success: !failure && !failStatus,
        message: rawSensitiveMessage,
      },
    }
    if (response.status === 503) {
      throw new AxiosError(
        rawSensitiveMessage,
        'ERR_BAD_RESPONSE',
        config,
        null,
        response
      )
    }
    return response
  }
})

afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  window.turnstile = originalTurnstile
  useAuthStore.getState().auth.reset()
})

test('a keyboard-initiated send uses the fixed approved email and starts cooldown', async () => {
  renderHelp()
  const button = screen.getByRole('button', { name: 'Send verification code' })
  await waitFor(() => expect(button).toBeEnabled())
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText(`Email address: ${email}`)).toBeVisible()
  button.focus()
  await userEvent.keyboard('{Enter}')

  expect(await screen.findByRole('status')).toHaveTextContent(
    'Verification code sent! Please check your email.'
  )
  const sent = requests.filter((request) => request.url === '/api/verification')
  expect(sent).toHaveLength(1)
  expect(sent[0].params).toEqual({ email, turnstile: undefined })
  expect(sent[0].headers.get('Authorization')).toBeUndefined()
  expect(screen.getByRole('button', { name: 'Resend (30s)' })).toBeDisabled()
})

test('requires Turnstile, clears expired tokens, and submits a fresh token once', async () => {
  publicStatus = {
    turnstile_check: true,
    turnstile_site_key: 'public-site-key',
  }
  const renders: Record<string, unknown>[] = []
  window.turnstile = {
    render: (_element, options) => {
      renders.push(options)
    },
  }
  renderHelp()
  const button = screen.getByRole('button', { name: 'Send verification code' })
  await waitFor(() => expect(renders).toHaveLength(1))
  expect(button).toBeDisabled()
  expect(renders[0].sitekey).toBe('public-site-key')

  act(() => (renders[0].callback as (token: string) => void)('expired-token'))
  expect(button).toBeEnabled()
  act(() => (renders[0]['expired-callback'] as () => void)())
  expect(button).toBeDisabled()
  act(() => (renders[0].callback as (token: string) => void)('fresh-token'))
  await userEvent.click(button)

  await screen.findByText('Verification code sent! Please check your email.')
  const sent = requests.filter((request) => request.url === '/api/verification')
  expect(sent).toHaveLength(1)
  expect(sent[0].params).toEqual({ email, turnstile: 'fresh-token' })
  expect(screen.getByRole('button', { name: 'Resend (30s)' })).toBeDisabled()
  await waitFor(() => expect(renders).toHaveLength(2))
})

test.each(['business', 'transport'] as const)(
  'a %s error displays a generic retryable message without raw toasts or logs',
  async (mode) => {
    failure = mode
    const errorToast = vi.spyOn(toast, 'error')
    const consoleLog = vi.spyOn(console, 'log')
    renderHelp()
    const button = screen.getByRole('button', {
      name: 'Send verification code',
    })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to send verification code'
    )
    expect(document.body).not.toHaveTextContent(rawSensitiveMessage)
    expect(errorToast).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()
    expect(defaultMutationError).not.toHaveBeenCalled()
    expect(button).toBeEnabled()

    failure = undefined
    await userEvent.click(button)
    await screen.findByText('Verification code sent! Please check your email.')
  }
)

test('a public settings failure prevents email requests and can be retried safely', async () => {
  failStatus = true
  const errorToast = vi.spyOn(toast, 'error')
  renderHelp()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Failed to load settings'
  )
  expect(
    screen.getByRole('button', { name: 'Send verification code' })
  ).toBeDisabled()
  expect(
    requests.filter((request) => request.url === '/api/verification')
  ).toHaveLength(0)
  expect(document.body).not.toHaveTextContent(rawSensitiveMessage)
  expect(errorToast).not.toHaveBeenCalled()

  failStatus = false
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Send verification code' })
    ).toBeEnabled()
  )
})

test.each([
  { parameters: { email }, disabled: true },
  { parameters: { email: 'invalid-email' } },
  { parameters: {} },
])(
  'disabled or invalid email input never starts verification: %j',
  async (props) => {
    renderHelp(props)
    await waitFor(() => expect(requests).toHaveLength(1))
    const button = screen.getByRole('button', {
      name: 'Send verification code',
    })
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(
      requests.filter((request) => request.url === '/api/verification')
    ).toHaveLength(0)
  }
)

test('WeChat binding shows the configured QR code without sending the action URL as referrer', async () => {
  publicStatus = { wechat_qrcode: 'https://static.example.com/wechat.png' }
  renderHelp({ operation: 'identity.wechat_bind', parameters: {} })
  const image = await screen.findByRole('img', { name: 'WeChat login QR code' })
  expect(image).toHaveAttribute('src', publicStatus.wechat_qrcode)
  expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect(
    screen.queryByRole('button', { name: 'Send verification code' })
  ).not.toBeInTheDocument()
  fireEvent.error(image)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent(
    'QR code is not configured. Please contact support.'
  )
})

test('missing WeChat configuration explains how to proceed without a broken image', async () => {
  renderHelp({ operation: 'identity.wechat_bind', parameters: {} })
  await screen.findByText('QR code is not configured. Please contact support.')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

test('changing the approved email aborts its pending request and discards the old success', async () => {
  const adapter = api.defaults.adapter
  if (typeof adapter !== 'function') throw new Error('Test adapter missing')
  let finishRequest: (() => void) | undefined
  let pendingSignal: InternalAxiosRequestConfig['signal']
  api.defaults.adapter = async (config) => {
    if (config.url !== '/api/verification') return adapter(config)
    pendingSignal = config.signal
    await new Promise<void>((resolve) => {
      finishRequest = resolve
    })
    return {
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success: true },
    }
  }
  const view = renderHelp()
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Send verification code' })
    ).toBeEnabled()
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Send verification code' })
  )
  await waitFor(() => expect(finishRequest).toBeTypeOf('function'))

  view.rerender(
    <QueryClientProvider client={client}>
      <IdentityBindingHelp
        operation='identity.email_bind'
        parameters={{ email: 'different@example.com' }}
      />
    </QueryClientProvider>
  )

  expect(pendingSignal?.aborted).toBe(true)
  await act(async () => finishRequest?.())
  expect(screen.getByText('Email address: different@example.com')).toBeVisible()
  expect(
    screen.queryByText('Verification code sent! Please check your email.')
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Send verification code' })
  ).toBeEnabled()
})

test('unrelated operations render no helper and make no public requests', () => {
  const view = renderHelp({ operation: 'passkey.delete' })
  expect(view.container).toBeEmptyDOMElement()
  expect(requests).toHaveLength(0)
})
