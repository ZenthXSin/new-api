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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { TelegramLoginDialog } from '@/features/auth/components/telegram-login-dialog'
import { watchOAuthPopupClosed } from '@/features/auth/lib/oauth-bind-window'
import { useAuthStore } from '@/stores/auth-store'

import {
  completeHostedTelegramBinding,
  getHostedBindingStatus,
  getHostedTelegramCallback,
  type HostedBindingResult,
} from '../lib/binding-action'

interface HostedTelegramBindingProps {
  payload: unknown
  onComplete: (result: HostedBindingResult) => void
  onCancel: () => void
  disabled?: boolean
}

export function HostedTelegramBinding(props: HostedTelegramBindingProps) {
  const { t } = useTranslation()
  const [botName, setBotName] = useState('')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const popup = useRef<Window | null>(null)
  const stopClosed = useRef<() => void>(() => undefined)
  const active = useRef(true)
  const lock = useRef(false)
  const identity = useRef({
    userID: useAuthStore.getState().auth.user?.id,
    sessionID: useAuthStore.getState().auth.session?.sid,
  })

  useEffect(() => {
    active.current = true
    const abort = new AbortController()
    let current = true
    void getHostedBindingStatus(abort.signal)
      .then((status) => {
        if (!current) return
        if (!status.telegram_oauth || !status.telegram_bot_name?.trim()) {
          setFailed(true)
          return
        }
        setBotName(status.telegram_bot_name.trim().replace(/^@/, ''))
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (
        state.auth.user?.id === identity.current.userID &&
        state.auth.session?.sid === identity.current.sessionID
      ) {
        return
      }
      operation.current?.abort()
      stopClosed.current()
      popup.current?.close()
      setOpen(false)
      setFailed(true)
    })
    return () => {
      current = false
      active.current = false
      abort.abort()
      operation.current?.abort()
      stopClosed.current()
      popup.current?.close()
      unsubscribe()
    }
  }, [])

  const close = () => {
    operation.current?.abort()
    stopClosed.current()
    popup.current?.close()
    popup.current = null
    lock.current = false
    setOpen(false)
    setPending(false)
  }

  const start = () => {
    if (
      props.disabled ||
      !botName ||
      lock.current ||
      (popup.current && !popup.current.closed)
    ) {
      return
    }
    const auth = useAuthStore.getState().auth
    if (
      !auth.user ||
      !auth.session ||
      auth.user.id !== identity.current.userID ||
      auth.session.sid !== identity.current.sessionID
    ) {
      setFailed(true)
      return
    }
    try {
      getHostedTelegramCallback(props.payload)
      const next = window.open('', '_blank')
      if (!next) throw new Error()
      popup.current = next
      operation.current = new AbortController()
      stopClosed.current = watchOAuthPopupClosed(next, () => {
        operation.current?.abort()
        if (!active.current) return
        lock.current = false
        setPending(false)
        setOpen(false)
      })
      setFailed(false)
      setOpen(true)
    } catch {
      close()
      setFailed(true)
    }
  }

  const authorize = async (authorization: unknown) => {
    const target = popup.current
    if (!target || target.closed || !open || lock.current || props.disabled) {
      return
    }
    const auth = useAuthStore.getState().auth
    if (
      auth.user?.id !== identity.current.userID ||
      auth.session?.sid !== identity.current.sessionID
    ) {
      close()
      setFailed(true)
      return
    }
    lock.current = true
    setPending(true)
    stopClosed.current()
    const signal = operation.current?.signal
    try {
      const result = await completeHostedTelegramBinding(
        props.payload,
        authorization,
        target,
        signal
      )
      if (!active.current || signal?.aborted) return
      close()
      props.onComplete(result)
    } catch {
      if (!active.current || signal?.aborted) return
      close()
      setFailed(true)
    }
  }

  return (
    <div className='space-y-3'>
      {failed && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('Telegram binding failed. Please try again.')}
          </AlertDescription>
        </Alert>
      )}
      <div className='flex flex-wrap gap-2'>
        <Button
          type='button'
          onClick={start}
          disabled={props.disabled || !botName || open || pending}
        >
          {t('Continue with Telegram')}
        </Button>
        <Button
          type='button'
          variant='outline'
          disabled={props.disabled || pending}
          onClick={() => {
            close()
            props.onCancel()
          }}
        >
          {t('Cancel')}
        </Button>
      </div>
      <TelegramLoginDialog
        open={open}
        botName={botName}
        pending={pending}
        onOpenChange={(next) => {
          if (!next) close()
        }}
        onAuthorization={(value) => {
          void authorize(value)
        }}
      />
    </div>
  )
}
