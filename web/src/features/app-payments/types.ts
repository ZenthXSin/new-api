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
import { z } from 'zod'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const paymentStatusSchema = z.enum([
  'pending',
  'processing',
  'paid',
  'canceled',
  'expired',
  'refunding',
  'refunded',
  'failed',
])
export const paymentOrderSchema = z.object({
  id: z.string().min(1),
  client_id: z.string(),
  out_trade_no: z.string(),
  title: z.string(),
  amount: integer,
  currency: z.enum(['CNY', 'USD']),
  status: paymentStatusSchema,
  payment_method: z.string().default(''),
  payer_user_id: integer.default(0),
  created_at: integer,
  updated_at: integer,
  expires_at: integer,
  paid_at: integer.default(0),
  refunded_at: integer.default(0),
  return_url: z.string().default(''),
  checkout_url: z.string().default(''),
})
export const paymentMethodSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  currency: z.string(),
  refund_supported: z.boolean(),
})
export const paymentSessionSchema = z.object({
  method: z.string(),
  provider: z.string(),
  checkout_url: z.string().optional(),
  code_url: z.string().optional(),
  provider_id: z.string().optional(),
})
export const checkoutSchema = z.object({
  order: paymentOrderSchema,
  application: z.object({ client_id: z.string(), name: z.string() }),
  methods: z.array(paymentMethodSchema),
  balance: z.object({
    available_quota: integer,
    required_quota: integer,
    sufficient: z.boolean(),
    available_display: z.string(),
    required_display: z.string(),
  }),
  confirmation_nonce: z.string().default(''),
  confirmation_expires_at: integer.default(0),
  payment: paymentSessionSchema.optional(),
})
export const confirmationSchema = z.object({
  order: paymentOrderSchema,
  payment: paymentSessionSchema.optional(),
})
export const paymentApplicationSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  enabled: z.boolean(),
  webhook_url: z.string(),
  methods: z.array(z.string()),
  has_webhook_secret: z.boolean(),
  available_methods: z.array(paymentMethodSchema).default([]),
})
export const paymentOrderListSchema = z.object({
  items: z.array(paymentOrderSchema),
  total: integer,
  page: integer,
  page_size: integer,
})
export type PaymentStatus = z.infer<typeof paymentStatusSchema>
export type PaymentOrder = z.infer<typeof paymentOrderSchema>
export type PaymentCheckoutData = z.infer<typeof checkoutSchema>
export type PaymentSession = z.infer<typeof paymentSessionSchema>
export type PaymentApplication = z.infer<typeof paymentApplicationSchema>
export interface PaymentIdentity {
  userID: number
  sessionID: string
}
export interface PaymentApplicationInput {
  enabled: boolean
  webhook_url: string
  methods: string[]
}

export const paymentEventListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      order_id: z.string(),
      type: z.string(),
      attempts: integer,
      next_attempt_at: integer,
      delivered_at: integer,
      last_error: z.string(),
      created_at: integer,
    })
  ),
  total: integer,
  page: integer,
  page_size: integer,
})
