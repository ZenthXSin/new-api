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
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'

import { PaymentError } from '../api'

export function PaymentErrorAlert(props: { error: unknown }) {
  const { t } = useTranslation()
  let message = t(
    'Unable to complete the request. Check the order status before trying again.'
  )
  if (props.error instanceof PaymentError) {
    if (props.error.code === 'PAYMENT_INSUFFICIENT_BALANCE') {
      message = t(
        'Your balance is insufficient. Choose another payment method.'
      )
    } else if (props.error.code === 'PAYMENT_NONCE_INVALID') {
      message = t(
        'Your payment confirmation expired. Reload the order to continue.'
      )
    } else if (props.error.code === 'PAYMENT_METHOD_UNAVAILABLE') {
      message = t(
        'This payment method is unavailable. Reload the order to see available methods.'
      )
    } else if (
      props.error.code === 'PAYMENT_NOT_FOUND' ||
      props.error.code === 'PAYMENT_FORBIDDEN'
    ) {
      message = t('This order is unavailable for your account.')
    } else if (
      props.error.code === 'PAYMENT_SESSION_CHANGED' ||
      props.error.code === 'PAYMENT_SESSION_REQUIRED'
    ) {
      message = t('Your session changed. Reload this page to continue.')
    } else if (props.error.code === 'PAYMENT_STATE_CONFLICT') {
      message = t(
        'The order has changed. Check its current status before continuing.'
      )
    }
  }
  return (
    <Alert variant='destructive'>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
