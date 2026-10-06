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
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'
import type { AxiosRequestConfig } from 'axios'
import i18next from 'i18next'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { OAuthCallbackScreen } from '@/features/auth/components/oauth-callback-screen'
import {
  OAUTH_BIND_CALLBACK_MESSAGE,
  OAUTH_BIND_RESULT_MESSAGE,
} from '@/features/auth/constants'
import { sanitizeAuthRedirect } from '@/features/auth/lib/auth-redirect'
import {
  parseTelegramBindCallback,
  postTelegramBindResult,
  startOAuthBindResponseDeadline,
} from '@/features/auth/lib/oauth-bind-window'
import {
  consumeOAuthLoginRedirect,
  getOAuthSessionStorage,
  resolveOAuthCallbackMode,
} from '@/features/auth/lib/oauth-callback-mode'
import type { LoginResponse } from '@/features/auth/types'
import { api, applyAuthBundle, isAuthBundle } from '@/lib/api'
import { getServerErrorMessageKey } from '@/lib/server-error-message'
import { useAuthStore } from '@/stores/auth-store'

type OAuthRequestConfig = AxiosRequestConfig & {
  skipBusinessError?: boolean
  skipErrorHandler?: boolean
  skipAuthRefresh?: boolean
  skipPanelAuth?: boolean
}

const callbackSearchSchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    telegram_bind: z.string().optional(),
    flow_token: z.string().optional(),
    error_code: z.string().optional(),
  })
  .refine((value) => !(value.code && value.error))

interface OAuthBindingResult {
  type: typeof OAUTH_BIND_RESULT_MESSAGE
  provider: string
  state: string
  success: boolean
  message?: string
}

function OAuthCallback() {
  const navigate = useNavigate()
  const loginExchange = useRef<{
    key: string
    redirect: string | null
    sessionID: string | undefined
    userID: number | undefined
    request: Promise<{ data: LoginResponse }>
  } | null>(null)
  const completedLogin = useRef<string | null>(null)
  const { provider } = useParams({ from: '/oauth/$provider' }) as {
    provider: string
  }
  const searchResult = callbackSearchSchema.safeParse(
    useSearch({ from: '/oauth/$provider' })
  )
  const validSearch = searchResult.success
  const search = searchResult.data ?? {}
  const callbackState = search.state ?? ''
  const isTelegramBindCallback =
    provider === 'telegram' &&
    (search.telegram_bind === 'success' || search.telegram_bind === 'error')
  let mode: 'login' | 'bind' = 'login'
  if (isTelegramBindCallback) {
    mode = 'bind'
  } else if (typeof window !== 'undefined') {
    mode = resolveOAuthCallbackMode(provider, callbackState, {
      opener: window.opener,
      storage: getOAuthSessionStorage(window),
    })
  }

  useEffect(() => {
    if (typeof window === 'undefined') return

    if (!validSearch) {
      if (completedLogin.current === 'invalid-search') return
      completedLogin.current = 'invalid-search'
      toast.error(i18next.t('OAuth failed'))
      void navigate({ to: '/sign-in', replace: true })
      return
    }

    const code = search.code ?? ''
    const state = callbackState
    const telegramCallback =
      provider === 'telegram'
        ? parseTelegramBindCallback({
            telegram_bind: search.telegram_bind,
            flow_token: search.flow_token,
            error_code: search.error_code,
          })
        : null
    if (telegramCallback) {
      const opener = window.opener
      if (
        !postTelegramBindResult(
          telegramCallback,
          opener,
          window.location.origin
        )
      ) {
        toast.error(i18next.t('Telegram binding failed. Please try again.'))
        const closeTimeout = window.setTimeout(() => window.close(), 1500)
        return () => window.clearTimeout(closeTimeout)
      }
      window.close()
      return
    }

    if (mode === 'bind') {
      const opener = window.opener
      if (!opener || opener.closed) {
        toast.error(i18next.t('OAuth binding window is no longer available'))
        return
      }

      let cancelResultTimeout: () => void = () => undefined
      let delayedClose: number | undefined
      const handleBindingResult = (event: MessageEvent<unknown>) => {
        if (
          event.origin !== window.location.origin ||
          event.source !== opener
        ) {
          return
        }
        const result = event.data as Partial<OAuthBindingResult> | null
        if (
          !result ||
          result.type !== OAUTH_BIND_RESULT_MESSAGE ||
          result.provider !== provider ||
          result.state !== state
        ) {
          return
        }
        cancelResultTimeout()
        if (result.success) {
          toast.success(i18next.t('Binding successful!'))
          window.close()
          return
        }
        toast.error(result.message || i18next.t('OAuth failed'))
        delayedClose = window.setTimeout(() => window.close(), 1500)
      }

      window.addEventListener('message', handleBindingResult)
      cancelResultTimeout = startOAuthBindResponseDeadline(() => {
        toast.error(i18next.t('OAuth binding timed out. Please try again.'))
        delayedClose = window.setTimeout(() => window.close(), 1500)
      })
      opener.postMessage(
        {
          type: OAUTH_BIND_CALLBACK_MESSAGE,
          provider,
          code,
          state,
          error: search.error,
          errorDescription: search.error_description,
        },
        window.location.origin
      )
      return () => {
        window.removeEventListener('message', handleBindingResult)
        cancelResultTimeout()
        if (delayedClose !== undefined) window.clearTimeout(delayedClose)
      }
    }

    const safeNavigate = (target: unknown, fallback = '/dashboard') => {
      const href =
        sanitizeAuthRedirect(target, window.location.origin) ?? fallback
      void navigate({ href, replace: true })
    }

    const loginKey = JSON.stringify([provider, state, code, search.error])
    if (completedLogin.current === loginKey) return

    if (!state || (!code && !search.error)) {
      const redirect = consumeOAuthLoginRedirect(provider, state)
      completedLogin.current = loginKey
      toast.error(i18next.t('OAuth failed'))
      safeNavigate(
        redirect
          ? `/sign-in?redirect=${encodeURIComponent(redirect)}`
          : '/sign-in',
        '/sign-in'
      )
      return
    }

    if (loginExchange.current?.key !== loginKey) {
      const config: OAuthRequestConfig = {
        params: {
          code: code || undefined,
          state,
          error: search.error,
          error_description: search.error_description,
        },
        skipBusinessError: true,
        skipErrorHandler: true,
        skipAuthRefresh: true,
        skipPanelAuth: true,
      }
      const auth = useAuthStore.getState().auth
      loginExchange.current = {
        key: loginKey,
        redirect: consumeOAuthLoginRedirect(provider, state),
        sessionID: auth.session?.sid,
        userID: auth.user?.id,
        request: api.get<LoginResponse>(`/api/oauth/${provider}`, config),
      }
    }
    const exchange = loginExchange.current
    let active = true
    void (async () => {
      try {
        const response = await exchange.request
        const auth = useAuthStore.getState().auth
        if (
          !active ||
          auth.session?.sid !== exchange.sessionID ||
          auth.user?.id !== exchange.userID
        ) {
          return
        }
        completedLogin.current = loginKey
        if (response.data?.success && isAuthBundle(response.data?.data)) {
          applyAuthBundle(response.data.data)
          safeNavigate(exchange.redirect)
          toast.success(i18next.t('Signed in successfully!'))
          return
        }
        const messageKey = getServerErrorMessageKey(response.data)
        toast.error(i18next.t(messageKey || 'OAuth failed'))
      } catch (error: unknown) {
        const auth = useAuthStore.getState().auth
        if (
          !active ||
          auth.session?.sid !== exchange.sessionID ||
          auth.user?.id !== exchange.userID
        ) {
          return
        }
        completedLogin.current = loginKey
        const messageKey = getServerErrorMessageKey(error)
        toast.error(i18next.t(messageKey || 'OAuth failed'))
      }
      safeNavigate(
        exchange.redirect
          ? `/sign-in?redirect=${encodeURIComponent(exchange.redirect)}`
          : '/sign-in',
        '/sign-in'
      )
    })()
    return () => {
      active = false
    }
  }, [
    callbackState,
    validSearch,
    mode,
    navigate,
    provider,
    search.code,
    search.error,
    search.error_code,
    search.error_description,
    search.flow_token,
    search.telegram_bind,
  ])

  return <OAuthCallbackScreen provider={provider} mode={mode} />
}

export const Route = createFileRoute('/oauth/$provider')({
  component: OAuthCallback,
})
