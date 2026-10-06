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
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  consumeOAuthLoginRedirect,
  getOAuthSessionStorage,
  rememberOAuthLoginRedirect,
  markOAuthBindPopup,
  resolveOAuthCallbackMode,
  type OAuthModeStorage,
} from '../oauth-callback-mode'

function fakeStorage(initial: Record<string, string> = {}): OAuthModeStorage {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

const openOpener = { closed: false }
const bindState = 'bind-state'

describe('resolveOAuthCallbackMode', () => {
  test('matching provider and state mark is treated as a bind flow', () => {
    const storage = fakeStorage()
    expect(markOAuthBindPopup(storage, 'oidc', bindState)).toBe(true)

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: openOpener,
        storage,
      })
    ).toBe('bind')
  })

  // Regression: a tab opened from an external link (Slack, e-mail, another
  // site) keeps a live window.opener across the cross-origin round trip to the
  // identity provider. Treating that opener as proof of a bind flow made every
  // such login hang on the binding screen until the 30s handshake deadline.
  test('login redirect in a tab with a foreign opener stays a login flow', () => {
    const storage = fakeStorage()

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: openOpener,
        storage,
      })
    ).toBe('login')
  })

  test('bind marker for another provider does not hijack this callback', () => {
    const storage = fakeStorage()
    markOAuthBindPopup(storage, 'github', bindState)

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: openOpener,
        storage,
      })
    ).toBe('login')
  })

  test('stale bind marker does not hijack a later callback', () => {
    const storage = fakeStorage()
    markOAuthBindPopup(storage, 'oidc', 'previous-state')

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: openOpener,
        storage,
      })
    ).toBe('login')
  })

  test('bind marker without an opener falls back to login', () => {
    const storage = fakeStorage()
    markOAuthBindPopup(storage, 'oidc', bindState)

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: null,
        storage,
      })
    ).toBe('login')
  })

  test('closed opener falls back to login', () => {
    const storage = fakeStorage()
    markOAuthBindPopup(storage, 'oidc', bindState)

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: { closed: true },
        storage,
      })
    ).toBe('login')
  })

  test('missing storage degrades to login instead of throwing', () => {
    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: openOpener,
        storage: null,
      })
    ).toBe('login')
  })

  test('storage read failure degrades to login instead of throwing', () => {
    const storage: OAuthModeStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined,
    }

    expect(
      resolveOAuthCallbackMode('oidc', bindState, {
        opener: openOpener,
        storage,
      })
    ).toBe('login')
  })
})

describe('OAuth bind popup storage', () => {
  test('blocked sessionStorage getter is contained', () => {
    const owner = {
      get sessionStorage(): OAuthModeStorage {
        throw new Error('blocked')
      },
    }

    expect(getOAuthSessionStorage(owner)).toBe(null)
  })

  test('marking reports unavailable or unwritable storage', () => {
    const storage: OAuthModeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked')
      },
    }

    expect(markOAuthBindPopup(null, 'oidc', bindState)).toBe(false)
    expect(markOAuthBindPopup(storage, 'oidc', bindState)).toBe(false)
    expect(
      markOAuthBindPopup(
        {
          getItem: () => null,
          setItem: () => undefined,
        },
        'oidc',
        bindState
      )
    ).toBe(false)
  })
})

describe('OAuth login return destination', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    vi.useRealTimers()
  })

  test('a matching provider and state consume the same-origin destination once', () => {
    const target = '/authorize?client_id=client&state=client-state#consent'
    rememberOAuthLoginRedirect('github', 'login-state', target)

    expect(consumeOAuthLoginRedirect('oidc', 'login-state')).toBeNull()
    expect(consumeOAuthLoginRedirect('github', 'another-state')).toBeNull()
    expect(consumeOAuthLoginRedirect('github', 'login-state')).toBe(target)
    expect(consumeOAuthLoginRedirect('github', 'login-state')).toBeNull()
  })

  test('an expired return destination cannot be reused by a later callback', () => {
    vi.useFakeTimers()
    rememberOAuthLoginRedirect('github', 'login-state', '/oauth-actions/action')
    vi.advanceTimersByTime(10 * 60 * 1000)

    expect(consumeOAuthLoginRedirect('github', 'login-state')).toBeNull()
  })

  test.each([
    'https://attacker.example/steal',
    '//attacker.example/steal',
    'javascript:alert(1)',
    '/\\attacker.example/steal',
  ])('unsafe return destination %s is never saved', (target) => {
    rememberOAuthLoginRedirect('github', 'login-state', target)

    expect(consumeOAuthLoginRedirect('github', 'login-state')).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })

  test('a new same-tab login replaces a stale return destination', () => {
    rememberOAuthLoginRedirect(
      'github',
      'old-state',
      '/authorize?client_id=old'
    )
    rememberOAuthLoginRedirect('oidc', 'new-state', '/oauth-actions/action')

    expect(consumeOAuthLoginRedirect('github', 'old-state')).toBeNull()
    expect(consumeOAuthLoginRedirect('oidc', 'new-state')).toBe(
      '/oauth-actions/action'
    )
  })

  test('a login without a destination clears a previous same-tab marker', () => {
    rememberOAuthLoginRedirect(
      'github',
      'old-state',
      '/authorize?client_id=old'
    )
    rememberOAuthLoginRedirect('github', 'new-state')

    expect(consumeOAuthLoginRedirect('github', 'old-state')).toBeNull()
  })

  test('blocked sessionStorage does not prevent OAuth login from continuing', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('Storage is disabled')
    })

    expect(() =>
      rememberOAuthLoginRedirect('github', 'state', '/authorize')
    ).not.toThrow()
    expect(consumeOAuthLoginRedirect('github', 'state')).toBeNull()
    vi.restoreAllMocks()
  })
})
