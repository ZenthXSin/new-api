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
import type { WeChatPayOrderStatus } from '../types'

const MAX_CONSECUTIVE_VERIFICATION_ERRORS = 3

export type WeChatPayDialogStatus = WeChatPayOrderStatus | 'verification_error'

export function getNextWeChatPayDialogState(
  currentErrors: number,
  responseSucceeded: boolean,
  verificationError: boolean,
  paymentStatus: WeChatPayOrderStatus = 'pending'
): {
  status: WeChatPayDialogStatus
  consecutiveErrors: number
  shouldStop: boolean
} {
  if (!responseSucceeded || verificationError) {
    const consecutiveErrors = currentErrors + 1
    if (consecutiveErrors >= MAX_CONSECUTIVE_VERIFICATION_ERRORS) {
      return {
        status: 'verification_error',
        consecutiveErrors,
        shouldStop: true,
      }
    }
    return { status: 'pending', consecutiveErrors, shouldStop: false }
  }

  return {
    status: paymentStatus,
    consecutiveErrors: 0,
    shouldStop: paymentStatus !== 'pending',
  }
}
