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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { createUserMessage } from '../../../lib/message/message-utils'
import { exportConversationJSON } from '../../../lib/storage/conversation-transfer'
import { ConversationToolbar } from '../conversation-toolbar'

beforeEach(() => {
  localStorage.clear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'current', role: 1 })
})

function props() {
  return {
    messages: [createUserMessage('Existing history')],
    config: DEFAULT_CONFIG,
    parameterEnabled: DEFAULT_PARAMETER_ENABLED,
    storageStatus: 'saved' as const,
    storageError: null,
    onImport: vi.fn(async () => undefined),
    onRetrySave: vi.fn(async () => undefined),
    onClear: vi.fn(async () => undefined),
  }
}
function importFile(contents: string): File {
  const file = new File([contents], 'conversation.json', {
    type: 'application/json',
  })
  Object.defineProperty(file, 'text', { value: async () => contents })
  return file
}

describe('conversation import confirmation', () => {
  it('validates the file and waits for explicit confirmation before replacing any messages', async () => {
    const user = userEvent.setup()
    const options = props()
    const imported = [createUserMessage('Selected history')]
    const network = vi.spyOn(globalThis, 'fetch')
    render(<ConversationToolbar {...options} />)
    await user.upload(
      screen.getByLabelText('Import conversation file'),
      importFile(
        exportConversationJSON(
          imported,
          DEFAULT_CONFIG,
          DEFAULT_PARAMETER_ENABLED,
          7
        )
      )
    )
    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText('Replace the current conversation?')
    ).toBeVisible()
    expect(options.onImport).not.toHaveBeenCalled()
    await user.click(
      within(dialog).getByRole('button', { name: 'Import conversation' })
    )
    await waitFor(() => expect(options.onImport).toHaveBeenCalledWith(imported))
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    )
    expect(network).not.toHaveBeenCalled()
  })
  it('cancels without changing history and keeps confirmation open after a storage failure', async () => {
    const user = userEvent.setup()
    const options = props()
    const file = importFile(
      exportConversationJSON(
        [createUserMessage('Imported')],
        DEFAULT_CONFIG,
        DEFAULT_PARAMETER_ENABLED,
        7
      )
    )
    render(<ConversationToolbar {...options} />)
    await user.upload(screen.getByLabelText('Import conversation file'), file)
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      })
    )
    expect(options.onImport).not.toHaveBeenCalled()
    options.onImport.mockRejectedValueOnce(new Error('quota exceeded'))
    await user.upload(screen.getByLabelText('Import conversation file'), file)
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Import conversation',
      })
    )
    await waitFor(() =>
      expect(
        within(screen.getByRole('alertdialog')).getByRole('button', {
          name: 'Import conversation',
        })
      ).toBeEnabled()
    )
    expect(screen.getByRole('alertdialog')).toBeVisible()
  })
  it('does not expose old account import contents after switching accounts', async () => {
    const user = userEvent.setup()
    const options = props()
    render(<ConversationToolbar {...options} />)
    await user.upload(
      screen.getByLabelText('Import conversation file'),
      importFile(
        exportConversationJSON(
          [createUserMessage('First account')],
          DEFAULT_CONFIG,
          DEFAULT_PARAMETER_ENABLED,
          7
        )
      )
    )
    await screen.findByRole('alertdialog')
    act(() =>
      useAuthStore
        .getState()
        .auth.setUser({ id: 8, username: 'second', role: 1 })
    )
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    )
    expect(options.onImport).not.toHaveBeenCalled()
  })
  it('requires manual ownership confirmation for global legacy history', async () => {
    const user = userEvent.setup()
    const options = props()
    localStorage.setItem(
      'playground_messages',
      JSON.stringify({
        version: 1,
        data: [createUserMessage('Unowned legacy history')],
      })
    )
    render(<ConversationToolbar {...options} />)
    expect(options.onImport).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'Import legacy history' })
    )
    expect(
      within(await screen.findByRole('alertdialog')).getByText(
        'Legacy history has no account owner. Import it only if it belongs to you.'
      )
    ).toBeVisible()
    expect(options.onImport).not.toHaveBeenCalled()
  })
  it('rejects invalid attachment content before offering confirmation', async () => {
    const options = props()
    render(<ConversationToolbar {...options} />)
    fireEvent.change(screen.getByLabelText('Import conversation file'), {
      target: {
        files: [importFile('{"format":"new-api-playground","version":99}')],
      },
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Import conversation' })
      ).toBeEnabled()
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(options.onImport).not.toHaveBeenCalled()
  })
})
