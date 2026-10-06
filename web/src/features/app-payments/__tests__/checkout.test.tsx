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
import { QueryClient } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { PaymentCheckout } from '../checkout'
import {
  checkout,
  order,
  renderPayment,
  response,
  setSession,
} from './fixtures'

let client: QueryClient
const originalAdapter = api.defaults.adapter
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  setSession()
})
afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  vi.restoreAllMocks()
})

test('shows the exact app, total, account, and server balance conversion before a confirmed balance payment', async () => {
  const posted: unknown[] = []
  let paid = false
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') {
      posted.push(JSON.parse(config.data))
      paid = true
      return response(config, {
        success: true,
        data: { order: { ...order, status: 'paid' } },
      })
    }
    return response(config, {
      success: true,
      data: config.url?.endsWith('/status')
        ? { order: { ...order, status: paid ? 'paid' : 'pending' } }
        : checkout,
    })
  }
  renderPayment(<PaymentCheckout orderID={order.id} />, client)
  expect(await screen.findByText('Example app')).toBeVisible()
  expect(screen.getByText('CNY 12.34')).toBeVisible()
  expect(screen.getByText('Customer')).toBeVisible()
  expect(screen.getByText('Balance charge for this order: $2.47')).toBeVisible()
  expect(posted).toHaveLength(0)
  const user = userEvent.setup()
  await user.click(screen.getByRole('radio', { name: 'Account balance' }))
  await user.click(screen.getByRole('button', { name: 'Review payment' }))
  const dialog = screen.getByRole('alertdialog')
  expect(
    within(dialog).getByText('Your account balance will be charged $2.47.')
  ).toBeVisible()
  expect(posted).toHaveLength(0)
  await user.click(within(dialog).getByRole('button', { name: 'Pay now' }))
  expect(await screen.findByText('Payment successful')).toBeVisible()
  expect(posted).toEqual([
    { method: 'balance', confirmation_nonce: 'bound-nonce' },
  ])
  expect(screen.queryByRole('button', { name: 'Review payment' })).toBeNull()
})

test('does not treat a provider return as paid and restores the pending WeChat QR after reload', async () => {
  const config = {
    ...checkout,
    order: { ...order, status: 'processing' },
    payment: {
      method: 'wechatpay',
      provider: 'wechatpay',
      code_url: 'weixin://wxpay/test',
    },
  }
  api.defaults.adapter = async (request) =>
    response(request, {
      success: true,
      data: request.url?.endsWith('/status') ? { order: config.order } : config,
    })
  renderPayment(<PaymentCheckout orderID={order.id} />, client)
  expect(
    await screen.findByRole('img', { name: 'Payment QR code' })
  ).toBeVisible()
  expect(screen.queryByText('Payment successful')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review payment' })).toBeNull()
  expect(screen.queryByText('Return to app')).toBeNull()
})

test('disables insufficient balance while allowing another payment method and reports a failed confirmation safely', async () => {
  api.defaults.adapter = async (config) =>
    response(
      config,
      config.method === 'post'
        ? {
            success: false,
            code: 'PAYMENT_PROVIDER_FAILED',
            message: 'merchant-private-diagnostic',
          }
        : {
            success: true,
            data: config.url?.endsWith('/status')
              ? { order }
              : {
                  ...checkout,
                  balance: { ...checkout.balance, sufficient: false },
                },
          }
    )
  renderPayment(<PaymentCheckout orderID={order.id} />, client)
  expect(
    await screen.findByRole('radio', { name: 'Account balance' })
  ).toHaveAttribute('aria-disabled', 'true')
  const user = userEvent.setup()
  await user.click(screen.getByRole('radio', { name: 'Stripe' }))
  await user.click(screen.getByRole('button', { name: 'Review payment' }))
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Pay now',
    })
  )
  expect(
    await within(screen.getByRole('alertdialog')).findByText(
      'Unable to complete the request. Check the order status before trying again.'
    )
  ).toBeVisible()
  expect(document.body.textContent).not.toContain('merchant-private-diagnostic')
})

test('an expired order cannot open payment confirmation', async () => {
  const expired = { ...order, expires_at: 1 }
  api.defaults.adapter = async (config) =>
    response(config, {
      success: true,
      data: config.url?.endsWith('/status')
        ? { order: expired }
        : { ...checkout, order: expired },
    })
  renderPayment(<PaymentCheckout orderID={order.id} />, client)
  expect(
    await screen.findByText(
      'This order has expired. Start a new order in the app.'
    )
  ).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Review payment' })).toBeNull()
})

test('a late checkout response from a prior session is rejected without showing its order', async () => {
  let finish: (() => void) | undefined
  api.defaults.adapter = async (config) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return response(config, { success: true, data: checkout })
  }
  renderPayment(<PaymentCheckout orderID={order.id} />, client)
  await waitFor(() => expect(finish).toBeDefined())
  await act(async () => {
    useAuthStore.getState().auth.reset()
    finish?.()
  })
  expect(await screen.findByText('Sign in to view this order.')).toBeVisible()
  expect(screen.queryByText(order.title)).toBeNull()
})

test('a processing order with no provider session can retry only its original method', async () => {
  const requests: unknown[] = []
  const processing = {
    ...order,
    status: 'processing',
    payment_method: 'stripe',
  }
  api.defaults.adapter = async (config) => {
    if (config.method === 'post') {
      requests.push(JSON.parse(config.data))
      return response(config, {
        success: true,
        data: {
          order: processing,
          payment: {
            method: 'stripe',
            provider: 'stripe',
            checkout_url: 'https://checkout.stripe.com/test-session',
          },
        },
      })
    }
    return response(config, {
      success: true,
      data: config.url?.endsWith('/status')
        ? { order: processing }
        : { ...checkout, order: processing },
    })
  }
  renderPayment(<PaymentCheckout orderID={order.id} />, client)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(screen.queryByRole('radio')).toBeNull()
  await user.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Pay now',
    })
  )
  expect(await screen.findByText('Continue to payment')).toBeVisible()
  expect(requests).toEqual([
    { method: 'stripe', confirmation_nonce: 'bound-nonce' },
  ])
})
