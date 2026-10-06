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
export interface OAuthCapability {
  scope: string
  label: string
  description: string
  resource: string
  sensitive: boolean
  min_role: number
}

export interface OAuthCapabilityCatalog {
  catalog_version: string
  capabilities: OAuthCapability[]
  granted_scopes: string[] | null
  resources: string[]
}

export interface OAuthGrant {
  id: number
  user_id: number
  client_id: string
  client_name: string
  scopes: string[]
  resources: string[]
  created_at: number
  expires_at: number
  revoked_at: number
  active: boolean
}
