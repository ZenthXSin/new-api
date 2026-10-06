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

import type { PlaygroundAttachment } from '../../../types'
import {
  restoreConversationMessages,
  validateConversationMessages,
} from '../../storage/storage'
import {
  appendUserMessagePair,
  applyMessageEdit,
  createRegeneratedMessages,
  removeMessageByKey,
} from '../conversation-message-utils'
import { formatMessageForAPI, hasMessageContent } from '../message-utils'

const attachments: PlaygroundAttachment[] = [
  {
    id: 'image',
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 1,
    kind: 'image',
    dataUrl: 'data:image/png;base64,YQ==',
  },
  {
    id: 'pdf',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 1,
    kind: 'pdf',
    dataUrl: 'data:application/pdf;base64,Yg==',
  },
  {
    id: 'text',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 3,
    kind: 'text',
    text: 'abc',
  },
]

describe('conversation attachment lifecycle', () => {
  it('retains all attachment bytes through append, storage recovery and assistant retry', () => {
    const original = appendUserMessagePair(
      [],
      'Review these files',
      attachments
    )
    const expected = {
      role: 'user',
      content: [
        { type: 'text', text: 'Review these files' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
        {
          type: 'file',
          file: {
            filename: 'report.pdf',
            file_data: 'data:application/pdf;base64,Yg==',
          },
        },
        { type: 'text', text: '--- notes.txt ---\nabc' },
      ],
    }
    expect(formatMessageForAPI(original[0])).toEqual(expected)
    const restored = restoreConversationMessages(
      validateConversationMessages(structuredClone(original))
    )
    expect(restored[1]).toMatchObject({
      status: 'error',
      errorCode: 'interrupted',
    })
    const retried = createRegeneratedMessages(restored, restored[1].key)
    expect(retried).not.toBeNull()
    if (!retried) {
      throw new Error('Missing regenerated conversation')
    }
    expect(formatMessageForAPI(retried[0])).toEqual(expected)
    expect(retried[1].status).toBe('loading')
  })
  it('preserves attachments on text-only edit and removes them only when explicitly selected', () => {
    const messages = appendUserMessagePair([], 'Original', attachments)
    const kept = applyMessageEdit(messages, messages[0].key, 'Edited', true)
    expect(kept).not.toBeNull()
    if (!kept) {
      throw new Error('Missing edited conversation')
    }
    expect(kept.shouldSend).toBe(true)
    expect(kept.messages[0].versions[0].attachments).toEqual(attachments)
    const removed = applyMessageEdit(
      kept.messages,
      messages[0].key,
      'Text only',
      false,
      []
    )
    expect(removed).not.toBeNull()
    if (!removed) {
      throw new Error('Missing edited conversation')
    }
    expect(formatMessageForAPI(removed.messages[0])).toEqual({
      role: 'user',
      content: 'Text only',
    })
    expect(messages[0].versions[0].attachments).toEqual(attachments)
  })
  it('keeps attachment-only messages sendable and deletion removes only the selected message', () => {
    const messages = appendUserMessagePair([], '', attachments)
    expect(hasMessageContent(messages[0])).toBe(true)
    expect(formatMessageForAPI(messages[0]).content).toHaveLength(3)
    expect(removeMessageByKey(messages, messages[0].key)).toEqual([messages[1]])
  })
})
