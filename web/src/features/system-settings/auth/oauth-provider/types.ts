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
import * as z from 'zod'

// ============================================================================
// OIDC Client Types
// ============================================================================

export interface OauthClient {
  id: number
  client_id: string
  name: string
  description: string
  redirect_uris: string[]
  scopes: string[]
  is_public: boolean
  enabled: boolean
  last_used_at: number
  created_time: number
}

export interface OauthClientSecretResponse {
  client: OauthClient
  client_secret: string
}

// ============================================================================
// Form Schema
// ============================================================================

export const oauthClientFormSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  redirect_uris: z
    .array(z.string())
    .min(1, 'At least one redirect URI is required'),
  scopes: z.array(z.string()).min(1, 'Select at least one scope'),
  is_public: z.boolean(),
  enabled: z.boolean(),
})

export type OauthClientFormValues = z.infer<typeof oauthClientFormSchema>

export const OAUTH_SCOPE_OPTIONS = [
  { value: 'openid', labelKey: 'OpenID (required for login)' },
  { value: 'profile', labelKey: 'Profile (username, display name, groups, balance)' },
  { value: 'email', labelKey: 'Email address' },
] as const
