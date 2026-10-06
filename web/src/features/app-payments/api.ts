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
import { isAxiosError } from 'axios'
import { z } from 'zod'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import {
  checkoutSchema,
  confirmationSchema,
  paymentEventListSchema,
  paymentApplicationSchema,
  paymentOrderListSchema,
  paymentOrderSchema,
  type PaymentApplicationInput,
  type PaymentIdentity,
} from './types'

const privateRequest = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipAuthRefresh: true,
  skipRequestDedup: true,
}
export class PaymentError extends Error {
  constructor(public readonly code: string) {
    super(code)
  }
}

export function assertPaymentIdentity(identity: PaymentIdentity): void {
  const auth = useAuthStore.getState().auth
  if (
    auth.user?.id !== identity.userID ||
    auth.session?.sid !== identity.sessionID
  ) {
    throw new PaymentError('PAYMENT_SESSION_CHANGED')
  }
}

async function requestPayment<T>(
  method: 'get' | 'post' | 'put',
  url: string,
  schema: z.ZodType<T>,
  identity: PaymentIdentity,
  data?: unknown,
  signal?: AbortSignal
): Promise<T> {
  try {
    assertPaymentIdentity(identity)
    const response = await api.request({
      ...privateRequest,
      method,
      url,
      data,
      signal,
    })
    assertPaymentIdentity(identity)
    if (response.data?.success !== true) {
      throw new PaymentError(
        typeof response.data?.code === 'string'
          ? response.data.code
          : 'PAYMENT_UNAVAILABLE'
      )
    }
    return schema.parse(response.data.data)
  } catch (error) {
    if (error instanceof PaymentError) throw error
    if (isAxiosError(error) && typeof error.response?.data?.code === 'string') {
      throw new PaymentError(error.response.data.code)
    }
    throw new PaymentError('PAYMENT_UNAVAILABLE')
  }
}

export function getPaymentCheckout(
  orderID: string,
  identity: PaymentIdentity,
  signal?: AbortSignal
) {
  return requestPayment(
    'get',
    `/api/payments/checkout/${encodeURIComponent(orderID)}`,
    checkoutSchema,
    identity,
    undefined,
    signal
  )
}
export function confirmPayment(
  orderID: string,
  method: string,
  nonce: string,
  identity: PaymentIdentity
) {
  return requestPayment(
    'post',
    `/api/payments/checkout/${encodeURIComponent(orderID)}/confirm`,
    confirmationSchema,
    identity,
    { method, confirmation_nonce: nonce }
  )
}
export function getPaymentStatus(
  orderID: string,
  identity: PaymentIdentity,
  signal?: AbortSignal
) {
  return requestPayment(
    'get',
    `/api/payments/checkout/${encodeURIComponent(orderID)}/status`,
    z.object({ order: paymentOrderSchema }),
    identity,
    undefined,
    signal
  )
}
export function getPaymentOrders(
  page: number,
  identity: PaymentIdentity,
  clientID?: string,
  signal?: AbortSignal
) {
  const base = clientID
    ? `/api/payments/applications/${encodeURIComponent(clientID)}/orders`
    : '/api/payments/self/orders'
  return requestPayment(
    'get',
    `${base}?page=${page}&page_size=20`,
    paymentOrderListSchema,
    identity,
    undefined,
    signal
  )
}
export function getPaymentApplication(
  clientID: string,
  identity: PaymentIdentity,
  signal?: AbortSignal
) {
  return requestPayment(
    'get',
    `/api/payments/applications/${encodeURIComponent(clientID)}`,
    paymentApplicationSchema,
    identity,
    undefined,
    signal
  )
}
export function savePaymentApplication(
  clientID: string,
  input: PaymentApplicationInput,
  identity: PaymentIdentity
) {
  return requestPayment(
    'put',
    `/api/payments/applications/${encodeURIComponent(clientID)}`,
    paymentApplicationSchema.extend({ webhook_secret: z.string().optional() }),
    identity,
    input
  )
}
export function rotatePaymentSecret(
  clientID: string,
  identity: PaymentIdentity
) {
  return requestPayment(
    'post',
    `/api/payments/applications/${encodeURIComponent(clientID)}/rotate-secret`,
    z.object({ webhook_secret: z.string().min(1) }),
    identity
  )
}

export function getPaymentEvents(
  clientID: string,
  page: number,
  identity: PaymentIdentity,
  signal?: AbortSignal
) {
  return requestPayment(
    'get',
    `/api/payments/applications/${encodeURIComponent(clientID)}/events?page=${page}&page_size=20`,
    paymentEventListSchema,
    identity,
    undefined,
    signal
  )
}
export async function retryPaymentEvent(
  clientID: string,
  eventID: string,
  identity: PaymentIdentity
): Promise<void> {
  await requestPayment(
    'post',
    `/api/payments/applications/${encodeURIComponent(clientID)}/events/${encodeURIComponent(eventID)}/retry`,
    z.unknown(),
    identity
  )
}
