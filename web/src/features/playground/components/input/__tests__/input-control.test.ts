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
  getInputControlState,
  getSubmittableInputText,
} from '../../../lib/input/input-control-utils'

const valid = {
  groups: [{ value: 'main', label: 'Main', ratio: 1 }],
  groupValue: 'main',
  models: [{ value: 'chat', label: 'Chat' }],
  modelValue: 'chat',
  text: 'Hello',
  hasStopHandler: false,
}
describe('playground input submission', () => {
  test('blocks submission while the selected group models are loading', () => {
    expect(
      getInputControlState({ ...valid, isModelLoading: true }).canSubmit
    ).toBe(false)
  })
  test('blocks models or groups no longer available to this user', () => {
    expect(
      getInputControlState({ ...valid, modelValue: 'removed' }).canSubmit
    ).toBe(false)
    expect(
      getInputControlState({ ...valid, groupValue: 'removed' }).canSubmit
    ).toBe(false)
  })
  test('allows attachment only requests but rejects an empty draft', () => {
    expect(
      getInputControlState({ ...valid, text: '', attachmentCount: 1 }).canSubmit
    ).toBe(true)
    expect(getInputControlState({ ...valid, text: ' ' }).canSubmit).toBe(false)
    expect(getSubmittableInputText({ text: '' }, false, 1)).toBe('')
  })
  test('shows stop while generating and prevents another request', () => {
    expect(
      getInputControlState({
        ...valid,
        isGenerating: true,
        hasStopHandler: true,
      })
    ).toMatchObject({ canSubmit: false, shouldShowStop: true })
  })
  test('keeps the group selector usable when the current group has no models', () => {
    const state = getInputControlState({ ...valid, models: [] })
    expect(state.canSubmit).toBe(false)
    expect(state.isSelectorDisabled).toBe(false)
  })
})
