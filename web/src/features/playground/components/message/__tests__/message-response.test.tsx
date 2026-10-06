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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'

import type { Message } from '../../../types'
import { MessageAttachments } from '../message-attachments'
import { MessageMetadata } from '../message-metadata'
import { PlaygroundMessageContent } from '../playground-message-content'

const message: Message = {
  key: 'response',
  from: 'assistant',
  status: 'complete',
  versions: [{ id: 'v1', content: 'A partial answer' }],
}

describe('message response display', () => {
  test('keeps restored interrupted content separate from the interruption notice', async () => {
    render(
      <PlaygroundMessageContent
        alignment='left'
        actions={null}
        message={{ ...message, status: 'error', errorCode: 'interrupted' }}
        versionContent='A partial answer'
      />
    )
    expect(await screen.findByText('A partial answer')).toBeVisible()
    expect(screen.getByText('Generation was interrupted')).toBeVisible()
  })
  test('shows partial response alongside its error and retry action', async () => {
    render(
      <PlaygroundMessageContent
        alignment='left'
        actions={<button type='button'>Copy response</button>}
        errorActions={<button type='button'>Retry</button>}
        message={{
          ...message,
          status: 'error',
          errorMessage: 'Connection interrupted',
        }}
        versionContent='A partial answer'
      />
    )
    expect(await screen.findByText('A partial answer')).toBeVisible()
    expect(screen.getByText('Connection interrupted')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy response' })).toBeVisible()
  })

  test('shows attachment-only user messages and their actions', () => {
    render(
      <PlaygroundMessageContent
        alignment='right'
        actions={<button type='button'>Delete attachment message</button>}
        message={{
          key: 'user',
          from: 'user',
          versions: [
            {
              id: 'v1',
              content: '',
              attachments: [
                {
                  id: 'pdf',
                  kind: 'pdf',
                  name: 'report.pdf',
                  mimeType: 'application/pdf',
                  size: 1,
                },
              ],
            },
          ],
        }}
        versionContent=''
      />
    )
    expect(screen.getByText('report.pdf')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Delete attachment message' })
    ).toBeVisible()
  })

  test('shows actual usage including zero cache but no fabricated metrics', () => {
    const { rerender } = render(
      <MessageMetadata alignment='left' message={message} />
    )
    expect(screen.queryByText(/Input tokens:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/First token:/)).not.toBeInTheDocument()
    rerender(
      <MessageMetadata
        alignment='left'
        message={{
          ...message,
          firstTokenMs: 125,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        }}
      />
    )
    expect(screen.getByText('First token: 125ms')).toBeVisible()
    expect(screen.getByText('Input tokens: 10')).toBeVisible()
    expect(screen.getByText('Cached input tokens: 0')).toBeVisible()
    expect(screen.getByText('Reasoning tokens: 1')).toBeVisible()
  })

  test('renders image/text/PDF attachments without executing markup or unsafe image URLs', async () => {
    const user = userEvent.setup()
    render(
      <MessageAttachments
        attachments={[
          {
            id: 'image',
            kind: 'image',
            name: 'photo.png',
            mimeType: 'image/png',
            size: 3,
            dataUrl: 'data:image/png;base64,YWJj',
          },
          {
            id: 'unsafe',
            kind: 'image',
            name: 'unsafe.svg',
            mimeType: 'image/svg+xml',
            size: 1,
            dataUrl: 'data:image/svg+xml,<svg onload="alert(1)"/>',
          },
          {
            id: 'text',
            kind: 'text',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 10,
            text: '<script>example</script>',
          },
          {
            id: 'pdf',
            kind: 'pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            size: 1,
            dataUrl: 'data:application/pdf;base64,YQ==',
          },
        ]}
      />
    )
    expect(
      screen.getByRole('list', { name: 'Message attachments' })
    ).toBeVisible()
    expect(screen.getByAltText('photo.png')).toHaveAttribute(
      'src',
      'data:image/png;base64,YWJj'
    )
    expect(screen.queryByAltText('unsafe.svg')).not.toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeVisible()
    await user.click(screen.getByText('Preview attachment'))
    expect(screen.getByText('<script>example</script>')).toBeVisible()
  })
})
