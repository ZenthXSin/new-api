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

import { channelSchema } from '../../types'
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  transformChannelToFormDefaults,
  transformFormDataToUpdatePayload,
} from '../channel-form'
import { parseChannelIntelligenceCheck } from '../channel-intelligence'

describe('channel intelligence configuration', () => {
  test('new channels leave automatic detection and automatic disabling off', () => {
    const payload = transformFormDataToUpdatePayload(
      CHANNEL_FORM_DEFAULT_VALUES,
      1
    )
    const settings = JSON.parse(payload.settings || '{}')
    expect(settings.intelligence_check_enabled).toBe(false)
    expect(settings.intelligence_check_auto_disable).toBe(false)
  })

  test('editing preserves both switches and unrelated settings', () => {
    const channel = channelSchema.parse({
      id: 1,
      type: 1,
      key: '',
      status: 1,
      name: 'Diagnostic',
      created_time: 0,
      test_time: 0,
      response_time: 0,
      balance_updated_time: 0,
      settings: JSON.stringify({
        custom: 'preserved',
        intelligence_check_enabled: true,
        intelligence_check_auto_disable: true,
      }),
    })
    const values = transformChannelToFormDefaults(channel)
    const payload = transformFormDataToUpdatePayload(values, channel.id)
    const settings = JSON.parse(payload.settings || '{}')
    expect(settings.intelligence_check_enabled).toBe(true)
    expect(settings.intelligence_check_auto_disable).toBe(true)
    expect(settings.custom).toBe('preserved')
  })

  test('turning detection off clears automatic disabling in the submitted settings', () => {
    const payload = transformFormDataToUpdatePayload(
      {
        ...CHANNEL_FORM_DEFAULT_VALUES,
        intelligence_check_enabled: false,
        intelligence_check_auto_disable: true,
      },
      1
    )
    expect(
      JSON.parse(payload.settings || '{}').intelligence_check_auto_disable
    ).toBe(false)
  })

  test('invalid or absent results do not display a fabricated verdict', () => {
    expect(parseChannelIntelligenceCheck(undefined)).toBeNull()
    expect(parseChannelIntelligenceCheck('invalid')).toBeNull()
    expect(parseChannelIntelligenceCheck('{"status":"passed"}')).toBeNull()
    expect(
      parseChannelIntelligenceCheck(
        '{"status":"unknown","response":"降智","model":"gpt-test","checked_at":1,"auto_disabled":false}'
      )
    ).toBeNull()
  })
})
