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
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  XCircle,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { getWeChatPayOrder, isApiSuccess } from '../../api'
import {
  getNextWeChatPayDialogState,
  type WeChatPayDialogStatus,
} from '../../lib/wechat-payment-status'

const POLL_INTERVAL_MS = 2000
// 兜底窗口仅在订单缺少 expire_at 时使用；正常情况下轮询持续到订单自身过期
// （后端按同一有效期关单），避免"订单还有效但弹窗提前停止确认"的空窗。
const FALLBACK_POLL_DURATION_MS = 10 * 60 * 1000

interface WeChatNativePaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  codeURL: string
  orderID: string
  expireAt: number
  onSuccess: () => void | Promise<void>
}

export function WeChatNativePaymentDialog(
  props: WeChatNativePaymentDialogProps
) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<WeChatPayDialogStatus>('pending')
  const [retryRequest, setRetryRequest] = useState(0)
  const successHandledRef = useRef(false)
  const { open, orderID, expireAt, onSuccess } = props

  useEffect(() => {
    if (!open || !orderID) return

    let cancelled = false
    let timeoutID: ReturnType<typeof setTimeout> | undefined
    let consecutiveVerificationErrors = 0
    const stopAt =
      expireAt > 0 ? expireAt * 1000 : Date.now() + FALLBACK_POLL_DURATION_MS

    setStatus('pending')
    successHandledRef.current = false

    const poll = async () => {
      if (cancelled) return
      if (Date.now() >= stopAt) {
        setStatus('expired')
        return
      }

      try {
        const response = await getWeChatPayOrder(orderID)
        if (cancelled) return

        const responseSucceeded =
          isApiSuccess(response) && Boolean(response.data)
        const nextState = getNextWeChatPayDialogState(
          consecutiveVerificationErrors,
          responseSucceeded,
          response.data?.verification_error === true,
          response.data?.status
        )
        consecutiveVerificationErrors = nextState.consecutiveErrors
        setStatus(nextState.status)

        if (nextState.status === 'success' && !successHandledRef.current) {
          successHandledRef.current = true
          await onSuccess()
          return
        }
        if (nextState.shouldStop) return
      } catch {
        const nextState = getNextWeChatPayDialogState(
          consecutiveVerificationErrors,
          false,
          false
        )
        consecutiveVerificationErrors = nextState.consecutiveErrors
        if (!cancelled) setStatus(nextState.status)
        if (nextState.shouldStop) return
      }

      if (!cancelled) {
        timeoutID = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    timeoutID = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timeoutID) clearTimeout(timeoutID)
    }
  }, [open, orderID, expireAt, onSuccess, retryRequest])

  const terminal = status !== 'pending' && status !== 'verification_error'

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className='max-sm:w-[calc(100vw-1.5rem)] sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('Pay with WeChat')}</DialogTitle>
          <DialogDescription>
            {t('Scan the QR code with WeChat to complete payment')}
          </DialogDescription>
        </DialogHeader>

        <div className='flex min-h-72 flex-col items-center justify-center gap-4 py-2'>
          {status === 'pending' && (
            <>
              <div className='rounded-md border bg-white p-3'>
                <QRCodeSVG value={props.codeURL} size={224} level='M' />
              </div>
              <div className='text-muted-foreground flex items-center gap-2 text-sm'>
                <Loader2 className='h-4 w-4 animate-spin' aria-hidden='true' />
                {t('Waiting for payment confirmation')}
              </div>
            </>
          )}
          {status === 'success' && (
            <div className='flex flex-col items-center gap-3 text-center'>
              <CheckCircle2
                className='h-12 w-12 text-green-600'
                aria-hidden='true'
              />
              <p className='text-base font-medium'>{t('Payment successful')}</p>
            </div>
          )}
          {status === 'expired' && (
            <div className='flex flex-col items-center gap-3 text-center'>
              <Clock3
                className='text-muted-foreground h-12 w-12'
                aria-hidden='true'
              />
              <p className='text-base font-medium'>
                {t('Payment order expired')}
              </p>
            </div>
          )}
          {status === 'verification_error' && (
            <div className='flex flex-col items-center gap-3 text-center'>
              <AlertCircle
                className='text-destructive h-12 w-12'
                aria-hidden='true'
              />
              <p className='text-base font-medium'>
                {t('Unable to confirm payment status')}
              </p>
              <Button
                type='button'
                variant='outline'
                onClick={() => setRetryRequest((value) => value + 1)}
              >
                {t('Retry')}
              </Button>
            </div>
          )}
          {status === 'failed' && (
            <div className='flex flex-col items-center gap-3 text-center'>
              <XCircle
                className='text-destructive h-12 w-12'
                aria-hidden='true'
              />
              <p className='text-base font-medium'>{t('Payment failed')}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <div className='flex w-full justify-end gap-2'>
            {status === 'pending' && (
              <CopyButton
                value={props.codeURL}
                variant='outline'
                size='default'
                tooltip={t('Copy payment link')}
                successTooltip={t('Payment link copied')}
                aria-label={t('Copy payment link')}
              >
                {t('Copy link')}
              </CopyButton>
            )}
            <Button
              type='button'
              variant={terminal ? 'default' : 'outline'}
              onClick={() => props.onOpenChange(false)}
            >
              {terminal ? t('Done') : t('Cancel')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
