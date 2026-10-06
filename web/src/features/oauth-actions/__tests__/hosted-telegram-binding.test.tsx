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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TELEGRAM_BIND_RESULT_MESSAGE } from '@/features/auth/constants'
import { api } from '@/lib/api'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import { HostedTelegramBinding } from '../components/hosted-telegram-binding'

const bundle: AuthBundle = {
  access_token: 'test-session',
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
const payload = {
  flow_token: 'telegram-flow',
  callback_url: '/api/oauth/telegram/bind/telegram-flow',
  expires_at: 2000000000,
}
const originalAdapter = api.defaults.adapter
let popup: Window
let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  useAuthStore.getState().auth.setBundle(bundle)
  replace = vi.fn()
  popup = {
    closed: false,
    location: { replace },
    close: vi.fn(() => {
      Object.defineProperty(popup, 'closed', {
        configurable: true,
        value: true,
      })
    }),
  } as unknown as Window
  vi.spyOn(window, 'open').mockReturnValue(popup)
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      data: { telegram_oauth: true, telegram_bot_name: 'ExampleBot' },
    },
  })
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
})

async function openWidget() {
  const user = userEvent.setup()
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Continue with Telegram' })
    ).toBeEnabled()
  )
  await user.click(
    screen.getByRole('button', { name: 'Continue with Telegram' })
  )
  const dialog = await screen.findByRole('dialog', {
    name: 'Telegram Login Widget',
  })
  await waitFor(() =>
    expect(dialog.querySelector('script[data-onauth]')).not.toBeNull()
  )
  const mountedScript = dialog.querySelector<HTMLScriptElement>(
    'script[data-onauth]'
  )
  expect(mountedScript).not.toBeNull()
  if (!mountedScript) throw new Error('Telegram widget was not mounted')
  fireEvent.load(mountedScript)
  const callbackName =
    mountedScript?.dataset.onauth?.replace('(user)', '') ?? ''
  const callback = (window as unknown as Record<string, unknown>)[callbackName]
  expect(typeof callback).toBe('function')
  return callback as (value: unknown) => void
}

function telegramResult() {
  const event = new MessageEvent('message', {
    origin: window.location.origin,
    data: {
      type: TELEGRAM_BIND_RESULT_MESSAGE,
      flow_token: 'telegram-flow',
      success: true,
    },
  })
  Object.defineProperty(event, 'source', { value: popup })
  window.dispatchEvent(event)
}

describe('hosted Telegram widget flow', () => {
  test('widget authorization waits for the server callback before preparing the completion step', async () => {
    const complete = vi.fn()
    render(
      <HostedTelegramBinding
        payload={payload}
        onComplete={complete}
        onCancel={vi.fn()}
      />
    )
    const callback = await openWidget()
    await act(async () => {
      callback({ id: 42, auth_date: 1900000000, hash: 'signed-widget-data' })
    })
    expect(complete).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
    const url = new URL(String(replace.mock.calls[0]?.[0]))
    expect(url.pathname).toBe(payload.callback_url)

    await act(async () => {
      telegramResult()
    })

    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith({ flow_token: payload.flow_token })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(popup.close).toHaveBeenCalled()
  })

  test('a malformed widget response cannot navigate or finish the action', async () => {
    const complete = vi.fn()
    render(
      <HostedTelegramBinding
        payload={payload}
        onComplete={complete}
        onCancel={vi.fn()}
      />
    )
    const callback = await openWidget()
    await act(async () => {
      callback({ id: 42 })
    })

    await screen.findByText('Telegram binding failed. Please try again.')
    expect(replace).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  test('leaving the page closes the popup and ignores a late widget callback', async () => {
    const complete = vi.fn()
    const view = render(
      <HostedTelegramBinding
        payload={payload}
        onComplete={complete}
        onCancel={vi.fn()}
      />
    )
    const callback = await openWidget()
    view.unmount()
    await act(async () => {
      callback({ id: 42, auth_date: 1900000000, hash: 'signed-widget-data' })
      telegramResult()
    })

    expect(popup.close).toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  test('changing accounts closes the widget and discards the old approval', async () => {
    const complete = vi.fn()
    render(
      <HostedTelegramBinding
        payload={payload}
        onComplete={complete}
        onCancel={vi.fn()}
      />
    )
    const callback = await openWidget()
    await act(async () => {
      useAuthStore.getState().auth.setBundle({
        ...bundle,
        user: { id: 8, username: 'bob', role: 1 },
        session: { ...bundle.session, sid: 'session-b' },
      })
      callback({ id: 42, auth_date: 1900000000, hash: 'signed-widget-data' })
    })

    expect(popup.close).toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
