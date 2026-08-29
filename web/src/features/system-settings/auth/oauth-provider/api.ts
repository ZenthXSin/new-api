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
  message?: string
  data?: T
}

function toPayload(values: OauthClientFormValues) {
  return {
    name: values.name,
    description: values.description ?? '',
    redirect_uris: values.redirect_uris,
    scopes: values.scopes,
    is_public: values.is_public,
    enabled: values.enabled,
  }
}

export async function getOauthClients(): Promise<ApiResponse<OauthClient[]>> {
  const res = await api.get('/api/oauth_client/')
  return res.data
}

export async function createOauthClient(
  values: OauthClientFormValues
): Promise<ApiResponse<OauthClientSecretResponse>> {
  const res = await api.post('/api/oauth_client/', toPayload(values))
  return res.data
}

export async function updateOauthClient(
  id: number,
  values: OauthClientFormValues
): Promise<ApiResponse<OauthClient>> {
  const res = await api.put(`/api/oauth_client/${id}`, toPayload(values))
  return res.data
}

export async function deleteOauthClient(id: number): Promise<ApiResponse> {
  const res = await api.delete(`/api/oauth_client/${id}`)
  return res.data
}

export async function resetOauthClientSecret(
  id: number
): Promise<ApiResponse<{ client_secret: string }>> {
  const res = await api.post(`/api/oauth_client/${id}/reset_secret`)
  return res.data
}
