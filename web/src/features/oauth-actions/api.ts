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

import type {
  SecurityProofScope,
  VerificationMethods,
} from '@/features/auth/secure-verification'
import { api } from '@/lib/api'
import { applyAuthRotation } from '@/lib/auth-session'
import { isPasskeySupported } from '@/lib/passkey'
import { useAuthStore } from '@/stores/auth-store'

import { completeHostedPasskey } from './lib/passkey-action'
import type {
  HostedActionApproval,
  HostedActionStepResult,
  HostedSessionIdentity,
} from './types'

const privateRequest = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipAuthRefresh: true,
  skipRequestDedup: true,
}

const approvalSchema = z.object({
  action_id: z.string().min(1),
  client_name: z.string().default(''),
  operation: z.string(),
  label: z.string().default(''),
  status: z.enum([
    'pending',
    'approved',
    'running',
    'completed',
    'rejected',
    'failed',
    'expired',
  ]),
  expires_at: z.number().finite(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        method: z.string(),
        path: z.string(),
        fields: z
          .array(
            z.object({
              name: z.string().min(1),
              label: z.string(),
              type: z.enum([
                'text',
                'password',
                'code',
                'json',
                'number',
                'boolean',
              ]),
              required: z.boolean(),
            })
          )
          .default([]),
        state: z.enum(['pending', 'completed']),
        proof_scope: z.string().optional(),
        kind: z
          .enum([
            '',
            'passkey-register',
            'passkey-verify',
            'oauth-bind',
            'telegram-bind',
          ])
          .optional(),
      })
    )
    .default([]),
  current_step_id: z.string().optional(),
  share_result: z.boolean().default(false),
  result_kind: z.enum(['secret', 'data', 'receipt']).optional(),
  return_uri: z.string().optional(),
  has_two_factor: z.boolean().default(false),
  has_password: z.boolean().optional(),
  bootstrap_allowed: z.boolean().optional(),
  bootstrap_operation: z.boolean().optional(),
  verification_scope: z.string().optional(),
  approval_nonce: z.string().default(''),
})

export function assertHostedSession(identity: HostedSessionIdentity): void {
  const auth = useAuthStore.getState().auth
  if (
    auth.user?.id !== identity.userID ||
    auth.session?.sid !== identity.sessionID
  ) {
    throw new Error(
      i18next.t('Your session changed. Reload this request to continue.')
    )
  }
}

export async function getHostedActionApproval(
  actionID: string,
  identity: HostedSessionIdentity,
  signal?: AbortSignal
): Promise<HostedActionApproval> {
  try {
    assertHostedSession(identity)
    const response = await api.get(
      `/api/oauth2/actions/${encodeURIComponent(actionID)}/approval`,
      { ...privateRequest, signal }
    )
    assertHostedSession(identity)
    if (response.data?.success !== true) {
      throw new Error('Invalid approval response')
    }
    const approval = approvalSchema.parse(response.data.data)
    if (approval.action_id !== actionID) {
      throw new Error('Action identity mismatch')
    }
    return approval
  } catch {
    throw new Error(
      i18next.t(
        'Unable to load this app request. Reload the page or start again from the app.'
      )
    )
  }
}

export async function decideHostedAction(
  actionID: string,
  nonce: string,
  approve: boolean,
  identity: HostedSessionIdentity,
  verificationPassword?: string,
  proofToken?: string
): Promise<{ return_uri?: string }> {
  try {
    assertHostedSession(identity)
    const response = await api.post(
      `/api/oauth2/actions/${encodeURIComponent(actionID)}/${approve ? 'approve' : 'reject'}`,
      { approval_nonce: nonce, verification_password: verificationPassword },
      {
        ...privateRequest,
        headers: proofToken ? { 'X-Security-Proof': proofToken } : undefined,
      }
    )
    assertHostedSession(identity)
    if (response.data?.success !== true) {
      throw new Error('Approval decision failed')
    }
    return {
      return_uri:
        typeof response.data.data?.return_uri === 'string'
          ? response.data.data.return_uri
          : undefined,
    }
  } catch {
    throw new Error(
      i18next.t(
        'Unable to update this request. Reload its status before trying again.'
      )
    )
  }
}

export async function executeHostedActionStep(
  actionID: string,
  stepID: string,
  nonce: string,
  input: Record<string, unknown>,
  identity: HostedSessionIdentity,
  proofToken?: string
): Promise<HostedActionStepResult> {
  try {
    assertHostedSession(identity)
    const response = await api.post(
      `/api/oauth2/actions/${encodeURIComponent(actionID)}/steps/${encodeURIComponent(stepID)}`,
      { approval_nonce: nonce, input },
      {
        ...privateRequest,
        headers: proofToken ? { 'X-Security-Proof': proofToken } : undefined,
      }
    )
    assertHostedSession(identity)
    if (response.data?.success !== true) throw new Error('Action step failed')
    const data = response.data.data
    if (
      data &&
      typeof data === 'object' &&
      typeof data.access_token === 'string'
    ) {
      applyAuthRotation(data)
    }
    return {
      data,
      return_uri: response.data.return_uri,
      action_status: response.data.action_status,
      next_step_id: response.data.next_step_id,
    }
  } catch {
    throw new Error(
      i18next.t(
        'The action could not be completed. Check your input and reload its status before retrying.'
      )
    )
  }
}

export async function getHostedVerificationMethods(
  identity: HostedSessionIdentity
): Promise<VerificationMethods> {
  try {
    assertHostedSession(identity)
    const [twoFA, passkey, supported] = await Promise.all([
      api.get('/api/user/2fa/status', privateRequest),
      api.get('/api/user/passkey', privateRequest),
      isPasskeySupported(),
    ])
    assertHostedSession(identity)
    return {
      has2FA: twoFA.data?.success === true && twoFA.data.data?.enabled === true,
      hasPasskey:
        passkey.data?.success === true && passkey.data.data?.enabled === true,
      passkeySupported: supported,
    }
  } catch {
    throw new Error(
      i18next.t(
        'Unable to load verification methods. Reload the page and try again.'
      )
    )
  }
}

export async function verifyHostedAction(
  method: '2fa' | 'passkey',
  scope: SecurityProofScope,
  identity: HostedSessionIdentity,
  code?: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    assertHostedSession(identity)
    let response
    if (method === '2fa') {
      response = await api.post(
        '/api/verify',
        { method, scope, code: code?.trim() },
        { ...privateRequest, signal }
      )
    } else {
      const begin = await api.post(
        '/api/user/passkey/verify/begin',
        { scope },
        { ...privateRequest, signal }
      )
      assertHostedSession(identity)
      if (begin.data?.success !== true) {
        throw new Error('Verification begin failed')
      }
      const input = await completeHostedPasskey(
        'passkey-verify',
        begin.data.data,
        signal
      )
      assertHostedSession(identity)
      response = await api.post('/api/user/passkey/verify/finish', input, {
        ...privateRequest,
        signal,
      })
    }
    assertHostedSession(identity)
    if (
      response.data?.success !== true ||
      typeof response.data.data?.proof_token !== 'string'
    ) {
      throw new Error('Verification failed')
    }
    return response.data.data.proof_token
  } catch {
    throw new Error(
      i18next.t('Verification failed or was cancelled. Please try again.')
    )
  }
}
