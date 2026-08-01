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
import i18next from 'i18next'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { isApiSuccess, requestWeChatPayPayment } from '../api'
import type { WeChatPayPaymentResponse } from '../types'

export type WeChatPayOrder = NonNullable<WeChatPayPaymentResponse['data']>

export function useWeChatPayPayment() {
  const [processing, setProcessing] = useState(false)
  const [order, setOrder] = useState<WeChatPayOrder | null>(null)

  const processWeChatPayPayment = useCallback(async (topupAmount: number) => {
    setProcessing(true)
    try {
      const response = await requestWeChatPayPayment({
        amount: Math.floor(topupAmount),
      })
      if (isApiSuccess(response) && response.data?.code_url) {
        setOrder(response.data)
        return true
      }

      const message =
        typeof response.data === 'string' ? response.data : response.message
      toast.error(message || i18next.t('Payment request failed'))
      return false
    } catch {
      toast.error(i18next.t('Payment request failed'))
      return false
    } finally {
      setProcessing(false)
    }
  }, [])

  const clearWeChatPayOrder = useCallback(() => setOrder(null), [])

  return {
    processing,
    order,
    processWeChatPayPayment,
    clearWeChatPayOrder,
  }
}
