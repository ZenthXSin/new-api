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

import { messagesSchema } from '../storage-schema'

const attachment = {
  id: 'image-1',
  name: 'diagram.png',
  mimeType: 'image/png',
  size: 1,
  kind: 'image' as const,
  dataUrl: 'data:image/png;base64,YQ==',
}
const message = {
  key: 'message-1',
  from: 'user',
  versions: [{ id: 'v1', content: 'Review', attachments: [attachment] }],
}

describe('Playground stored conversation', () => {
  test('retains attachment bytes and metadata so reload sends the same conversation', () => {
    expect(messagesSchema.parse([message])).toEqual([message])
  })
  test('rejects unavailable blob attachments rather than silently dropping them', () => {
    expect(
      messagesSchema.safeParse([
        {
          ...message,
          versions: [
            {
              id: 'v1',
              content: '',
              attachments: [{ ...attachment, dataUrl: 'blob:old-tab' }],
            },
          ],
        },
      ]).success
    ).toBe(false)
  })
  test('does not truncate long text during validation', () => {
    const content = 'Complete document '.repeat(3000)
    expect(
      messagesSchema.parse([
        { ...message, versions: [{ id: 'v1', content }] },
      ])[0].versions[0].content
    ).toBe(content)
  })
  test('keeps response diagnostics and cache token metadata across reload', () => {
    const response = {
      key: 'assistant',
      from: 'assistant',
      versions: [{ id: 'a1', content: 'Partial' }],
      status: 'error',
      errorCode: 'upstream',
      errorMessage: 'Provider detail',
      usage: {
        prompt_tokens: 7,
        completion_tokens: 2,
        total_tokens: 9,
        prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 3 },
      },
      firstTokenMs: 123,
      model: 'test-model',
      finishReason: 'stop',
    }
    expect(messagesSchema.parse([response])).toEqual([response])
  })
})
