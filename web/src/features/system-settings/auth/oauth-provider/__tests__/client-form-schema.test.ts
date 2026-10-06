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
import { describe, expect, test } from 'vitest'

import { oauthClientFormSchema } from '../types'

const validClient = {
  name: 'App',
  description: '',
  redirect_uris: ['https://rp.example.com/cb'],
  scopes: ['openid', 'profile:read', 'relay:invoke'],
  is_public: false,
  enabled: true,
}

describe('OAuth client validation', () => {
  test.each([
    { label: 'blank application name', changes: { name: '   ' } },
    { label: 'overlong application name', changes: { name: 'x'.repeat(129) } },
    { label: 'blank redirect lines', changes: { redirect_uris: ['  ', ''] } },
    {
      label: 'script callback',
      changes: { redirect_uris: ['javascript:alert(1)'] },
    },
    {
      label: 'non-loopback HTTP callback',
      changes: { redirect_uris: ['http://rp.example.com/cb'] },
    },
    {
      label: 'callback credentials',
      changes: { redirect_uris: ['https://user:password@rp.example.com/cb'] },
    },
    {
      label: 'callback fragment',
      changes: { redirect_uris: ['https://rp.example.com/cb#fragment'] },
    },
    {
      label: 'wildcard callback',
      changes: { redirect_uris: ['https://rp.example.com/*'] },
    },
    {
      label: 'encoded wildcard callback',
      changes: { redirect_uris: ['https://example.com/%2a'] },
    },
    {
      label: 'encoded control callback',
      changes: { redirect_uris: ['https://example.com/%0a'] },
    },
    { label: 'multi-byte overlong name', changes: { name: '汉'.repeat(43) } },
    { label: 'empty permissions', changes: { scopes: [] } },
    { label: 'wildcard permission', changes: { scopes: ['*'] } },
    { label: 'future full permission', changes: { scopes: ['full'] } },
  ])('rejects $label before saving', ({ changes }) => {
    expect(
      oauthClientFormSchema.safeParse({ ...validClient, ...changes }).success
    ).toBe(false)
  })

  test('accepts explicit business permissions and normalizes callback lines without changing exact URL values', () => {
    const result = oauthClientFormSchema.parse({
      ...validClient,
      name: ' App ',
      redirect_uris: [
        ' https://rp.example.com/cb?a=1 ',
        '',
        'https://rp.example.com/cb?a=1',
        'http://127.0.0.1:3721/cb',
        'http://[::1]:3721/cb',
      ],
    })
    expect(result.name).toBe('App')
    expect(result.redirect_uris).toEqual([
      'https://rp.example.com/cb?a=1',
      'http://127.0.0.1:3721/cb',
      'http://[::1]:3721/cb',
    ])
    expect(result.scopes).toEqual(['openid', 'profile:read', 'relay:invoke'])
  })
})
