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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export type AuthorizeSearchParams = {
  client_id?: string
  redirect_uri?: string
  scope?: string
  state?: string
  nonce?: string
  code_challenge?: string
  code_challenge_method?: string
  error?: string
  error_description?: string
}

interface ConsentResponse {
  success: boolean
  message?: string
  require_consent?: boolean
  redirect?: string
  client?: { name: string; description: string }
  scopes?: string[]
}

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm your identity',
  profile: 'View your username, display name, groups and balance',
  email: 'View your email address',
}

function buildConsentQuery(props: AuthorizeSearchParams): string {
  const params = new URLSearchParams()
  const keys = [
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ] as const
  for (const key of keys) {
    const value = props[key]
    if (value) params.set(key, value)
  }
  return params.toString()
}

export function AuthorizeScreen(props: AuthorizeSearchParams) {
  const { t } = useTranslation()
  const authUser = useAuthStore((s) => s.auth.user)
  const [clientName, setClientName] = useState('')
  const [clientDescription, setClientDescription] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError] = useState('')

  const consentQuery = buildConsentQuery(props)

  useEffect(() => {
    if (!authUser) return
    let cancelled = false
    setLoading(true)
    void api
      .get(`/api/oauth2/consent?${consentQuery}`)
      .then((res) => {
        if (cancelled) return
        const data = res.data as ConsentResponse
        if (!data.success) {
          setLoadError(data.message || t('Failed to load authorization request'))
          return
        }
        if (data.redirect) {
          setPendingRedirect(data.redirect)
          return
        }
        setClientName(data.client?.name || props.client_id || '')
        setClientDescription(data.client?.description || '')
        setScopes(data.scopes || [])
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLoadError(
          error instanceof Error
            ? error.message
            : t('Failed to load authorization request')
        )
      })
      .then(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, consentQuery])

  useEffect(() => {
    if (pendingRedirect) {
      window.location.replace(pendingRedirect)
    }
  }, [pendingRedirect])

  const respond = async (approve: boolean) => {
    setSubmitting(true)
    try {
      const body = {
        client_id: props.client_id,
        redirect_uri: props.redirect_uri,
        scope: props.scope,
        state: props.state,
        nonce: props.nonce,
        code_challenge: props.code_challenge,
        code_challenge_method: props.code_challenge_method,
        approve,
      }
      const res = await api.post('/api/oauth2/consent', body)
      const data = res.data as ConsentResponse
      if (!data.success || !data.redirect) {
        toast.error(data.message || t('Failed to process authorization'))
        return
      }
      setPendingRedirect(data.redirect)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('An error occurred')
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (props.error) {
    return (
      <Card className='w-full max-w-md'>
        <CardHeader>
          <CardTitle>{t('Authorization failed')}</CardTitle>
          <CardDescription>{props.error_description || props.error}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!authUser) {
    return (
      <Card className='w-full max-w-md'>
        <CardHeader>
          <CardTitle>{t('Sign in to continue')}</CardTitle>
          <CardDescription>
            {t(
              'You need to sign in to authorize this application. Redirecting to sign in...'
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (pendingRedirect) {
    return (
      <Card className='w-full max-w-md'>
        <CardHeader>
          <CardTitle>{t('Authorization complete')}</CardTitle>
          <CardDescription>
            {t('Redirecting you back to the application...')}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (loading) {
    return (
      <Card className='w-full max-w-md'>
        <CardHeader>
          <CardTitle>{t('Loading...')}</CardTitle>
        </CardHeader>
      </Card>
    )
  }

  if (loadError) {
    return (
      <Card className='w-full max-w-md'>
        <CardHeader>
          <CardTitle>{t('Authorization failed')}</CardTitle>
          <CardDescription>{loadError}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card className='w-full max-w-md'>
      <CardHeader>
        <CardTitle>{t('Authorize application')}</CardTitle>
        <CardDescription>
          {t('"{{name}}" wants to access your account', {
            name: clientName,
          })}
          {clientDescription ? ` — ${clientDescription}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <Alert>
          <AlertTitle>{t('This application will be able to:')}</AlertTitle>
          <AlertDescription>
            <ul className='list-inside list-disc space-y-1'>
              {scopes.map((scope) => (
                <li key={scope}>
                  {SCOPE_LABELS[scope]
                    ? t(SCOPE_LABELS[scope])
                    : scope}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
        <p className='text-muted-foreground text-xs'>
          {t('Signed in as')} <strong>{authUser.username}</strong>
        </p>
        <div className='flex gap-2'>
          <Button
            variant='outline'
            className='flex-1'
            disabled={submitting}
            onClick={() => respond(false)}
          >
            {t('Deny')}
          </Button>
          <Button
            className='flex-1'
            disabled={submitting}
            onClick={() => respond(true)}
          >
            {t('Approve')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
