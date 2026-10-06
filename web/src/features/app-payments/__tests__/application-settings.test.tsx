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
import { afterEach, beforeEach, expect, test } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { PaymentApplicationSettings } from '../application-settings'
import { PaymentEvents } from '../components/payment-events'
import { response, setSession } from './fixtures'

const originalAdapter = api.defaults.adapter
let client: QueryClient
const application = {
  client_id: 'app-123',
  client_name: 'Example app',
  enabled: false,
  webhook_url: 'https://app.example.com/payments',
  methods: ['balance'],
  has_webhook_secret: true,
  available_methods: [
    {
      id: 'balance',
      label: 'Account balance',
      currency: '',
      refund_supported: true,
    },
  ],
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  setSession(100)
})
afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
})

function settings() {
  return (
    <QueryClientProvider client={client}>
      <PaymentApplicationSettings
        clientID='app-123'
        clientName='Example app'
        open
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  )
}

test('only root can open application payment settings and ordinary users issue no management request', async () => {
  setSession(1)
  const requests: string[] = []
  api.defaults.adapter = async (config) => {
    requests.push(config.url ?? '')
    return response(config, { success: true, data: application })
  }
  const view = render(settings())
  await act(async () => undefined)
  expect(view.container).toBeEmptyDOMElement()
  expect(requests).toEqual([])
})

test('saving payment settings shows a new notification secret once without storing it in query or mutation caches', async () => {
  const writes: unknown[] = []
  api.defaults.adapter = async (config) => {
    if (config.method === 'put') {
      const data = JSON.parse(config.data)
      writes.push(data)
      return response(config, {
        success: true,
        data: {
          ...application,
          ...data,
          webhook_secret: 'notification-secret-once',
        },
      })
    }
    return response(config, { success: true, data: application })
  }
  render(settings())
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('switch', { name: 'Enable application payments' })
  )
  await user.click(
    screen.getByRole('button', { name: 'Save payment settings' })
  )
  expect(
    await screen.findByRole('textbox', { name: 'Notification secret' })
  ).toHaveValue('notification-secret-once')
  expect(writes).toEqual([
    {
      enabled: true,
      webhook_url: 'https://app.example.com/payments',
      methods: ['balance'],
    },
  ])
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state)
    )
  ).not.toContain('notification-secret-once')
  expect(
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((m) => m.state)
    )
  ).not.toContain('notification-secret-once')
  await user.click(screen.getByRole('button', { name: 'Clear secret' }))
  expect(
    screen.queryByRole('textbox', { name: 'Notification secret' })
  ).toBeNull()
})

test('rotating requires confirmation and explains queued notification signatures', async () => {
  let rotations = 0
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') {
      rotations++
      return response(config, {
        success: true,
        data: { webhook_secret: 'rotated-notification-secret' },
      })
    }
    return response(config, { success: true, data: application })
  }
  render(settings())
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Rotate notification secret' })
  )
  const dialog = screen.getByRole('alertdialog')
  expect(
    within(dialog).getByText(
      'New notifications use the new secret. Keep the previous secret until queued notifications have been delivered.'
    )
  ).toBeVisible()
  expect(rotations).toBe(0)
  await user.click(
    within(dialog).getByRole('button', { name: 'Rotate secret' })
  )
  expect(
    await screen.findByRole('textbox', { name: 'Notification secret' })
  ).toHaveValue('rotated-notification-secret')
  expect(rotations).toBe(1)
})

test('a failed notification is retried only after confirmation and delivered notifications cannot be retried', async () => {
  let retries = 0
  const event = {
    id: 'event-pending',
    order_id: 'order-123',
    type: 'payment.paid',
    attempts: 2,
    next_attempt_at: 1800000000,
    delivered_at: 0,
    last_error: 'private response diagnostic',
    created_at: 1800000000,
  }
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') {
      retries++
      return response(config, { success: true })
    }
    return response(config, {
      success: true,
      data: {
        items: [
          event,
          { ...event, id: 'event-delivered', delivered_at: 1800000010 },
        ],
        total: 2,
        page: 1,
        page_size: 20,
      },
    })
  }
  render(
    <QueryClientProvider client={client}>
      <PaymentEvents
        clientID='app-123'
        identity={{ userID: 7, sessionID: 'session-one' }}
      />
    </QueryClientProvider>
  )
  const buttons = await screen.findAllByRole('button', {
    name: 'Retry delivery',
  })
  expect(buttons[1]).toBeDisabled()
  expect(document.body.textContent).not.toContain('private response diagnostic')
  const user = userEvent.setup()
  await user.click(buttons[0])
  expect(retries).toBe(0)
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Retry delivery',
    })
  )
  await waitFor(() => expect(retries).toBe(1))
})
