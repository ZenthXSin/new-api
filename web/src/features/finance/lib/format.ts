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
import dayjs from '@/lib/dayjs'

/**
 * Bill type → i18n key. Values are translation keys; render with `t(...)`.
 */
export const BILL_TYPE_LABELS: Record<string, string> = {
  topup: 'Topup',
  refund: 'Refund',
  subscription: 'Subscription',
  affiliate: 'Affiliate',
  income: 'Manual Income',
  expense: 'Manual Expense',
}

/**
 * Funds log type → i18n key. Values are translation keys; render with `t(...)`.
 */
export const FUNDS_LOG_TYPE_LABELS: Record<string, string> = {
  topup: 'Topup',
  consume: 'Consume',
  refund: 'Refund',
}

/** Return the i18n key for a bill type, falling back to the raw type. */
export function billTypeLabel(type: string): string {
  return BILL_TYPE_LABELS[type] ?? type
}

/** Return the i18n key for a funds log type, falling back to the raw type. */
export function fundsLogTypeLabel(type: string): string {
  return FUNDS_LOG_TYPE_LABELS[type] ?? String(type)
}

/**
 * Format a real-currency amount with thousands separators and exactly two
 * decimal places (e.g. `1,234.50`).
 */
export function formatMoney(
  amount: number,
  locales?: Intl.LocalesArgument
): string {
  if (!Number.isFinite(amount)) return '-'
  return new Intl.NumberFormat(locales, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

/**
 * Format a real-currency amount with an explicit sign (e.g. `+¥1,234.50`).
 * Zero renders without a sign.
 */
export function formatSignedMoney(
  amount: number,
  locales?: Intl.LocalesArgument
): string {
  if (!Number.isFinite(amount)) return '-'
  if (amount === 0) return `¥${formatMoney(0, locales)}`
  const sign = amount > 0 ? '+' : '-'
  return `${sign}¥${formatMoney(Math.abs(amount), locales)}`
}

/**
 * Format a quota delta with an explicit sign (e.g. `+1,000,000`, `-500`).
 * Zero renders without a sign.
 */
export function formatQuotaDelta(
  quota: number,
  locales?: Intl.LocalesArgument
): string {
  if (!Number.isFinite(quota)) return '-'
  if (quota === 0) return '0'
  const sign = quota > 0 ? '+' : '-'
  const absolute = new Intl.NumberFormat(locales, {
    maximumFractionDigits: 2,
  }).format(Math.abs(quota))
  return `${sign}${absolute}`
}

/**
 * Format a Unix timestamp (seconds) as `YYYY-MM-DD HH:mm:ss`.
 * Returns `-` for missing, zero, or never (-1) timestamps.
 */
export function formatTimestamp(timestamp: number): string {
  if (!timestamp || timestamp === -1) return '-'
  return dayjs(timestamp * 1000).format('YYYY-MM-DD HH:mm:ss')
}
