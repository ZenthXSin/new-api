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
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { getMessageEditorState } from '../../../lib/message/message-editor-utils'
import type { Message } from '../../../types'
import { MessageActions } from '../message-actions'
import { PlaygroundMessageEditor } from '../playground-message-editor'

const attachmentMessage: Message = {
  key: 'picture',
  from: 'user',
  versions: [
    {
      id: 'version-1',
      content: '',
      attachments: [
        {
          id: 'picture-1',
          name: 'image.png',
          kind: 'image',
          mimeType: 'image/png',
          size: 1,
          dataUrl: 'data:image/png;base64,AA==',
        },
      ],
    },
  ],
}
describe('attachment message editing', () => {
  test('offers edit and regenerate for an attachment-only message without an empty copy action', () => {
    const edit = vi.fn()
    const regenerate = vi.fn()
    render(
      <MessageActions
        message={attachmentMessage}
        onEdit={edit}
        onRegenerate={regenerate}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(edit).toHaveBeenCalledWith(attachmentMessage)
    expect(regenerate).toHaveBeenCalledWith(attachmentMessage)
    expect(
      screen.queryByRole('button', { name: 'Copy' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Copied' })
    ).not.toBeInTheDocument()
  })
  test('allows removing all text while retaining the original attachment', () => {
    const message: Message = {
      ...attachmentMessage,
      versions: [
        { ...attachmentMessage.versions[0], content: 'Describe this' },
      ],
    }
    expect(getMessageEditorState(message, '', 'Describe this').canSave).toBe(
      true
    )
    const save = vi.fn()
    render(
      <PlaygroundMessageEditor
        message={message}
        originalText='Describe this'
        editText=''
        onEditTextChange={vi.fn()}
        onSaveEdit={save}
      />
    )
    expect(
      screen.getByText(
        'Existing attachments will be kept when you save or resend this message.'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledWith('')
  })
  test('still rejects empty edits to a message without attachments', () => {
    const message: Message = {
      ...attachmentMessage,
      versions: [{ id: 'text-only', content: 'Hello' }],
    }
    expect(getMessageEditorState(message, '', 'Hello').canSave).toBe(false)
  })
})
