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
const RESPONSE_PARAMETERS = new Set([
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
  'iss',
])

/** External callbacks may use HTTPS or an explicit loopback HTTP listener. */
export function safeOAuthWebUrl(value: string): URL | null {
  if (
    !value ||
    value.includes('\\') ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  ) {
    return null
  }
  try {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      return null
    }
    if (!url.hostname || url.username || url.password || url.hash) return null
    return url
  } catch {
    return null
  }
}

/** Never navigate to a callback that differs from the request shown to the user. */
export function validateAuthorizationRedirect(
  value: string,
  callback: string,
  state: string
): { url: string; denied: boolean } {
  const target = safeOAuthWebUrl(value)
  const expected = safeOAuthWebUrl(callback)
  if (
    !target ||
    !expected ||
    target.origin !== expected.origin ||
    target.pathname !== expected.pathname
  ) {
    throw new Error('Invalid authorization redirect')
  }
  for (const key of expected.searchParams.keys()) {
    if (RESPONSE_PARAMETERS.has(key)) {
      throw new Error('Invalid authorization redirect')
    }
    if (
      JSON.stringify(expected.searchParams.getAll(key)) !==
      JSON.stringify(target.searchParams.getAll(key))
    ) {
      throw new Error('Invalid authorization redirect')
    }
  }
  for (const key of target.searchParams.keys()) {
    if (!expected.searchParams.has(key) && !RESPONSE_PARAMETERS.has(key)) {
      throw new Error('Invalid authorization redirect')
    }
    if (
      RESPONSE_PARAMETERS.has(key) &&
      target.searchParams.getAll(key).length > 1
    ) {
      throw new Error('Invalid authorization redirect')
    }
  }
  const code = target.searchParams.get('code')
  const error = target.searchParams.get('error')
  if (
    Boolean(code) === Boolean(error) ||
    target.searchParams.has('code') === target.searchParams.has('error') ||
    (target.searchParams.get('state') || '') !== state
  ) {
    throw new Error('Invalid authorization redirect')
  }
  return { url: target.href, denied: Boolean(error) }
}
