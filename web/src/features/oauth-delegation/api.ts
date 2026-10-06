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
import { api } from '@/lib/api'

import type { OAuthCapabilityCatalog, OAuthGrant } from './types'

interface OAuthResponse<T> {
  success: boolean
  data: T
}

const privateRequest = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipRequestDedup: true,
} as const

export async function getOauthCapabilities(
  signal?: AbortSignal
): Promise<OAuthCapabilityCatalog> {
  try {
    const response = await api.get<OAuthResponse<OAuthCapabilityCatalog>>(
      '/api/oauth2/capabilities',
      { ...privateRequest, signal }
    )
    if (
      !response.data.success ||
      !Array.isArray(response.data.data?.capabilities)
    ) {
      throw new Error('Invalid capability response')
    }
    return response.data.data
  } catch (cause) {
    throw new Error('Unable to load application permissions', { cause })
  }
}

export async function getOauthGrants(
  signal?: AbortSignal
): Promise<OAuthGrant[]> {
  try {
    const response = await api.get<OAuthResponse<OAuthGrant[]>>(
      '/api/oauth2/grants',
      { ...privateRequest, signal }
    )
    if (!response.data.success || !Array.isArray(response.data.data)) {
      throw new Error('Invalid grant response')
    }
    return response.data.data
  } catch (cause) {
    throw new Error('Unable to load authorized applications', { cause })
  }
}

export async function narrowOauthGrant(
  id: number,
  scopes: string[]
): Promise<void> {
  try {
    const response = await api.patch<OAuthResponse<unknown>>(
      `/api/oauth2/grants/${id}`,
      { scopes },
      privateRequest
    )
    if (!response.data.success) throw new Error('Invalid grant update response')
  } catch (cause) {
    throw new Error('Unable to update application permissions', { cause })
  }
}

export async function revokeOauthGrant(id: number): Promise<void> {
  try {
    const response = await api.delete<OAuthResponse<unknown>>(
      `/api/oauth2/grants/${id}`,
      privateRequest
    )
    if (!response.data.success) {
      throw new Error('Invalid grant revocation response')
    }
  } catch (cause) {
    throw new Error('Unable to revoke application access', { cause })
  }
}
