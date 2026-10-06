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
import { z } from 'zod'

import { api } from '@/lib/api'

import { validateAuthorizationRedirect } from './lib/authorization-redirect'

export type AuthorizeSearchParams = {
  client_id?: string
  redirect_uri?: string
  scope?: string
  state?: string
  nonce?: string
  code_challenge?: string
  code_challenge_method?: string
  resource?: string | string[]
  prompt?: string
  error?: string
  error_description?: string
}

const capabilitySchema = z.object({
  scope: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  resource: z.enum(['urn:new-api:dashboard', 'urn:new-api:relay']),
  sensitive: z.boolean(),
  min_role: z.number().int(),
})

export type ConsentCapability = z.infer<typeof capabilitySchema>

const consentSchema = z.object({
  success: z.literal(true),
  require_consent: z.boolean().optional(),
  redirect: z.string().optional(),
  consent_token: z.string().min(1).optional(),
  client: z
    .object({
      name: z.string(),
      description: z.string().default(''),
      uri: z.string().optional(),
      client_uri: z.string().optional(),
    })
    .optional(),
  scopes: z.array(z.string()).optional(),
  capabilities: z.array(capabilitySchema).optional(),
  resources: z
    .array(z.enum(['urn:new-api:dashboard', 'urn:new-api:relay']))
    .optional(),
})

export type ConsentPreview = {
  client: { name: string; description: string; uri?: string }
  scopes: string[]
  capabilities: ConsentCapability[]
  resources: string[]
  consentToken: string
}

const consentRequestOptions = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipRequestDedup: true,
}

export function buildConsentQuery(props: AuthorizeSearchParams): string {
  const params = new URLSearchParams()
  const keys = [
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'prompt',
  ] as const
  for (const key of keys) {
    const value = props[key]
    if (value) params.set(key, value)
  }
  const resources = Array.isArray(props.resource)
    ? props.resource
    : [props.resource]
  for (const resource of resources) {
    if (resource) params.append('resource', resource)
  }
  return params.toString()
}

export async function loadConsent(
  params: AuthorizeSearchParams,
  signal?: AbortSignal
): Promise<ConsentPreview> {
  try {
    const response = await api.get(
      `/api/oauth2/consent?${buildConsentQuery(params)}`,
      {
        ...consentRequestOptions,
        signal,
      }
    )
    const data = consentSchema.parse(response.data)
    if (
      data.redirect ||
      !data.require_consent ||
      !data.client ||
      !data.scopes?.length ||
      !data.consent_token ||
      !data.capabilities?.length ||
      !data.resources?.length
    ) {
      throw new Error('Invalid consent response')
    }
    const capabilities = data.capabilities
    const uniqueScopes = new Set(data.scopes)
    const capabilityScopes = new Set(capabilities.map((item) => item.scope))
    if (
      uniqueScopes.has('full') ||
      uniqueScopes.size !== data.scopes.length ||
      capabilities.length !== uniqueScopes.size ||
      capabilityScopes.size !== uniqueScopes.size ||
      !data.scopes.every((scope) => capabilityScopes.has(scope))
    ) {
      throw new Error('Invalid consent capabilities')
    }
    return {
      client: {
        ...data.client,
        uri: data.client.uri || data.client.client_uri,
      },
      scopes: data.scopes,
      capabilities,
      resources: data.resources,
      consentToken: data.consent_token,
    }
  } catch (error) {
    throw new Error('Failed to load authorization request', { cause: error })
  }
}

export async function respondToConsent(
  params: AuthorizeSearchParams,
  preview: ConsentPreview,
  approve: boolean,
  selectedScopes: string[]
): Promise<{ url: string; denied: boolean }> {
  try {
    if (selectedScopes.some((scope) => !preview.scopes.includes(scope))) {
      throw new Error('Invalid selected scopes')
    }
    const response = await api.post(
      '/api/oauth2/consent',
      {
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        scope: params.scope,
        state: params.state,
        nonce: params.nonce,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        resources: Array.isArray(params.resource)
          ? params.resource
          : [params.resource].filter(Boolean),
        prompt: params.prompt,
        consent_token: preview.consentToken,
        selected_scopes: approve ? selectedScopes : [],
        approve,
      },
      consentRequestOptions
    )
    const data = consentSchema.parse(response.data)
    if (!data.redirect) throw new Error('Missing authorization redirect')
    const redirect = validateAuthorizationRedirect(
      data.redirect,
      params.redirect_uri || '',
      params.state || ''
    )
    if (!approve && !redirect.denied) throw new Error('Invalid denial response')
    return redirect
  } catch (error) {
    throw new Error('Failed to process authorization', { cause: error })
  }
}
