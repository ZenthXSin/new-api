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
import { z } from 'zod'

import {
  OAUTH_BIND_CALLBACK_MESSAGE,
  OAUTH_BIND_RESULT_MESSAGE,
  TELEGRAM_BIND_RESULT_MESSAGE,
} from '@/features/auth/constants'
import { watchOAuthPopupClosed } from '@/features/auth/lib/oauth-bind-window'
import {
  getOAuthSessionStorage,
  markOAuthBindPopup,
} from '@/features/auth/lib/oauth-callback-mode'
import { pickTelegramAuthorization } from '@/features/auth/lib/telegram-login'
import { api } from '@/lib/api'
import {
  buildDiscordOAuthUrl,
  buildGitHubOAuthUrl,
  buildLinuxDOOAuthUrl,
  buildOIDCOAuthUrl,
} from '@/lib/oauth'
import { useAuthStore } from '@/stores/auth-store'

const privateRequest = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipAuthRefresh: true,
  skipRequestDedup: true,
}
const flowSchema = z.object({
  flow_token: z.string().min(1).max(16384),
  expires_at: z.number().finite().positive().optional(),
})
const callbackSchema = z.object({
  type: z.literal(OAUTH_BIND_CALLBACK_MESSAGE),
  provider: z.string(),
  state: z.string(),
  code: z.string().min(1).max(16384).optional(),
  error: z.string().optional(),
})
const statusSchema = z.object({
  github_oauth: z.boolean().optional(),
  github_client_id: z.string().optional(),
  discord_oauth: z.boolean().optional(),
  discord_client_id: z.string().optional(),
  oidc_enabled: z.boolean().optional(),
  oidc_client_id: z.string().optional(),
  oidc_authorization_endpoint: z.string().optional(),
  linuxdo_oauth: z.boolean().optional(),
  linuxdo_client_id: z.string().optional(),
  telegram_oauth: z.boolean().optional(),
  telegram_bot_name: z.string().optional(),
  custom_oauth_providers: z
    .array(
      z.object({
        slug: z.string(),
        client_id: z.string(),
        authorization_endpoint: z.string(),
        scopes: z.string().optional(),
      })
    )
    .optional(),
})

export interface HostedBindingResult {
  flow_token: string
}

function bindingError(): Error {
  return new Error(i18next.t('OAuth failed'))
}

export function parseHostedBindingFlow(
  payload: unknown
): z.infer<typeof flowSchema> {
  const flow = flowSchema.parse(payload)
  if (flow.expires_at !== undefined && flow.expires_at * 1000 <= Date.now()) {
    throw bindingError()
  }
  return flow
}

export async function getHostedBindingStatus(signal?: AbortSignal) {
  try {
    const response = await api.get('/api/status', { ...privateRequest, signal })
    if (response.data?.success !== true) throw bindingError()
    return statusSchema.parse(response.data.data)
  } catch {
    throw bindingError()
  }
}

/** Called directly from a click so the empty popup retains user activation. */
export async function startHostedBinding(
  kind: 'oauth-bind',
  payload: unknown,
  parameters: Record<string, unknown>,
  signal?: AbortSignal
): Promise<HostedBindingResult> {
  let popup: Window | null = null
  try {
    const flow = parseHostedBindingFlow(payload)
    const provider = z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .parse(parameters.provider)
    if (kind !== 'oauth-bind' || signal?.aborted) throw bindingError()
    const auth = useAuthStore.getState().auth
    const userID = auth.user?.id
    const sessionID = auth.session?.sid
    if (!userID || !sessionID) throw bindingError()
    popup = window.open('', '_blank')
    if (!popup) throw new Error(i18next.t('OAuth pop-up was blocked'))
    const bindingPopup = popup
    const requestAbort = new AbortController()

    return await new Promise<HostedBindingResult>((resolve, reject) => {
      let settled = false
      let exchanging = false
      let stopClosed: () => void = () => undefined
      let stopSession: () => void = () => undefined
      const finish = (success: boolean) => {
        if (settled) return
        settled = true
        window.removeEventListener('message', handleMessage)
        signal?.removeEventListener('abort', handleAbort)
        stopClosed()
        stopSession()
        clearTimeout(timeout)
        requestAbort.abort()
        if (!bindingPopup.closed) bindingPopup.close()
        if (success) resolve({ flow_token: flow.flow_token })
        else reject(bindingError())
      }
      const handleAbort = () => finish(false)
      const handleMessage = async (event: MessageEvent<unknown>) => {
        if (
          settled ||
          exchanging ||
          event.origin !== window.location.origin ||
          event.source !== bindingPopup
        ) {
          return
        }
        const parsed = callbackSchema.safeParse(event.data)
        if (
          !parsed.success ||
          parsed.data.provider !== provider ||
          parsed.data.state !== flow.flow_token
        ) {
          return
        }
        if (!parsed.data.code || parsed.data.error) {
          finish(false)
          return
        }
        exchanging = true
        try {
          const response = await api.get(
            `/api/oauth/${encodeURIComponent(provider)}`,
            {
              ...privateRequest,
              params: { code: parsed.data.code, state: flow.flow_token },
              signal: requestAbort.signal,
            }
          )
          const current = useAuthStore.getState().auth
          if (
            settled ||
            current.user?.id !== userID ||
            current.session?.sid !== sessionID
          ) {
            return
          }
          const success = response.data?.success === true
          bindingPopup.postMessage(
            {
              type: OAUTH_BIND_RESULT_MESSAGE,
              provider,
              state: flow.flow_token,
              success,
              message: success ? undefined : i18next.t('OAuth failed'),
            },
            window.location.origin
          )
          finish(success)
        } catch {
          finish(false)
        }
      }
      window.addEventListener('message', handleMessage)
      signal?.addEventListener('abort', handleAbort, { once: true })
      stopClosed = watchOAuthPopupClosed(bindingPopup, handleAbort)
      stopSession = useAuthStore.subscribe((state) => {
        if (
          state.auth.user?.id !== userID ||
          state.auth.session?.sid !== sessionID
        ) {
          finish(false)
        }
      })
      const timeout = setTimeout(
        handleAbort,
        Math.min(
          10 * 60 * 1000,
          (flow.expires_at ?? Date.now() / 1000 + 600) * 1000 - Date.now()
        )
      )
      if (signal?.aborted) {
        finish(false)
        return
      }
      void (async () => {
        try {
          const status = await getHostedBindingStatus(requestAbort.signal)
          if (settled || bindingPopup.closed) return
          let url: URL | undefined
          if (
            provider === 'github' &&
            status.github_oauth &&
            status.github_client_id
          ) {
            url = new URL(
              buildGitHubOAuthUrl(status.github_client_id, flow.flow_token)
            )
          } else if (
            provider === 'discord' &&
            status.discord_oauth &&
            status.discord_client_id
          ) {
            url = new URL(
              buildDiscordOAuthUrl(status.discord_client_id, flow.flow_token)
            )
          } else if (
            provider === 'oidc' &&
            status.oidc_enabled &&
            status.oidc_client_id &&
            status.oidc_authorization_endpoint
          ) {
            url = new URL(
              buildOIDCOAuthUrl(
                status.oidc_authorization_endpoint,
                status.oidc_client_id,
                flow.flow_token
              )
            )
          } else if (
            provider === 'linuxdo' &&
            status.linuxdo_oauth &&
            status.linuxdo_client_id
          ) {
            url = new URL(
              buildLinuxDOOAuthUrl(status.linuxdo_client_id, flow.flow_token)
            )
          } else {
            const custom = status.custom_oauth_providers?.find(
              (item) => item.slug === provider
            )
            if (custom) {
              url = new URL(custom.authorization_endpoint)
              url.searchParams.set('client_id', custom.client_id)
              url.searchParams.set(
                'redirect_uri',
                `${window.location.origin}/oauth/${provider}`
              )
              url.searchParams.set('response_type', 'code')
              if (custom.scopes) url.searchParams.set('scope', custom.scopes)
            }
          }
          if (
            !url ||
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash
          ) {
            throw bindingError()
          }
          url.searchParams.set('state', flow.flow_token)
          if (
            !markOAuthBindPopup(
              getOAuthSessionStorage(bindingPopup),
              provider,
              flow.flow_token
            )
          ) {
            throw bindingError()
          }
          bindingPopup.location.replace(url.toString())
        } catch {
          finish(false)
        }
      })()
    })
  } catch {
    if (popup && !popup.closed) popup.close()
    throw bindingError()
  }
}

/** The server-supplied callback must address only this exact local bind flow. */
export function getHostedTelegramCallback(payload: unknown): {
  flow_token: string
  callbackURL: URL
} {
  const flow = parseHostedBindingFlow(payload)
  const result = z.object({ callback_url: z.string() }).parse(payload)
  const callbackURL = new URL(result.callback_url, window.location.origin)
  if (
    callbackURL.origin !== window.location.origin ||
    callbackURL.pathname !==
      `/api/oauth/telegram/bind/${encodeURIComponent(flow.flow_token)}` ||
    callbackURL.search ||
    callbackURL.hash ||
    callbackURL.username ||
    callbackURL.password ||
    [...result.callback_url].some(
      (char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127
    ) ||
    result.callback_url.includes('\\')
  ) {
    throw bindingError()
  }
  return { flow_token: flow.flow_token, callbackURL }
}

export async function completeHostedTelegramBinding(
  payload: unknown,
  authorization: unknown,
  popup: Window,
  signal?: AbortSignal
): Promise<HostedBindingResult> {
  try {
    const target = getHostedTelegramCallback(payload)
    const signed = pickTelegramAuthorization(authorization)
    const auth = useAuthStore.getState().auth
    const userID = auth.user?.id
    const sessionID = auth.session?.sid
    if (!signed || !userID || !sessionID || signal?.aborted || popup.closed) {
      throw bindingError()
    }
    for (const [key, value] of Object.entries(signed)) {
      target.callbackURL.searchParams.set(key, String(value))
    }
    return await new Promise<HostedBindingResult>((resolve, reject) => {
      let settled = false
      let stopClosed: () => void = () => undefined
      let stopSession: () => void = () => undefined
      const finish = (success: boolean) => {
        if (settled) return
        settled = true
        window.removeEventListener('message', handleMessage)
        signal?.removeEventListener('abort', handleAbort)
        stopClosed()
        stopSession()
        clearTimeout(timeout)
        if (!popup.closed) popup.close()
        if (success) resolve({ flow_token: target.flow_token })
        else reject(bindingError())
      }
      const handleAbort = () => finish(false)
      const handleMessage = (event: MessageEvent<unknown>) => {
        if (event.origin !== window.location.origin || event.source !== popup) {
          return
        }
        const data = event.data as Record<string, unknown> | null
        if (
          !data ||
          data.type !== TELEGRAM_BIND_RESULT_MESSAGE ||
          data.flow_token !== target.flow_token
        ) {
          return
        }
        finish(data.success === true)
      }
      window.addEventListener('message', handleMessage)
      signal?.addEventListener('abort', handleAbort, { once: true })
      stopClosed = watchOAuthPopupClosed(popup, handleAbort)
      stopSession = useAuthStore.subscribe((state) => {
        if (
          state.auth.user?.id !== userID ||
          state.auth.session?.sid !== sessionID
        ) {
          finish(false)
        }
      })
      const expiresAt = parseHostedBindingFlow(payload).expires_at
      const timeout = setTimeout(
        handleAbort,
        Math.min(
          5 * 60 * 1000,
          (expiresAt ?? Date.now() / 1000 + 300) * 1000 - Date.now()
        )
      )
      if (signal?.aborted) finish(false)
      else popup.location.replace(target.callbackURL.toString())
    })
  } catch {
    if (!popup.closed) popup.close()
    throw bindingError()
  }
}
