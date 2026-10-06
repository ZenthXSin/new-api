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

import type { PlaygroundAttachment } from '../../types'
import { ATTACHMENT_LIMITS, prepareAttachments } from '../attachment-files'

const image = () =>
  new File(
    [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])],
    'image.png',
    { type: 'image/png' }
  )
describe('attachment file validation', () => {
  test('keeps UTF-8 text, PDF data, and image data in serializable attachments', async () => {
    const result = await prepareAttachments(
      [
        new File(['你好'], 'notes.txt', { type: 'text/plain' }),
        new File(['%PDF-1.7 content'], 'paper.pdf', {
          type: 'application/pdf',
        }),
        image(),
      ],
      []
    )
    expect(result[0]).toMatchObject({ kind: 'text', text: '你好', size: 6 })
    expect(result[1]).toMatchObject({
      kind: 'pdf',
      dataUrl: 'data:application/pdf;base64,JVBERi0xLjcgY29udGVudA==',
    })
    expect(result[2].dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(
      result.every((item) => item.id && !item.dataUrl?.startsWith('blob:'))
    ).toBe(true)
  })
  test('rejects an entire selection if a file has an unsupported type', async () => {
    await expect(
      prepareAttachments(
        [
          image(),
          new File(['hello'], 'program.exe', {
            type: 'application/x-msdownload',
          }),
        ],
        []
      )
    ).rejects.toMatchObject({
      key: 'Unsupported file type: {{name}}. Use an image, PDF, or text file.',
      fileName: 'program.exe',
    })
  })
  test('rejects empty files and files that disguise their format', async () => {
    await expect(
      prepareAttachments([new File([], 'empty.txt')], [])
    ).rejects.toMatchObject({
      key: '{{name}} is empty. Choose a file with content.',
    })
    await expect(
      prepareAttachments([new File(['not a PDF'], 'false.pdf')], [])
    ).rejects.toMatchObject({
      key: '{{name}} does not match its image or PDF file type.',
    })
  })
  test('rejects binary or invalid UTF-8 passed as a text file', async () => {
    await expect(
      prepareAttachments(
        [new File([new Uint8Array([255, 0])], 'binary.txt')],
        []
      )
    ).rejects.toMatchObject({ key: '{{name}} is not a valid UTF-8 text file.' })
  })
  test('enforces file count and the total including existing attachments', async () => {
    await expect(
      prepareAttachments(Array.from({ length: 7 }, image), [])
    ).rejects.toMatchObject({
      key: 'You can attach up to 6 files per message.',
    })
    const existing: PlaygroundAttachment = {
      id: 'previous',
      name: 'large.pdf',
      kind: 'pdf',
      mimeType: 'application/pdf',
      size: ATTACHMENT_LIMITS.totalBytes,
    }
    await expect(
      prepareAttachments([image()], [existing])
    ).rejects.toMatchObject({ key: 'Attachments must total 12 MB or less.' })
  })
  test('rejects oversized text before decoding and oversized files before reading', async () => {
    await expect(
      prepareAttachments(
        [
          new File(
            [new Uint8Array(ATTACHMENT_LIMITS.textBytes + 1)],
            'large.txt'
          ),
        ],
        []
      )
    ).rejects.toMatchObject({
      key: '{{name}} exceeds the 1 MB text file limit.',
    })
    await expect(
      prepareAttachments(
        [
          new File(
            [new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1)],
            'large.pdf'
          ),
        ],
        []
      )
    ).rejects.toMatchObject({ key: '{{name}} exceeds the 8 MB file limit.' })
  })
})
