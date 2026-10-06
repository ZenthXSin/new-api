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
import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Turnstile } from '@/components/turnstile'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { EMAIL_VERIFICATION_COUNTDOWN } from '@/features/auth/constants'
import { useCountdown } from '@/hooks/use-countdown'
import { api } from '@/lib/api'

const publicRequest = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipAuthRefresh: true,
  skipPanelAuth: true,
  skipRequestDedup: true,
}

const bindingStatusSchema = z.object({
  turnstile_check: z.boolean().optional(),
  turnstile_site_key: z.string().optional(),
  wechat_qrcode: z.string().optional(),
})

function useIdentityBindingStatus() {
  return useQuery({
    queryKey: ['oauth-actions', 'public-binding-status'],
    queryFn: async ({ signal }) => {
      try {
        const response = await api.get('/api/status', {
          ...publicRequest,
          signal,
        })
        if (response.data?.success !== true) throw new Error('Invalid status')
        return bindingStatusSchema.parse(response.data.data)
      } catch {
        throw new Error('Unable to load public binding settings')
      }
    },
    staleTime: 60_000,
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
}

function EmailBindingHelp(props: { email: string; disabled?: boolean }) {
  const { t } = useTranslation()
  const status = useIdentityBindingStatus()
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileKey, setTurnstileKey] = useState(0)
  const mounted = useRef(false)
  const request = useRef<AbortController | null>(null)
  const countdown = useCountdown({
    initialSeconds: EMAIL_VERIFICATION_COUNTDOWN,
  })
  const validEmail = z.email().safeParse(props.email).success
  const turnstileEnabled = status.data?.turnstile_check === true
  const siteKey = status.data?.turnstile_site_key ?? ''
  const clearTurnstile = useCallback(() => setTurnstileToken(''), [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current?.abort()
    }
  }, [])

  const sendCode = useMutation({
    mutationFn: async () => {
      if (
        props.disabled ||
        !validEmail ||
        !status.isSuccess ||
        countdown.isActive ||
        request.current ||
        (turnstileEnabled && (!siteKey || !turnstileToken))
      ) {
        throw new Error(t('Failed to send verification code'))
      }
      const controller = new AbortController()
      request.current = controller
      const token = turnstileToken
      clearTurnstile()
      setTurnstileKey((current) => current + 1)
      try {
        const response = await api.get('/api/verification', {
          ...publicRequest,
          signal: controller.signal,
          params: { email: props.email, turnstile: token || undefined },
        })
        if (response.data?.success !== true) throw new Error('Email rejected')
      } catch {
        throw new Error(t('Failed to send verification code'))
      } finally {
        if (request.current === controller) request.current = null
      }
    },
    onSuccess: () => {
      if (mounted.current) countdown.start()
    },
    // The inline error replaces the application's default mutation toast.
    onError: () => undefined,
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })

  let buttonLabel = t('Send verification code')
  if (sendCode.isPending) buttonLabel = t('Sending...')
  else if (countdown.isActive) {
    buttonLabel = t('Resend ({{seconds}}s)', {
      seconds: countdown.secondsLeft,
    })
  }

  return (
    <div className='flex min-w-0 flex-col gap-3'>
      <p className='text-sm break-all'>
        {t('Email address')}: {props.email}
      </p>
      {!validEmail && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('Please enter a valid email address')}
          </AlertDescription>
        </Alert>
      )}
      {status.isPending && <p role='status'>{t('Loading settings...')}</p>}
      {status.isError && (
        <Alert variant='destructive'>
          <AlertDescription>{t('Failed to load settings')}</AlertDescription>
          <Button
            type='button'
            variant='outline'
            onClick={() => void status.refetch()}
          >
            {t('Retry')}
          </Button>
        </Alert>
      )}
      {turnstileEnabled && siteKey && (
        <Turnstile
          key={turnstileKey}
          siteKey={siteKey}
          onVerify={setTurnstileToken}
          onExpire={clearTurnstile}
        />
      )}
      {turnstileEnabled && !turnstileToken && (
        <p role='status' className='text-muted-foreground text-sm'>
          {t('Please wait a moment, human check is initializing...')}
        </p>
      )}
      <Button
        type='button'
        variant='outline'
        onClick={() => sendCode.mutate()}
        disabled={
          props.disabled ||
          !validEmail ||
          !status.isSuccess ||
          sendCode.isPending ||
          countdown.isActive ||
          (turnstileEnabled && (!siteKey || !turnstileToken))
        }
      >
        {sendCode.isPending && <Spinner data-icon='inline-start' />}
        {buttonLabel}
      </Button>
      {sendCode.isError && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('Failed to send verification code')}
          </AlertDescription>
        </Alert>
      )}
      {sendCode.isSuccess && (
        <p role='status' className='text-sm'>
          {t('Verification code sent! Please check your email.')}
        </p>
      )}
    </div>
  )
}

function WeChatBindingHelp() {
  const { t } = useTranslation()
  const status = useIdentityBindingStatus()
  const [failedURL, setFailedURL] = useState('')
  const qrCodeURL = status.data?.wechat_qrcode ?? ''

  return (
    <div className='flex flex-col gap-3'>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Scan the QR code to follow the official account and reply with “验证码” to receive your verification code.'
        )}
      </p>
      {status.isPending && <p role='status'>{t('Loading settings...')}</p>}
      {status.isError && (
        <Alert variant='destructive'>
          <AlertDescription>{t('Failed to load settings')}</AlertDescription>
          <Button
            type='button'
            variant='outline'
            onClick={() => void status.refetch()}
          >
            {t('Retry')}
          </Button>
        </Alert>
      )}
      {status.isSuccess && qrCodeURL && failedURL !== qrCodeURL && (
        <img
          src={qrCodeURL}
          alt={t('WeChat login QR code')}
          className='size-48 max-w-full self-center rounded-lg border object-contain'
          referrerPolicy='no-referrer'
          onError={() => setFailedURL(qrCodeURL)}
        />
      )}
      {status.isSuccess && (!qrCodeURL || failedURL === qrCodeURL) && (
        <p role='status' className='text-muted-foreground text-sm'>
          {t('QR code is not configured. Please contact support.')}
        </p>
      )}
    </div>
  )
}

export function IdentityBindingHelp(props: {
  operation: string
  parameters: Record<string, unknown>
  disabled?: boolean
}) {
  if (props.operation === 'identity.email_bind') {
    const email =
      typeof props.parameters.email === 'string' ? props.parameters.email : ''
    return (
      <EmailBindingHelp key={email} email={email} disabled={props.disabled} />
    )
  }
  if (props.operation === 'identity.wechat_bind') return <WeChatBindingHelp />
  return null
}
