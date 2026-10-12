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
import {
  defaultParseSearch,
  defaultStringifySearch,
} from '@tanstack/react-router'

// OAuth parameters are opaque protocol strings. JSON coercion changes valid
// values such as state=123 or state=%22hello%22 and breaks callback validation.
const OPAQUE_SEARCH_PARAMETERS = new Set([
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'nonce',
  'code',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'prompt',
  'error',
  'error_description',
  'error_code',
  'iss',
  'redirect',
  'request_id',
  'action_id',
  'flow_token',
  'telegram_bind',
  'github_oauth',
])

export function parseRouterSearch(search: string): Record<string, unknown> {
  const parsed = defaultParseSearch(search) as Record<string, unknown>
  const params = new URLSearchParams(search)
  for (const key of OPAQUE_SEARCH_PARAMETERS) {
    if (!params.has(key)) continue
    const values = params.getAll(key)
    // Preserve repeated parameters so route schemas can reject ambiguity.
    // resource is the only OAuth authorization field allowed to repeat.
    parsed[key] = values.length === 1 ? values[0] : values
  }
  return parsed
}

export function stringifyRouterSearch(search: Record<string, unknown>): string {
  const ordinary = Object.fromEntries(
    Object.entries(search).filter(([key]) => !OPAQUE_SEARCH_PARAMETERS.has(key))
  )
  const params = new URLSearchParams(defaultStringifySearch(ordinary))
  for (const [key, value] of Object.entries(search)) {
    if (!OPAQUE_SEARCH_PARAMETERS.has(key) || value === undefined) continue
    const values = Array.isArray(value) ? value : [value]
    for (const entry of values) {
      params.append(
        key,
        typeof entry === 'string' ? entry : JSON.stringify(entry)
      )
    }
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}
