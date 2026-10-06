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
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { InternalAxiosRequestConfig } from 'axios'
import type { ReactNode } from 'react'

import { useAuthStore } from '@/stores/auth-store'

import type { PaymentCheckoutData, PaymentOrder } from '../types'

export const order: PaymentOrder = {
  id: 'order-123',
  client_id: 'app-123',
  out_trade_no: 'purchase-123',
  title: 'One month membership',
  amount: 1234,
  currency: 'CNY',
  status: 'pending',
  payment_method: '',
  payer_user_id: 7,
  created_at: 1800000000,
  updated_at: 1800000000,
  expires_at: 9999999999,
  paid_at: 0,
  refunded_at: 0,
  return_url: 'https://app.example.com/return',
  checkout_url: 'https://site.example.com/payments/checkout/order-123',
}
export const checkout: PaymentCheckoutData = {
  order,
  application: { client_id: 'app-123', name: 'Example app' },
  methods: [
    {
      id: 'balance',
      label: 'Account balance',
      currency: 'CNY',
      refund_supported: true,
    },
    {
      id: 'wechatpay',
      label: 'WeChat Pay',
      currency: 'CNY',
      refund_supported: true,
    },
    { id: 'stripe', label: 'Stripe', currency: 'CNY', refund_supported: true },
  ],
  balance: {
    available_quota: 10000000,
    required_quota: 1234000,
    sufficient: true,
    available_display: '$20.00',
    required_display: '$2.47',
  },
  confirmation_nonce: 'bound-nonce',
  confirmation_expires_at: 9999999999,
}

export function setSession(role = 1, sid = 'session-one', userID = 7) {
  useAuthStore.getState().auth.setBundle({
    access_token: 'dashboard-token',
    token_type: 'Bearer',
    access_expires_at: 9999999999,
    user: { id: userID, username: 'Customer', role },
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
  })
}
export function response(config: InternalAxiosRequestConfig, data: unknown) {
  return { config, data, headers: {}, status: 200, statusText: 'OK' }
}
export function renderPayment(node: ReactNode, queryClient: QueryClient) {
  const route = createRootRoute({ component: () => node })
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
