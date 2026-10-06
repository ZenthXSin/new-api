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

// Redirects are exact matches. Web callbacks require TLS except native loopback.
export function isValidOauthRedirectUri(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value)
    const hasControl = [...value, ...decoded].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
    if (/[\s*#\\]/.test(value) || decoded.includes('*') || hasControl) {
      return false
    }
    const uri = new URL(value)
    if (uri.username || uri.password || uri.hash || uri.port === '0') {
      return false
    }
    if (uri.protocol === 'https:') return !!uri.hostname
    return (
      uri.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)
    )
  } catch {
    return false
  }
}

export const oauthClientFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(128, 'Application name is too long')
    .refine(
      (value) => new TextEncoder().encode(value).length <= 128,
      'Application name is too long'
    ),
  description: z
    .string()
    .trim()
    .max(512, 'Application description is too long'),
  redirect_uris: z
    .array(z.string())
    .max(32, 'Register at most 32 redirect URIs')
    .transform((uris) => [
      ...new Set(uris.map((uri) => uri.trim()).filter(Boolean)),
    ])
    .pipe(
      z
        .array(
          z
            .string()
            .max(2048, 'Redirect URI is too long')
            .refine(
              (value) => new TextEncoder().encode(value).length <= 2048,
              'Redirect URI is too long'
            )
            .refine(
              isValidOauthRedirectUri,
              'Use an HTTPS callback or a loopback HTTP callback without credentials, fragments, or wildcards'
            )
        )
        .min(1, 'At least one redirect URI is required')
        .max(32, 'Register at most 32 redirect URIs')
    ),
  scopes: z
    .array(
      z
        .string()
        .regex(
          /^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$/,
          'Select a supported permission'
        )
        .refine((scope) => scope !== 'full', 'Select a supported permission')
    )
    .min(1, 'Select at least one scope'),
  is_public: z.boolean(),
  enabled: z.boolean(),
})

export type OauthClientFormValues = z.infer<typeof oauthClientFormSchema>
