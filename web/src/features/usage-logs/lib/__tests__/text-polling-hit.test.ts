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

import { getTextPollingHit } from '../format'

describe('text polling hit parsing', () => {
  test('returns each explicit successful polling tier', () => {
    for (const tier of [1, 2, 3] as const) {
      expect(getTextPollingHit({ text_polling_tier: tier })).toEqual({
        kind: 'tier',
        tier,
      })
    }
  })

  test('returns the hidden legacy fallback marker', () => {
    expect(getTextPollingHit({ text_polling_fallback: true })).toEqual({
      kind: 'fallback',
    })
  })

  test('returns null for non-polling metadata', () => {
    expect(getTextPollingHit({})).toBe(null)
    expect(getTextPollingHit(null)).toBe(null)
    expect(getTextPollingHit(undefined)).toBe(null)
  })

  test('rejects malformed or contradictory polling metadata', () => {
    expect(getTextPollingHit({ text_polling_tier: 0 })).toBe(null)
    expect(getTextPollingHit({ text_polling_tier: 4 })).toBe(null)
    expect(
      getTextPollingHit({
        text_polling_tier: 1,
        text_polling_fallback: true,
      })
    ).toBe(null)
  })
})