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
import { beforeEach, describe, expect, it } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { createUserMessage } from '../../message/message-utils'
import {
  exportConversationJSON,
  exportConversationMarkdown,
  parseConversationImport,
} from '../conversation-transfer'
import {
  loadConfig,
  loadParameterEnabled,
  readLegacyConversation,
  saveConfig,
  saveParameterEnabled,
  validateConversationMessages,
} from '../storage'
import { MAX_STORED_MESSAGES_BYTES } from '../storage-schema'

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'current', role: 1 })
})

describe('conversation transfers and ownership', () => {
  it('round-trips exact current conversation without loading legacy data or credentials', () => {
    localStorage.setItem(
      'playground_messages',
      JSON.stringify([createUserMessage('Other legacy history')])
    )
    const messages = [
      createUserMessage('Current account', 0, [
        {
          id: 'notes',
          name: 'notes.txt',
          kind: 'text',
          mimeType: 'text/plain',
          size: 3,
          text: 'abc',
        },
      ]),
    ]
    messages[0].createdAt = 0
    const raw = exportConversationJSON(
      messages,
      DEFAULT_CONFIG,
      DEFAULT_PARAMETER_ENABLED,
      7
    )
    expect(parseConversationImport(raw).messages).toEqual(messages)
    expect(raw).not.toContain('Other legacy history')
    expect(raw).not.toContain('access_token')
    expect(exportConversationMarkdown(messages, 7)).toContain(
      '### notes.txt\n\nabc'
    )
  })
  it('rejects exports captured before an account change', () => {
    useAuthStore.getState().auth.setUser({ id: 8, username: 'other', role: 1 })
    expect(() =>
      exportConversationJSON([], DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED, 7)
    ).toThrow('account')
    expect(() => exportConversationMarkdown([], 7)).toThrow('account')
  })
  it('rejects unrecognized format, blob attachments, extra fields and oversize without dropping content', () => {
    const valid = JSON.parse(
      exportConversationJSON(
        [createUserMessage('Document')],
        DEFAULT_CONFIG,
        DEFAULT_PARAMETER_ENABLED,
        7
      )
    )
    expect(() =>
      parseConversationImport(JSON.stringify({ ...valid, version: 9 }))
    ).toThrow('invalid')
    expect(() =>
      parseConversationImport(
        JSON.stringify({ ...valid, access_token: 'not-a-conversation' })
      )
    ).toThrow('invalid')
    valid.messages[0].versions[0].attachments = [
      {
        id: 'file',
        name: 'file.pdf',
        kind: 'pdf',
        mimeType: 'application/pdf',
        size: 1,
        dataUrl: 'blob:gone',
      },
    ]
    expect(() => parseConversationImport(JSON.stringify(valid))).toThrow(
      'invalid'
    )
    const oversized = [createUserMessage('x'.repeat(MAX_STORED_MESSAGES_BYTES))]
    expect(() => validateConversationMessages(oversized)).toThrow('limit')
    // An unsaved large response can still be exported as a complete backup.
    expect(
      JSON.parse(
        exportConversationJSON(
          oversized,
          DEFAULT_CONFIG,
          DEFAULT_PARAMETER_ENABLED,
          7
        )
      ).messages[0].versions[0].content
    ).toHaveLength(MAX_STORED_MESSAGES_BYTES)
  })
  it('isolates settings by account and migrates only the old zero max-token value', () => {
    saveConfig(
      { ...DEFAULT_CONFIG, model: 'private-model', max_tokens: 4096 },
      7
    )
    saveParameterEnabled({ ...DEFAULT_PARAMETER_ENABLED, temperature: true }, 7)
    expect(loadConfig(8)).toEqual({})
    expect(loadParameterEnabled(8)).toEqual({})
    localStorage.setItem(
      'playground_v2:7:config',
      JSON.stringify({
        model: 'kept',
        max_tokens: 0,
        temperature: 0,
        stop: ['', 'END'],
      })
    )
    expect(loadConfig(7)).toEqual({
      model: 'kept',
      max_tokens: 4096,
      temperature: 0,
      stop: ['', 'END'],
    })
    const legacy = [createUserMessage('Manual import only')]
    localStorage.setItem(
      'playground_messages',
      JSON.stringify({ version: 1, data: legacy })
    )
    expect(readLegacyConversation()).toEqual(legacy)
    expect(localStorage.getItem('playground_messages')).not.toBeNull()
  })
  it('still exports the exact conversation when unsaved settings are invalid', () => {
    const messages = [createUserMessage('Keep this backup')]
    const raw = exportConversationJSON(
      messages,
      { ...DEFAULT_CONFIG, max_tokens: 0 },
      DEFAULT_PARAMETER_ENABLED,
      7
    )
    expect(parseConversationImport(raw).messages).toEqual(messages)
    expect(JSON.parse(raw).config).toBeUndefined()
  })
})
