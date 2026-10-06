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
/** Format a server-provided integer amount without recomputing payment totals. */
export function formatPaymentAmount(
  amountMinor: number,
  currency: string
): string {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new Error('Invalid payment amount')
  }
  const amount = BigInt(amountMinor)
  return `${currency} ${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`
}

/** Only navigate to server-provided HTTPS or local development destinations. */
export function safePaymentDestination(
  value: string | undefined
): string | undefined {
  if (!value || value.includes('\\')) return undefined
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return undefined
    if (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) {
      return url.href
    }
  } catch {
    /* Invalid destinations are not rendered. */
  }
  return undefined
}
