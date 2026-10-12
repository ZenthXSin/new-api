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

import {
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  COST_MULTIPLIER_MAX,
  COST_MULTIPLIER_MIN,
  COST_MULTIPLIER_STEP,
} from '../channel-form'

describe('channel cost multiplier', () => {
  test('accepts the default value in both form and native input bounds', () => {
    const defaultValue = CHANNEL_FORM_DEFAULT_VALUES.cost_multiplier

    expect(
      channelFormSchema.safeParse({
        ...CHANNEL_FORM_DEFAULT_VALUES,
        name: 'Cost channel',
        models: 'gpt-5',
        key: 'test-key',
      }).success
    ).toBe(true)
    expect(defaultValue >= COST_MULTIPLIER_MIN).toBe(true)
    expect(defaultValue <= COST_MULTIPLIER_MAX).toBe(true)
    expect(
      Number.isInteger(
        (defaultValue - COST_MULTIPLIER_MIN) / COST_MULTIPLIER_STEP
      )
    ).toBe(true)
  })
})
