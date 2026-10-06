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

import type {
  OauthClient,
  OauthClientFormValues,
  OauthClientSecretResponse,
} from './types'

interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
}

const privateRequest = {
  skipBusinessError: true,
  skipErrorHandler: true,
  skipRequestDedup: true,
} as const

export async function getOauthClients(
  signal?: AbortSignal
): Promise<OauthClient[]> {
  try {
    const res = await api.get<ApiResponse<OauthClient[]>>(
      '/api/oauth_client/',
      { ...privateRequest, signal }
    )
    if (!res.data.success || !Array.isArray(res.data.data)) throw new Error()
    return res.data.data
  } catch {
    throw new Error('Failed to load OAuth clients')
  }
}

export async function createOauthClient(
  values: OauthClientFormValues
): Promise<OauthClientSecretResponse> {
  try {
    const res = await api.post<ApiResponse<OauthClientSecretResponse>>(
      '/api/oauth_client/',
      values,
      privateRequest
    )
    if (!res.data.success || !res.data.data?.client) throw new Error()
    return res.data.data
  } catch {
    throw new Error('Failed to create client')
  }
}

export async function updateOauthClient(
  id: number,
  values: OauthClientFormValues
): Promise<OauthClient> {
  try {
    const res = await api.put<ApiResponse<OauthClient>>(
      `/api/oauth_client/${id}`,
      values,
      privateRequest
    )
    if (!res.data.success || !res.data.data) throw new Error()
    return res.data.data
  } catch {
    throw new Error('Failed to update client')
  }
}

export async function deleteOauthClient(id: number): Promise<void> {
  try {
    const res = await api.delete<ApiResponse>(
      `/api/oauth_client/${id}`,
      privateRequest
    )
    if (!res.data.success) throw new Error()
  } catch {
    throw new Error('Failed to delete client')
  }
}

export async function resetOauthClientSecret(id: number): Promise<string> {
  try {
    const res = await api.post<ApiResponse<{ client_secret: string }>>(
      `/api/oauth_client/${id}/reset_secret`,
      undefined,
      privateRequest
    )
    if (!res.data.success || !res.data.data?.client_secret) throw new Error()
    return res.data.data.client_secret
  } catch {
    throw new Error('Failed to reset client secret')
  }
}
