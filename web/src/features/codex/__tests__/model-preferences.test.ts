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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  readModelPreferences,
  resolveModelPreferences,
  saveModelPreferences,
  type CodexModelPreferences,
} from '../lib/model-preferences'
import type { CodexCatalog } from '../types'
import { status, workspace } from './fixtures'

const preference: CodexModelPreferences = {
  version: 1,
  model: 'codex-test',
  group: 'basic',
  effort: 'low',
}
const catalog: CodexCatalog = {
  defaultGroup: 'basic',
  defaultModel: 'codex-test',
  groups: [
    {
      id: 'basic',
      name: 'Basic',
      description: '',
      ratio: 1,
      models: [{ id: 'codex-test', name: 'Codex Test', supported: true }],
    },
  ],
}
beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

test('logging in with a new session restores the same account choice while another account gets no preference', () => {
  saveModelPreferences('25:old-session', preference)
  expect(readModelPreferences('25:new-session')).toEqual(preference)
  expect(readModelPreferences('26:new-session')).toBeNull()
})

test.each([
  ['invalid JSON', '{'],
  ['unknown version', JSON.stringify({ ...preference, version: 2 })],
  ['missing model', JSON.stringify({ ...preference, model: '' })],
  ['wrong group type', JSON.stringify({ ...preference, group: 1 })],
  ['overlong model', JSON.stringify({ ...preference, model: 'x'.repeat(513) })],
  ['control characters', JSON.stringify({ ...preference, effort: 'low\n' })],
])('stored %s falls back without crashing the composer', (_name, value) => {
  localStorage.setItem('codex-model-preferences:25', value)
  expect(readModelPreferences('25:session')).toBeNull()
})

test('unavailable storage returns no saved choice and writing it does not throw', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage full')
  })
  expect(readModelPreferences('25:session')).toBeNull()
  expect(() => saveModelPreferences('25:session', preference)).not.toThrow()
})

test('explicit preferences take precedence over previous conversation parameters', () => {
  expect(
    resolveModelPreferences(preference, status, catalog, workspace)
  ).toEqual(preference)
  expect(resolveModelPreferences(null, status, catalog, workspace)).toEqual({
    version: 1,
    model: 'codex-test',
    group: 'basic',
    effort: 'high',
  })
})

test.each([
  ['removed model', { ...preference, model: 'removed-model' }, catalog],
  ['removed group', { ...preference, group: 'removed-group' }, catalog],
  [
    'unsupported model',
    preference,
    {
      ...catalog,
      groups: [
        {
          ...catalog.groups[0],
          models: [{ ...catalog.groups[0].models[0], supported: false }],
        },
      ],
    },
  ],
])(
  '%s does not resurrect an unavailable preference or overwrite the saved choice',
  (_name, saved, available) => {
    saveModelPreferences('25:session', saved)
    expect(resolveModelPreferences(saved, status, available)).toEqual({
      version: 1,
      model: 'codex-test',
      group: 'basic',
      effort: 'low',
    })
    expect(readModelPreferences('25:session')).toEqual(saved)
  }
)

test('a removed tier uses the selected model default rather than sending an unsupported effort', () => {
  const limited = {
    ...status,
    models: [
      { id: 'codex-test', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ],
  }
  expect(
    resolveModelPreferences(
      { ...preference, effort: 'ultra' },
      limited,
      catalog
    )
  ).toEqual({ ...preference, effort: 'medium' })
})

test('a catalog-less deployment checks the runner model list before restoring a model', () => {
  expect(
    resolveModelPreferences({ ...preference, model: 'unknown' }, status)
  ).toEqual({ ...preference, group: '' })
})
