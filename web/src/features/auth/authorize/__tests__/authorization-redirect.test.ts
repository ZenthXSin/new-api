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
import { expect, test } from 'vitest'

import { validateAuthorizationRedirect } from '../lib/authorization-redirect'

test.each([
  'https://app.example/callback?tenant=one',
  'http://127.0.0.1:52000/callback?tenant=one',
  'http://[::1]:52000/callback?tenant=one',
  'http://localhost:52000/callback?tenant=one',
])(
  'accepts a registered callback %s with unchanged existing parameters',
  (callback) => {
    expect(
      validateAuthorizationRedirect(
        `${callback}&code=authcode&state=expected`,
        callback,
        'expected'
      )
    ).toEqual({
      url: `${callback}&code=authcode&state=expected`,
      denied: false,
    })
  }
)

test.each([
  'javascript:alert(1)',
  'data:text/html,unsafe',
  '//app.example/callback?code=c&state=s',
  'http://app.example/callback?code=c&state=s',
  'https://evil.example/callback?code=c&state=s',
  'https://app.example/other?code=c&state=s',
  'https://app.example:8443/callback?code=c&state=s',
  'https://user@app.example/callback?code=c&state=s',
  'https://app.example/callback?code=c&state=s#fragment',
  'https://app.example/callback?code=c&state=other',
  'https://app.example/callback?code=c&code=d&state=s',
  'https://app.example/callback?code=c&state=s&state=s',
  'https://app.example/callback?code=c&error=access_denied&state=s',
  'https://app.example/callback?code=c&state=s&next=https://evil.example',
  'https://app.example/callback?state=s',
])(
  'rejects a callback that changes authorization destination or response semantics: %s',
  (target) => {
    expect(() =>
      validateAuthorizationRedirect(target, 'https://app.example/callback', 's')
    ).toThrow('Invalid authorization redirect')
  }
)

test('rejects changes to callback parameters that were present in the original request', () => {
  expect(() =>
    validateAuthorizationRedirect(
      'https://app.example/callback?tenant=two&code=c',
      'https://app.example/callback?tenant=one',
      ''
    )
  ).toThrow()
})

test('classifies a valid access_denied response as denied', () => {
  expect(
    validateAuthorizationRedirect(
      'https://app.example/callback?error=access_denied&state=s',
      'https://app.example/callback',
      's'
    ).denied
  ).toBe(true)
})
