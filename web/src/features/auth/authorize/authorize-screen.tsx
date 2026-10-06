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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useAuthStore } from '@/stores/auth-store'

import {
  buildConsentQuery,
  loadConsent,
  respondToConsent,
  type AuthorizeSearchParams,
  type ConsentPreview,
} from './api'
import { ConsentPermissions } from './components/consent-permissions'
import { safeOAuthWebUrl } from './lib/authorization-redirect'

export type { AuthorizeSearchParams } from './api'

function AuthorizationMessage(props: { title: string; description?: string }) {
  const { t } = useTranslation()
  return (
    <Card className='w-full max-w-lg'>
      <CardHeader>
        <CardTitle>{t(props.title)}</CardTitle>
        {props.description && (
          <CardDescription className='break-words'>
            {t(props.description)}
          </CardDescription>
        )}
      </CardHeader>
    </Card>
  )
}

function AuthorizationRedirect(props: { url: string; denied: boolean }) {
  useEffect(() => {
    window.location.replace(props.url)
  }, [props.url])

  return (
    <AuthorizationMessage
      title={props.denied ? 'Authorization denied' : 'Authorization complete'}
      description='Redirecting you back to the application...'
    />
  )
}

export function AuthorizeScreen(props: AuthorizeSearchParams) {
  const authUser = useAuthStore((state) => state.auth.user)
  const sessionID = useAuthStore((state) => state.auth.session?.sid || '')
  if (props.error) {
    return (
      <AuthorizationMessage
        title='Authorization failed'
        description='The authorization request is invalid or was declined. Return to the application and try again.'
      />
    )
  }
  if (!authUser) {
    return (
      <AuthorizationMessage
        title='Sign in to continue'
        description='You need to sign in to authorize this application. Redirecting to sign in...'
      />
    )
  }
  const requestKey = `${authUser.id}:${sessionID}:${buildConsentQuery(props)}`
  return (
    <AuthorizationRequest
      key={requestKey}
      params={props}
      requestKey={requestKey}
      username={authUser.username}
    />
  )
}

function AuthorizationRequest(props: {
  params: AuthorizeSearchParams
  requestKey: string
  username: string
}) {
  const { t } = useTranslation()
  const [responseError, setResponseError] = useState(false)
  const [retrySelection, setRetrySelection] = useState<string[] | undefined>()
  const query = useQuery({
    queryKey: ['oauth-consent', props.requestKey],
    queryFn: ({ signal }) => loadConsent(props.params, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { errorToast: false },
  })

  if (query.isPending || query.isFetching) {
    return <AuthorizationMessage title='Loading...' />
  }
  if (query.isError || !query.data) {
    return (
      <Card className='w-full max-w-lg'>
        <CardHeader>
          <CardTitle>{t('Authorization failed')}</CardTitle>
          <CardDescription>
            {t('Failed to load authorization request')}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => void query.refetch()}
          >
            {t('Retry')}
          </Button>
        </CardFooter>
      </Card>
    )
  }
  return (
    <ConsentForm
      key={query.data.consentToken}
      params={props.params}
      preview={query.data}
      username={props.username}
      responseError={responseError}
      initialScopes={retrySelection?.filter((scope) =>
        query.data.scopes.includes(scope)
      )}
      onFailed={(scopes) => {
        setRetrySelection(scopes)
        setResponseError(true)
        void query.refetch()
      }}
    />
  )
}

function ConsentForm(props: {
  params: AuthorizeSearchParams
  preview: ConsentPreview
  username: string
  responseError: boolean
  initialScopes?: string[]
  onFailed: (scopes: string[]) => void
}) {
  const { t } = useTranslation()
  const [selectedScopes, setSelectedScopes] = useState(
    props.initialScopes || props.preview.scopes
  )
  const [redirect, setRedirect] = useState<{
    url: string
    denied: boolean
  } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const mutation = useMutation({
    mutationFn: (approve: boolean) =>
      respondToConsent(props.params, props.preview, approve, selectedScopes),
    retry: false,
    meta: { errorToast: false },
    onSuccess: (result) => {
      if (mounted.current) setRedirect(result)
    },
    onError: () => {
      if (mounted.current) props.onFailed(selectedScopes)
    },
  })
  if (redirect) return <AuthorizationRedirect {...redirect} />

  const clientURI = safeOAuthWebUrl(props.preview.client.uri || '')
  const callbackURI = safeOAuthWebUrl(props.params.redirect_uri || '')
  return (
    <Card className='w-full max-w-2xl min-w-0'>
      <CardHeader className='min-w-0 grid-cols-[minmax(0,1fr)]'>
        <CardTitle>{t('Authorize application')}</CardTitle>
        <CardDescription className='min-w-0 break-words'>
          {t('"{{name}}" wants to access your account', {
            name: props.preview.client.name,
          })}
        </CardDescription>
        {props.preview.client.description && (
          <p className='text-muted-foreground min-w-0 text-sm break-words'>
            {props.preview.client.description}
          </p>
        )}
        {callbackURI && (
          <p className='text-muted-foreground min-w-0 text-sm break-all'>
            {t('Application address')}
            {': '}
            {callbackURI.origin}
          </p>
        )}
        {clientURI && (
          <a
            className='text-primary text-sm break-all underline underline-offset-4'
            href={clientURI.href}
            target='_blank'
            rel='noopener noreferrer'
          >
            {clientURI.hostname}
          </a>
        )}
      </CardHeader>
      <CardContent className='space-y-5'>
        {props.responseError && (
          <Alert variant='destructive'>
            <AlertTitle>{t('Failed to process authorization')}</AlertTitle>
            <AlertDescription>
              {t(
                'The request has been refreshed. Review the permissions before trying again.'
              )}
            </AlertDescription>
          </Alert>
        )}
        <ConsentPermissions
          capabilities={props.preview.capabilities}
          resources={props.preview.resources}
          selectedScopes={selectedScopes}
          disabled={mutation.isPending}
          onChange={setSelectedScopes}
        />
        <p className='text-muted-foreground text-xs'>
          {t('Signed in as')}{' '}
          <strong className='break-all'>{props.username}</strong>
        </p>
      </CardContent>
      <CardFooter className='flex-col items-stretch gap-3'>
        <p className='text-muted-foreground text-xs'>
          {t(
            'You can reduce or revoke this access later in Authorized applications.'
          )}
        </p>
        <div className='flex flex-wrap gap-2'>
          <Button
            type='button'
            variant='outline'
            className='flex-1'
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(false)}
          >
            {t('Deny')}
          </Button>
          <Button
            type='button'
            className='flex-1'
            disabled={mutation.isPending || selectedScopes.length === 0}
            onClick={() => mutation.mutate(true)}
          >
            {t('Approve')}
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
