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

import {
  BILL_TYPE_LABELS,
  FUNDS_LOG_TYPE_LABELS,
  billTypeLabel,
  formatMoney,
  formatQuotaDelta,
  formatSignedMoney,
  formatTimestamp,
  fundsLogTypeLabel,
} from '../format'

// formatTimestamp uses dayjs local-time formatting; pin UTC so expectations
// are deterministic regardless of the machine running the tests.
process.env.TZ = 'UTC'

describe('formatMoney', () => {
  test('formats positive amounts with thousands separators and two decimals', () => {
    expect(formatMoney(1234567.891, 'en-US')).toBe('1,234,567.89')
  })

  test('formats negative amounts with the minus sign and two decimals', () => {
    expect(formatMoney(-1234.5, 'en-US')).toBe('-1,234.50')
  })

  test('formats zero as 0.00', () => {
    expect(formatMoney(0, 'en-US')).toBe('0.00')
  })

  test('falls back to "-" for non-finite amounts', () => {
    expect(formatMoney(Number.NaN, 'en-US')).toBe('-')
  })
})

describe('formatSignedMoney', () => {
  test('prepends an explicit plus sign to positive amounts', () => {
    expect(formatSignedMoney(88.5, 'en-US')).toBe('+¥88.50')
  })

  test('prepends a minus sign to negative amounts', () => {
    expect(formatSignedMoney(-88.5, 'en-US')).toBe('-¥88.50')
  })

  test('renders zero without a sign', () => {
    expect(formatSignedMoney(0, 'en-US')).toBe('¥0.00')
  })
})

describe('formatQuotaDelta', () => {
  test('prepends an explicit plus sign to positive deltas', () => {
    expect(formatQuotaDelta(1000000, 'en-US')).toBe('+1,000,000')
  })

  test('prepends a minus sign to negative deltas', () => {
    expect(formatQuotaDelta(-500, 'en-US')).toBe('-500')
  })

  test('renders zero without a sign', () => {
    expect(formatQuotaDelta(0, 'en-US')).toBe('0')
  })
})

describe('bill type labels', () => {
  test('maps all six bill types to i18n keys', () => {
    expect(Object.keys(BILL_TYPE_LABELS).sort()).toEqual([
      'affiliate',
      'expense',
      'income',
      'refund',
      'subscription',
      'topup',
    ])
    expect(BILL_TYPE_LABELS.topup).toBe('Topup')
    expect(BILL_TYPE_LABELS.income).toBe('Manual Income')
    expect(BILL_TYPE_LABELS.expense).toBe('Manual Expense')
  })

  test('billTypeLabel falls back to the raw type for unknown types', () => {
    expect(billTypeLabel('topup')).toBe('Topup')
    expect(billTypeLabel('unknown')).toBe('unknown')
  })
})

describe('funds log type labels', () => {
  test('maps all three funds log types to i18n keys', () => {
    expect(Object.keys(FUNDS_LOG_TYPE_LABELS).sort()).toEqual([
      'consume',
      'refund',
      'topup',
    ])
    expect(FUNDS_LOG_TYPE_LABELS.topup).toBe('Topup')
    expect(FUNDS_LOG_TYPE_LABELS.consume).toBe('Consume')
    expect(FUNDS_LOG_TYPE_LABELS.refund).toBe('Refund')
  })

  test('fundsLogTypeLabel falls back to the raw type for unknown types', () => {
    expect(fundsLogTypeLabel('consume')).toBe('Consume')
    expect(fundsLogTypeLabel('unknown')).toBe('unknown')
  })
})

describe('formatTimestamp', () => {
  test('formats a Unix second timestamp as YYYY-MM-DD HH:mm:ss in UTC', () => {
    expect(formatTimestamp(1700000000)).toBe('2023-11-14 22:13:20')
  })

  test('returns "-" for zero, never (-1), and missing timestamps', () => {
    expect(formatTimestamp(0)).toBe('-')
    expect(formatTimestamp(-1)).toBe('-')
  })
})
