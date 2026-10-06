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
import { describe, expect, it } from 'vitest'

import { normalizeParameterNumberValue } from '../playground-parameters'

describe('playground numeric parameter bounds', () => {
  it('preserves explicit zero temperature and top P', () => {
    expect(normalizeParameterNumberValue('temperature', '0')).toBe(0)
    expect(normalizeParameterNumberValue('top_p', 0)).toBe(0)
  })
  it('keeps response token limits positive and finite', () => {
    expect(normalizeParameterNumberValue('max_tokens', '')).toBe(1)
    expect(normalizeParameterNumberValue('max_tokens', -1)).toBe(1)
    expect(normalizeParameterNumberValue('max_tokens', Number.NaN)).toBe(1)
    expect(
      normalizeParameterNumberValue('max_tokens', Number.POSITIVE_INFINITY)
    ).toBe(1)
    expect(normalizeParameterNumberValue('max_tokens', 900000)).toBe(200000)
  })
  it('keeps empty seeds omitted and valid zero seeds explicit', () => {
    expect(normalizeParameterNumberValue('seed', '')).toBeNull()
    expect(normalizeParameterNumberValue('seed', 0)).toBe(0)
  })
})
