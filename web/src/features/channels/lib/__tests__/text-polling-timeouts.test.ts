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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Channel } from '../../types'
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  channelFormSchema,
  transformChannelToFormDefaults,
  transformFormDataToUpdatePayload,
} from '../channel-form'

function channelWithSettings(settings: Record<string, unknown>): Channel {
  return {
    id: 1,
    type: 1,
    key: '',
    status: 1,
    name: 'Polling channel',
    created_time: 0,
    test_time: 0,
    response_time: 0,
    other: '',
    balance: 0,
    balance_updated_time: 0,
    models: 'gpt-5',
    group: 'default',
    used_quota: 0,
    other_info: '',
    remark: '',
    max_input_tokens: 0,
    channel_info: {
      is_multi_key: false,
      multi_key_size: 0,
      multi_key_polling_index: 0,
      multi_key_mode: 'random',
    },
    settings: JSON.stringify(settings),
  }
}

describe('channel text polling timeout settings', () => {
  test('uses 3, 6, and 12 seconds when an existing channel has no polling settings', () => {
    const values = transformChannelToFormDefaults(
      channelWithSettings({ custom_setting: 'preserved' })
    )
    const payload = transformFormDataToUpdatePayload(values, 1)
    const settings = JSON.parse(payload.settings || '{}')

    assert.equal(values.text_polling_timeout_tier1_seconds, 3)
    assert.equal(values.text_polling_timeout_tier2_seconds, 6)
    assert.equal(values.text_polling_timeout_tier3_seconds, 12)
    assert.equal(values.text_polling_enabled, false)
    assert.equal(settings.text_polling_enabled, false)
  })

  test('loads configured values and preserves unrelated settings on update', () => {
    const values = transformChannelToFormDefaults(
      channelWithSettings({
        custom_setting: 'preserved',
        text_polling_enabled: true,
        text_polling_timeout_tier1_seconds: 4,
        text_polling_timeout_tier2_seconds: 8,
        text_polling_timeout_tier3_seconds: 16,
      })
    )
    const payload = transformFormDataToUpdatePayload(values, 1)
    const settings = JSON.parse(payload.settings || '{}')

    assert.equal(values.text_polling_timeout_tier1_seconds, 4)
    assert.equal(values.text_polling_timeout_tier2_seconds, 8)
    assert.equal(values.text_polling_timeout_tier3_seconds, 16)
    assert.equal(values.text_polling_enabled, true)
    assert.equal(settings.custom_setting, 'preserved')
    assert.equal(settings.text_polling_enabled, true)
    assert.equal(settings.text_polling_timeout_tier1_seconds, 4)
    assert.equal(settings.text_polling_timeout_tier2_seconds, 8)
    assert.equal(settings.text_polling_timeout_tier3_seconds, 16)
  })

  test('rejects fractional timeout tiers', () => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'Polling channel',
      models: 'gpt-5',
      text_polling_timeout_tier1_seconds: 1.5,
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(
        result.error.issues[0]?.message,
        'Text polling timeout must be a whole number of seconds'
      )
    }
  })

  test('rejects timeout tiers below one second', () => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'Polling channel',
      models: 'gpt-5',
      text_polling_timeout_tier1_seconds: 0,
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(
        result.error.issues[0]?.message,
        'Text polling timeout must be at least 1 second'
      )
    }
  })

  test('rejects timeout tiers above 120 seconds', () => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'Polling channel',
      models: 'gpt-5',
      text_polling_timeout_tier3_seconds: 121,
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(
        result.error.issues[0]?.message,
        'Text polling timeout must not exceed 120 seconds'
      )
    }
  })

  test('rejects a second tier that is not greater than the first tier', () => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'Polling channel',
      models: 'gpt-5',
      text_polling_timeout_tier1_seconds: 7,
      text_polling_timeout_tier2_seconds: 7,
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(
        result.error.issues[0]?.message,
        'Text polling timeout tier 2 must be greater than tier 1'
      )
    }
  })

  test('rejects a third tier that is not greater than the second tier', () => {
    const result = channelFormSchema.safeParse({
      ...CHANNEL_FORM_DEFAULT_VALUES,
      name: 'Polling channel',
      models: 'gpt-5',
      text_polling_timeout_tier2_seconds: 7,
      text_polling_timeout_tier3_seconds: 7,
    })

    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(
        result.error.issues[0]?.message,
        'Text polling timeout tier 3 must be greater than tier 2'
      )
    }
  })
})
