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
import { describe, expect, test } from 'vitest'

import { PAYMENT_TYPES } from '../constants'
import {
  dispatchSelectedPayment,
  getMinTopupAmount,
  isStripePayment,
  isWaffoPayment,
  isWaffoPancakePayment,
  isWeChatPayPayment,
} from './payment'

describe('minimum topup amount', () => {
  test('uses the configured minimum when WeChat Pay is the only provider', () => {
    const topupInfo = {
      enable_wechatpay_topup: true,
      wechatpay_min_topup: 25,
    } as Parameters<typeof getMinTopupAmount>[0]

    expect(getMinTopupAmount(topupInfo)).toBe(25)
  })
})

describe('payment type classification', () => {
  test('keeps Waffo and Waffo Pancake on their dedicated flows', () => {
    expect(isWaffoPayment(PAYMENT_TYPES.WAFFO)).toBe(true)
    expect(isWaffoPayment(PAYMENT_TYPES.WAFFO_PANCAKE)).toBe(false)
    expect(isWaffoPancakePayment(PAYMENT_TYPES.WAFFO_PANCAKE)).toBe(true)
    expect(isWaffoPancakePayment(PAYMENT_TYPES.WAFFO)).toBe(false)
    expect(isStripePayment(PAYMENT_TYPES.STRIPE)).toBe(true)
    expect(isWeChatPayPayment(PAYMENT_TYPES.WECHAT)).toBe(true)
  })
})

describe('payment dispatch', () => {
  test('keeps the selected Waffo method index through confirmation', async () => {
    const calls: string[] = []
    const success = await dispatchSelectedPayment(
      { name: 'Waffo Card', type: PAYMENT_TYPES.WAFFO },
      120,
      3,
      {
        regular: async () => {
          calls.push('regular')
          return false
        },
        waffo: async (amount, index) => {
          calls.push(`waffo:${amount}:${index}`)
          return true
        },
        waffoPancake: async () => {
          calls.push('pancake')
          return false
        },
        wechatPay: async () => false,
      }
    )

    expect(success).toBe(true)
    expect(calls).toEqual(['waffo:120:3'])
  })

  test('dispatches WeChat Pay only to the native payment processor', async () => {
    const calls: string[] = []
    const success = await dispatchSelectedPayment(
      { name: 'WeChat Pay', type: PAYMENT_TYPES.WECHAT },
      80,
      null,
      {
        regular: async () => {
          calls.push('regular')
          return false
        },
        waffo: async () => {
          calls.push('waffo')
          return false
        },
        waffoPancake: async () => {
          calls.push('pancake')
          return false
        },
        wechatPay: async (amount) => {
          calls.push(`wechat:${amount}`)
          return true
        },
      }
    )

    expect(success).toBe(true)
    expect(calls).toEqual(['wechat:80'])
  })

  test('does not create a Waffo order without a selected method index', async () => {
    let called = false
    const success = await dispatchSelectedPayment(
      { name: 'Waffo Card', type: PAYMENT_TYPES.WAFFO },
      120,
      null,
      {
        regular: async () => false,
        waffo: async () => {
          called = true
          return true
        },
        waffoPancake: async () => false,
        wechatPay: async () => false,
      }
    )

    expect(success).toBe(false)
    expect(called).toBe(false)
  })
})
