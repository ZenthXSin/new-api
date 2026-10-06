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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  SecureVerificationDialog,
  type SecurityProofScope,
} from '@/features/auth/secure-verification'
import { useAuthStore } from '@/stores/auth-store'

import {
  assertHostedSession,
  decideHostedAction,
  executeHostedActionStep,
  getHostedActionApproval,
  getHostedVerificationMethods,
} from './api'
import { HostedActionResult } from './components/action-result'
import { ActionReviewCard } from './components/action-review-card'
import { ActionStepForm } from './components/action-step-form'
import { HostedTelegramBinding } from './components/hosted-telegram-binding'
import { IdentityBindingHelp } from './components/identity-binding-help'
import { useHostedVerification } from './hooks/use-hosted-verification'
import { startHostedBinding } from './lib/binding-action'
import { completeHostedPasskey } from './lib/passkey-action'
import type { HostedActionApproval, HostedSessionIdentity } from './types'

export function HostedOAuthAction(props: { actionID: string }) {
  const { t } = useTranslation()
  const userID = useAuthStore((store) => store.auth.user?.id)
  const sessionID = useAuthStore((store) => store.auth.session?.sid)
  if (!userID || !sessionID) {
    return (
      <Alert>
        <AlertDescription>
          {t('Sign in to your account to review this app request.')}
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <HostedActionSession
      key={`${props.actionID}:${userID}:${sessionID}`}
      actionID={props.actionID}
      identity={{ userID, sessionID }}
    />
  )
}

function HostedActionSession(props: {
  actionID: string
  identity: HostedSessionIdentity
}) {
  const { t } = useTranslation()
  const username = useAuthStore((store) => store.auth.user?.username)
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<unknown>()
  const [preparedInput, setPreparedInput] = useState<Record<string, unknown>>()
  const [loadingVerification, setLoadingVerification] = useState(false)
  const [pendingBrowser, setPendingBrowser] = useState<{
    kind: 'passkey-register' | 'passkey-verify' | 'oauth-bind' | 'telegram-bind'
    payload: unknown
  }>()
  const [browserBusy, setBrowserBusy] = useState(false)
  const verification = useHostedVerification(props.identity)
  const active = useRef(true)
  const operationAbort = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const queryKey = [
    'oauth-hosted-action',
    props.actionID,
    props.identity.userID,
    props.identity.sessionID,
  ]
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getHostedActionApproval(props.actionID, props.identity, signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    meta: { errorToast: false },
  })
  const action = query.data
  const expired = action && action.expires_at * 1000 <= Date.now()
  const step = action?.steps.find((item) => item.id === action.current_step_id)
  const [, setClock] = useState(0)

  useEffect(() => {
    if (
      !action ||
      action.status === 'completed' ||
      action.status === 'rejected' ||
      expired
    ) {
      return
    }
    const timer = window.setTimeout(
      () => setClock((value) => value + 1),
      Math.min(Math.max(1, action.expires_at * 1000 - Date.now()), 2147483647)
    )
    return () => window.clearTimeout(timer)
  }, [action, expired])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      operationAbort.current?.abort()
    }
  }, [])

  const decision = useMutation({
    gcTime: 0,
    mutationFn: async (approve: boolean) => {
      if (!action) return
      let proof: string | undefined | null
      if (approve && !action.bootstrap_allowed) {
        setLoadingVerification(true)
        try {
          const methods = await getHostedVerificationMethods(props.identity)
          if (!active.current) return
          if (
            methods.has2FA ||
            (methods.hasPasskey && methods.passkeySupported)
          ) {
            proof = await verification.requestProof('channel.key.read')
            if (!proof || !active.current) return
          } else if (action.has_two_factor) {
            throw new Error(
              t('Use your authenticator or Passkey to approve this request.')
            )
          }
        } finally {
          if (active.current) setLoadingVerification(false)
        }
      }
      assertHostedSession(props.identity)
      const response = await decideHostedAction(
        props.actionID,
        action.approval_nonce,
        approve,
        props.identity,
        approve && !proof && !action.bootstrap_allowed ? password : undefined,
        proof ?? undefined
      )
      if (!active.current) return
      setPassword('')
      setError('')
      setResult(undefined)
      setPreparedInput(undefined)
      setPendingBrowser(undefined)
      if (!approve) verification.clearProofs()
      if (approve) await query.refetch()
      else {
        queryClient.setQueryData(queryKey, {
          ...action,
          status: 'rejected',
          return_uri: response.return_uri,
        })
      }
    },
    onError: (cause) => {
      if (active.current) {
        setError(
          cause instanceof Error
            ? t(cause.message)
            : t(
                'Unable to update this request. Reload its status before trying again.'
              )
        )
      }
    },
    meta: { errorToast: false },
  })

  const runStep = useMutation({
    gcTime: 0,
    mutationFn: async (input: Record<string, unknown>) => {
      if (!action || !step || expired) return
      let proof: string | undefined
      if (step.proof_scope) {
        if (
          !['channel.key.read', 'passkey.register', 'passkey.delete'].includes(
            step.proof_scope
          )
        ) {
          throw new Error(
            t('This request requires an unsupported verification method.')
          )
        }
        const verified = await verification.requestProof(
          step.proof_scope as SecurityProofScope
        )
        if (!verified || !active.current) return
        proof = verified
      }
      assertHostedSession(props.identity)
      const response = await executeHostedActionStep(
        props.actionID,
        step.id,
        action.approval_nonce,
        input,
        props.identity,
        proof
      )
      if (!active.current) return
      setError('')
      setPreparedInput(undefined)
      setResult(response.data)
      if (response.action_status === 'completed') verification.clearProofs()
      const next: HostedActionApproval = {
        ...action,
        status: response.action_status ?? 'approved',
        current_step_id: response.next_step_id ?? '',
        return_uri: response.return_uri ?? action.return_uri,
        steps: action.steps.map((item) =>
          item.id === step.id ? { ...item, state: 'completed' } : item
        ),
      }
      queryClient.setQueryData(queryKey, next)
      if (step.kind) {
        setPendingBrowser({ kind: step.kind, payload: response.data })
        setResult(undefined)
      }
      if (next.status !== 'completed') await query.refetch()
    },
    onError: (cause) => {
      if (active.current) {
        setError(
          cause instanceof Error
            ? t(cause.message)
            : t(
                'The action could not be completed. Check your input and reload its status before retrying.'
              )
        )
      }
    },
    meta: { errorToast: false },
  })

  const pending =
    decision.isPending ||
    runStep.isPending ||
    loadingVerification ||
    verification.state.loading ||
    browserBusy
  const respond = async (approve: boolean) => {
    if (lock.current || pending) return
    lock.current = true
    setError('')
    try {
      await decision.mutateAsync(approve)
    } catch {
      /* Displayed by the mutation. */
    } finally {
      lock.current = false
      decision.reset()
      setPassword('')
    }
  }
  const submitStep = async (input: Record<string, unknown>) => {
    if (lock.current || pending) return
    lock.current = true
    setError('')
    try {
      await runStep.mutateAsync(input)
    } catch {
      /* Displayed by the mutation. */
    } finally {
      lock.current = false
      runStep.reset()
    }
  }

  const completeBrowserStep = async () => {
    if (
      !pendingBrowser ||
      pendingBrowser.kind === 'telegram-bind' ||
      browserBusy
    ) {
      return
    }
    setBrowserBusy(true)
    setError('')
    operationAbort.current = new AbortController()
    try {
      const prepared =
        pendingBrowser.kind === 'oauth-bind'
          ? await startHostedBinding(
              'oauth-bind',
              pendingBrowser.payload,
              action?.parameters ?? {},
              operationAbort.current.signal
            )
          : await completeHostedPasskey(
              pendingBrowser.kind,
              pendingBrowser.payload,
              operationAbort.current.signal
            )
      assertHostedSession(props.identity)
      if (active.current) {
        setPreparedInput({ ...prepared })
        setPendingBrowser(undefined)
      }
    } catch {
      if (active.current) {
        setError(
          t(
            'Browser verification could not be completed. Try again to continue.'
          )
        )
      }
    } finally {
      if (active.current) setBrowserBusy(false)
    }
  }
  const needsBrowserInput = Boolean(
    step?.fields.some(
      (field) => field.name === 'flow_token' || field.name === 'credential'
    )
  )
  const lostSetup =
    action?.operation === 'mfa.setup' && step?.id === 'enable' && !result

  let statusText = t('Review required')
  if (expired || action?.status === 'expired') statusText = t('Expired')
  else if (action?.status === 'completed') statusText = t('Completed')
  else if (action?.status === 'rejected') statusText = t('Rejected')
  else if (action?.status === 'failed') statusText = t('Failed')
  else if (action?.status !== 'pending') statusText = t('In progress')

  let returnURI: string | undefined
  if (action?.return_uri && ['completed', 'rejected'].includes(action.status)) {
    try {
      const target = new URL(action.return_uri)
      if (
        !target.username &&
        !target.password &&
        !target.hash &&
        (target.protocol === 'https:' ||
          (target.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))
      ) {
        returnURI = target.href
      }
    } catch {
      /* Unusable return targets are not shown. */
    }
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {t('Complete an app request')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-2xl flex-col gap-4 pb-4'>
          {query.isPending && <p role='status'>{t('Loading...')}</p>}
          {query.isError && (
            <Alert variant='destructive'>
              <AlertDescription>
                {t(
                  'Unable to load this app request. Reload the page or start again from the app.'
                )}
              </AlertDescription>
              <Button
                type='button'
                variant='outline'
                onClick={() => void query.refetch()}
              >
                {t('Reload')}
              </Button>
            </Alert>
          )}
          {action && !query.isError && (
            <>
              <ActionReviewCard
                action={action}
                username={username}
                statusText={statusText}
              />
              {(expired || action.status === 'expired') && (
                <Alert>
                  <AlertDescription>
                    {t(
                      'The request has expired. Start a new request from the app.'
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {action.status === 'completed' && (
                <Alert>
                  <AlertDescription>
                    {t(
                      'The requested action is complete. You can return to the app.'
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {action.status === 'rejected' && (
                <Alert>
                  <AlertDescription>
                    {t('You rejected this request. No further steps will run.')}
                  </AlertDescription>
                </Alert>
              )}
              {(error || verification.error) && (
                <Alert variant='destructive'>
                  <AlertDescription>
                    {error || verification.error}
                  </AlertDescription>
                </Alert>
              )}
              {!expired && action.status === 'pending' && (
                <Card>
                  <CardContent className='flex flex-col gap-4'>
                    {action.bootstrap_allowed && (
                      <Alert>
                        <AlertDescription>
                          {t(
                            'Your recent sign-in allows you to set up your first verification method. Confirm that you requested this setup.'
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                    {action.bootstrap_operation &&
                      !action.bootstrap_allowed &&
                      action.has_password === false &&
                      !action.has_two_factor && (
                        <Alert>
                          <AlertDescription>
                            {t(
                              'If you have no verification method, sign out and sign in again with your original provider, then start a new setup request from the app.'
                            )}
                          </AlertDescription>
                        </Alert>
                      )}
                    {!action.has_two_factor &&
                      !action.bootstrap_allowed &&
                      action.has_password !== false && (
                        <Field data-disabled={pending}>
                          <FieldLabel htmlFor='hosted-approval-password'>
                            {t('Current password')}
                          </FieldLabel>
                          <Input
                            id='hosted-approval-password'
                            type='password'
                            autoComplete='current-password'
                            value={password}
                            onChange={(event) =>
                              setPassword(event.target.value)
                            }
                            disabled={pending}
                          />
                          <p className='text-muted-foreground text-xs'>
                            {t(
                              'Enter your password, or approve using a configured Passkey.'
                            )}
                          </p>
                        </Field>
                      )}
                    <div className='flex flex-wrap justify-end gap-2'>
                      <Button
                        type='button'
                        variant='outline'
                        disabled={pending}
                        onClick={() => void respond(false)}
                      >
                        {t('Reject request')}
                      </Button>
                      <Button
                        type='button'
                        disabled={pending}
                        onClick={() => void respond(true)}
                      >
                        {t('Approve request')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
              {!expired &&
                ['approved', 'running'].includes(action.status) &&
                step &&
                !pendingBrowser &&
                (!needsBrowserInput || preparedInput) &&
                !lostSetup && (
                  <Card>
                    <CardContent className='flex flex-col gap-4'>
                      <IdentityBindingHelp
                        operation={action.operation}
                        parameters={action.parameters}
                        disabled={pending || action.status === 'running'}
                      />
                      <ActionStepForm
                        key={step.id}
                        step={step}
                        disabled={pending || action.status === 'running'}
                        preparedInput={preparedInput}
                        onSubmit={submitStep}
                      />
                    </CardContent>
                  </Card>
                )}
              {!expired && action.status === 'approved' && pendingBrowser && (
                <Card>
                  <CardContent className='flex flex-col gap-4'>
                    {pendingBrowser.kind === 'telegram-bind' ? (
                      <HostedTelegramBinding
                        payload={pendingBrowser.payload}
                        disabled={pending}
                        onCancel={() => {
                          setPendingBrowser(undefined)
                          setPreparedInput(undefined)
                        }}
                        onComplete={(prepared) => {
                          assertHostedSession(props.identity)
                          setPreparedInput({ ...prepared })
                          setPendingBrowser(undefined)
                        }}
                      />
                    ) : (
                      <>
                        <p className='text-muted-foreground text-sm'>
                          {t(
                            'Continue in your browser to complete the account verification.'
                          )}
                        </p>
                        <Button
                          type='button'
                          disabled={pending}
                          onClick={() => void completeBrowserStep()}
                        >
                          {t('Continue in browser')}
                        </Button>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}
              {!expired &&
                action.status === 'approved' &&
                ((needsBrowserInput && !preparedInput && !pendingBrowser) ||
                  lostSetup) && (
                  <Alert>
                    <AlertDescription>
                      {t(
                        'The temporary verification data is no longer available. Start a new request from the app.'
                      )}
                    </AlertDescription>
                  </Alert>
                )}
              {result !== undefined && (
                <HostedActionResult
                  operation={action.operation}
                  data={result}
                  onClear={() => setResult(undefined)}
                />
              )}
              <div className='flex flex-wrap justify-end gap-2'>
                {!expired && action.status === 'approved' && (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={pending}
                    onClick={() => void respond(false)}
                  >
                    {t('Reject request')}
                  </Button>
                )}
                {!['completed', 'rejected'].includes(action.status) && (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={pending}
                    onClick={() => {
                      setError('')
                      void query.refetch()
                    }}
                  >
                    {t('Reload status')}
                  </Button>
                )}
                {returnURI && (
                  <Button
                    render={
                      <a
                        href={returnURI}
                        referrerPolicy='no-referrer'
                        rel='noreferrer'
                      />
                    }
                    onClick={() => setResult(undefined)}
                  >
                    {t('Return to app')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
        <SecureVerificationDialog
          open={verification.open}
          onOpenChange={(open) => {
            if (!open) verification.cancel()
          }}
          methods={verification.methods}
          state={{
            ...verification.state,
            description: verification.error || verification.state.description,
          }}
          onVerify={verification.verify}
          onCancel={verification.cancel}
          onCodeChange={verification.setCode}
          onMethodChange={verification.switchMethod}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
