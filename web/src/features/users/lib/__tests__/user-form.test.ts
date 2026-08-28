import { describe, expect, test } from 'vitest'

import {
  transformFormDataToPayload,
  transformUserToFormDefaults,
  USER_FORM_DEFAULT_VALUES,
} from '../user-form'

const baseUser = {
  id: 7,
  username: 'user',
  display_name: 'User',
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
  groups: ['default', 'vip'],
  status: 1,
  role: 1,
}

describe('user groups form mapping', () => {
  test('sends all selected groups and keeps the first as legacy group', () => {
    const payload = transformFormDataToPayload(
      { ...USER_FORM_DEFAULT_VALUES, groups: ['vip', 'default'] },
      7
    )
    expect(payload.group).toBe('vip')
    expect(payload.groups).toEqual(['vip', 'default'])
  })

  test('falls back to the legacy group for old form data', () => {
    const payload = transformFormDataToPayload(
      { ...USER_FORM_DEFAULT_VALUES, groups: undefined, group: 'vip' },
      7
    )
    expect(payload.group).toBe('vip')
    expect(payload.groups).toBeUndefined()
  })

  test('hydrates groups from the new field and falls back for legacy users', () => {
    expect(transformUserToFormDefaults(baseUser).groups).toEqual([
      'default',
      'vip',
    ])
    expect(
      transformUserToFormDefaults({ ...baseUser, groups: undefined }).groups
    ).toEqual(['default'])
  })
})
