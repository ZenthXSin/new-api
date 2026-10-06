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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'sonner'
import { describe, expect, test, vi } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { PlaygroundInput } from '../playground-input'

const options = {
  config: DEFAULT_CONFIG,
  parameterEnabled: DEFAULT_PARAMETER_ENABLED,
  onParameterEnabledChange: vi.fn(),
  models: [{ value: 'chat', label: 'Chat' }],
  modelValue: 'chat',
  onModelChange: vi.fn(),
  groups: [{ value: 'main', label: 'Main', ratio: 1 }],
  groupValue: 'main',
  onGroupChange: vi.fn(),
  onConfigChange: vi.fn(),
}
function addTextFile() {
  fireEvent.change(screen.getByLabelText('Upload file'), {
    target: {
      files: [new File(['Document text'], 'notes.txt', { type: 'text/plain' })],
    },
  })
}
describe('playground attachment input', () => {
  test('sends attachment-only drafts and clears them only after acceptance', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    render(<PlaygroundInput {...options} onSubmit={submit} />)
    addTextFile()
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Send' })[0]).toBeEnabled()
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0])
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith('', [
        expect.objectContaining({
          name: 'notes.txt',
          kind: 'text',
          text: 'Document text',
        }),
      ])
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Remove notes.txt' })
      ).not.toBeInTheDocument()
    )
  })
  test('retains text and attachments when validation or storage rejects submission', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('storage'))
    render(<PlaygroundInput {...options} onSubmit={submit} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Please read this' },
    })
    addTextFile()
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0])
    await screen.findByText(
      'The message was not sent. Your draft is still here. Please try again.'
    )
    expect(screen.getByRole('textbox')).toHaveValue('Please read this')
    expect(
      screen.getByRole('button', { name: 'Remove notes.txt' })
    ).toBeEnabled()
  })
  test('accepts clipboard and drop files and allows removing previews', async () => {
    render(<PlaygroundInput {...options} onSubmit={vi.fn()} />)
    const textbox = screen.getByRole('textbox')
    fireEvent.paste(textbox, {
      clipboardData: { files: [new File(['pasted'], 'paste.txt')] },
    })
    await screen.findByRole('button', { name: 'Remove paste.txt' })
    fireEvent.drop(textbox, {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['dropped'], 'drop.txt')],
      },
    })
    await screen.findByRole('button', { name: 'Remove drop.txt' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove paste.txt' }))
    expect(
      screen.queryByRole('button', { name: 'Remove paste.txt' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove drop.txt' })
    ).toBeInTheDocument()
  })
  test('toggles real web search state and exposes the selected button state', async () => {
    const change = vi.fn()
    const view = render(
      <PlaygroundInput
        {...options}
        onSubmit={vi.fn()}
        onConfigChange={change}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(change).toHaveBeenCalledWith('web_search', true)
    view.rerender(
      <PlaygroundInput
        {...options}
        config={{ ...DEFAULT_CONFIG, web_search: true }}
        onSubmit={vi.fn()}
        onConfigChange={change}
      />
    )
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
  test('blocks Enter while the current group models are being refreshed', async () => {
    const submit = vi.fn()
    render(<PlaygroundInput {...options} onSubmit={submit} isModelLoading />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Hello' },
    })
    const form = screen.getByRole('textbox').closest('form')
    if (!form) throw new Error('Input form missing')
    fireEvent.submit(form)
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Send' })[0]).toBeDisabled()
    )
    expect(submit).not.toHaveBeenCalled()
  })
  test('does not lose a draft when Enter is pressed without an available model', async () => {
    const submit = vi.fn()
    render(<PlaygroundInput {...options} models={[]} onSubmit={submit} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), 'Keep this draft{Enter}')
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
    expect(submit).not.toHaveBeenCalled()
  })
  test('does not lose text or a file when Enter is pressed while the file is being read', async () => {
    const submit = vi.fn()
    const originalRead = FileReader.prototype.readAsArrayBuffer
    let finishRead: (() => void) | undefined
    vi.spyOn(FileReader.prototype, 'readAsArrayBuffer').mockImplementation(
      function (this: FileReader, blob: Blob) {
        finishRead = () => originalRead.call(this, blob)
      }
    )
    render(<PlaygroundInput {...options} onSubmit={submit} />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), 'Keep this attachment')
    addTextFile()
    await screen.findByText('Reading attachments…')
    await user.type(screen.getByRole('textbox'), '{Enter}')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toHaveValue('Keep this attachment')
    await act(async () => finishRead?.())
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    expect(screen.getByRole('textbox')).toHaveValue('Keep this attachment')
  })

  test('preserves an attachment draft after an unsupported file is rejected', async () => {
    render(<PlaygroundInput {...options} onSubmit={vi.fn()} />)
    addTextFile()
    await screen.findByRole('button', { name: 'Remove notes.txt' })
    fireEvent.change(screen.getByLabelText('Upload file'), {
      target: {
        files: [
          new File(['bad'], 'program.exe', {
            type: 'application/x-msdownload',
          }),
        ],
      },
    })
    await screen.findByText(
      'Unsupported file type: program.exe. Use an image, PDF, or text file.'
    )
    expect(
      screen.getByRole('button', { name: 'Remove notes.txt' })
    ).toBeEnabled()
  })
  test('keeps the clear confirmation open and reports a failed clear instead of success', async () => {
    const clear = vi.fn().mockRejectedValue(new Error('storage unavailable'))
    render(
      <>
        <Toaster />
        <PlaygroundInput
          {...options}
          hasMessages
          onClearMessages={clear}
          onSubmit={vi.fn()}
        />
      </>
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear chat history' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await screen.findByText(
      'Could not clear the conversation. Please try again.'
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.queryByText('Conversation cleared')).not.toBeInTheDocument()
  })
})
