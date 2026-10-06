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
import { expect, test } from 'vitest'

import {
  formatPaymentAmount,
  safePaymentDestination,
} from '../lib/payment-display'

test('preserves integer minor amounts and decimal zeros in the checkout amount', () => {
  expect(formatPaymentAmount(1, 'CNY')).toBe('CNY 0.01')
  expect(formatPaymentAmount(12340, 'USD')).toBe('USD 123.40')
  expect(formatPaymentAmount(Number.MAX_SAFE_INTEGER, 'CNY')).toBe(
    'CNY 90071992547409.91'
  )
  expect(() => formatPaymentAmount(1.2, 'CNY')).toThrow()
  expect(() => formatPaymentAmount(-1, 'CNY')).toThrow()
})

test('accepts exact server destinations and rejects executable, credentialed, and insecure URLs', () => {
  expect(
    safePaymentDestination('https://merchant.example/complete?order=123')
  ).toBe('https://merchant.example/complete?order=123')
  expect(safePaymentDestination('http://localhost:3000/complete')).toBe(
    'http://localhost:3000/complete'
  )
  for (const value of [
    'javascript:alert(1)',
    '//attacker.example',
    'https://user:pass@example.com',
    'http://merchant.example/pay',
    'https://merchant.example/pay#token',
    'https://merchant.example\\@attacker.example',
  ]) {
    expect(safePaymentDestination(value)).toBeUndefined()
  }
})
