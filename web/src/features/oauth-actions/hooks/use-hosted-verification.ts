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

import type {
  SecurityProofScope,
  SecureVerificationState,
  VerificationMethod,
  VerificationMethods,
} from '@/features/auth/secure-verification'

import {
  assertHostedSession,
  getHostedVerificationMethods,
  verifyHostedAction,
} from '../api'
import type { HostedSessionIdentity } from '../types'

const emptyMethods: VerificationMethods = {
  has2FA: false,
  hasPasskey: false,
  passkeySupported: false,
}
const emptyState: SecureVerificationState = {
  method: null,
  loading: false,
  code: '',
}

export function useHostedVerification(identity: HostedSessionIdentity) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [methods, setMethods] = useState(emptyMethods)
  const [state, setState] = useState<SecureVerificationState>(emptyState)
  const [error, setError] = useState('')
  const request = useRef<{
    scope: SecurityProofScope
    resolve: (token: string | null) => void
  } | null>(null)
  const epoch = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const proofs = useRef(
    new Map<SecurityProofScope, { token: string; expiresAt: number }>()
  )

  useEffect(
    () => () => {
      epoch.current += 1
      abort.current?.abort()
      request.current?.resolve(null)
      request.current = null
      proofs.current.clear()
    },
    []
  )

  const cancel = () => {
    epoch.current += 1
    abort.current?.abort()
    request.current?.resolve(null)
    request.current = null
    setOpen(false)
    setState(emptyState)
    setError('')
  }

  const requestProof = async (
    scope: SecurityProofScope
  ): Promise<string | null | undefined> => {
    assertHostedSession(identity)
    const cached = proofs.current.get(scope)
    if (cached && cached.expiresAt > Date.now()) return cached.token
    const currentEpoch = ++epoch.current
    request.current?.resolve(null)
    request.current = null
    setError('')
    const available = await getHostedVerificationMethods(identity)
    assertHostedSession(identity)
    if (currentEpoch !== epoch.current) return null
    const allowed = { ...available }
    if (
      scope === 'passkey.register' ||
      (scope === 'passkey.delete' && available.has2FA)
    ) {
      allowed.hasPasskey = false
    }
    setMethods(allowed)
    const method =
      allowed.hasPasskey && allowed.passkeySupported ? 'passkey' : '2fa'
    setState({
      method,
      loading: false,
      code: '',
      scope,
      title: t('Security verification'),
      description: t(
        'Confirm your identity to complete this app request on this site.'
      ),
    })
    setOpen(true)
    return new Promise((resolve) => {
      request.current = { scope, resolve }
    })
  }

  const verify = async (method: VerificationMethod, code?: string) => {
    const pending = request.current
    if (!pending || state.loading) return
    const currentEpoch = epoch.current
    abort.current = new AbortController()
    setState((previous) => ({ ...previous, loading: true }))
    setError('')
    try {
      const token = await verifyHostedAction(
        method,
        pending.scope,
        identity,
        code,
        abort.current.signal
      )
      assertHostedSession(identity)
      if (currentEpoch !== epoch.current || request.current !== pending) return
      request.current = null
      proofs.current.set(pending.scope, {
        token,
        expiresAt: Date.now() + 60_000,
      })
      setOpen(false)
      setState(emptyState)
      pending.resolve(token)
    } catch {
      if (currentEpoch === epoch.current) {
        setError(t('Verification failed or was cancelled. Please try again.'))
      }
    } finally {
      if (currentEpoch === epoch.current) {
        setState((previous) => ({ ...previous, loading: false }))
      }
    }
  }

  return {
    open,
    methods,
    state,
    error,
    requestProof,
    clearProofs: () => proofs.current.clear(),
    cancel,
    verify,
    setCode: (code: string) => setState((previous) => ({ ...previous, code })),
    switchMethod: (method: VerificationMethod) =>
      setState((previous) => ({ ...previous, method, code: '' })),
  }
}
