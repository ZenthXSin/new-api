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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodexComposer } from '../components/composer'
import { status } from './fixtures'

const props = {
  status,
  model: 'codex-test',
  effort: 'high',
  mode: 'code' as const,
  onModel: vi.fn(),
  onEffort: vi.fn(),
  onMode: vi.fn(),
}

describe('Codex web task composer', () => {
  test('the composer keeps reasoning and send controls without a microphone button', () => {
    render(<CodexComposer {...props} onSubmit={vi.fn()} />)
    expect(
      screen.queryByRole('button', { name: /Voice input|Stop voice input/ })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Reasoning effort' })
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Start task' })).toBeVisible()
  })
  test('the reasoning pill opens model settings and a supported-effort slider above the input', async () => {
    render(<CodexComposer {...props} onSubmit={vi.fn()} />)
    expect(
      screen.queryByRole('combobox', { name: 'Codex model' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Reasoning effort' })
    )
    const slider = await screen.findByRole('slider', {
      name: 'Reasoning effort',
    })
    expect(slider).toHaveAttribute('aria-valuetext', 'High')
    expect(slider).toHaveAttribute('max', '2')
    expect(
      screen.getByRole('combobox', { name: 'Codex model' })
    ).toHaveTextContent('Codex Test')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(props.onEffort).toHaveBeenLastCalledWith('low')
  })

  test('Safari IME confirmation does not submit when composition ends before Enter', () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    render(<CodexComposer {...props} onSubmit={submit} />)
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: '修复中文输入体验' } })
    fireEvent.keyDown(textbox, {
      key: 'Enter',
      keyCode: 229,
      isComposing: false,
    })
    expect(submit).not.toHaveBeenCalled()
    expect(textbox).toHaveValue('修复中文输入体验')
  })

  test('the plus menu opens with the keyboard and attaches files through the real picker callback', async () => {
    const upload = vi.fn()
    render(
      <CodexComposer {...props} onUploadFiles={upload} onSubmit={vi.fn()} />
    )
    const trigger = screen.getByRole('button', { name: 'Add files and more' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    const item = await screen.findByRole('menuitem', {
      name: 'Add photos & files',
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(upload).not.toHaveBeenCalled()
    await userEvent.click(item)
    expect(upload).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    )
  })

  test('Escape closes the attachment menu and returns focus to the plus control', async () => {
    render(
      <CodexComposer {...props} onUploadFiles={vi.fn()} onSubmit={vi.fn()} />
    )
    const trigger = screen.getByRole('button', { name: 'Add files and more' })
    await userEvent.click(trigger)
    expect(await screen.findByRole('menu')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })

  test('running with an empty draft displays only stop until a follow-up is composed', () => {
    render(
      <CodexComposer {...props} running onStop={vi.fn()} onSubmit={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Stop task' })).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Queue message' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Interrupt and send' })
    ).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '下一步' },
    })
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Interrupt and send' })
    ).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop task' })).toBeEnabled()
  })

  test('uploads block sending without losing the draft and enable sending when complete', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <CodexComposer
        {...props}
        uploading
        onUploadFiles={vi.fn()}
        onSubmit={submit}
      />
    )
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'Review the attached file' } })
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Add files and more' })
    ).toBeDisabled()
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    view.rerender(
      <CodexComposer
        {...props}
        uploadedFiles={['notes.txt']}
        onUploadFiles={vi.fn()}
        onSubmit={submit}
      />
    )
    expect(textbox).toHaveValue('Review the attached file')
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled()
    fireEvent.keyDown(textbox, { key: 'Enter' })
    await waitFor(() => expect(submit).toHaveBeenCalledOnce())
  })

  test('entry and task follow-up composers describe their task context at a comfortable initial height', () => {
    const view = render(<CodexComposer {...props} onSubmit={vi.fn()} />)
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textbox).toHaveAttribute('placeholder', 'Collaborate with Codex')
    expect(textbox.style.height).toBe('48px')
    view.rerender(<CodexComposer {...props} compact onSubmit={vi.fn()} />)
    const followup = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(followup).toHaveAttribute('placeholder', 'Collaborate with Codex')
    expect(followup.style.height).toBe('48px')
  })

  test('compact task follow-up keeps approval, model and effort controls visible and sends using the current mode', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    render(<CodexComposer {...props} compact mode='ask' onSubmit={submit} />)
    expect(
      screen.getByRole('combobox', { name: 'Approval mode' })
    ).toBeEnabled()
    expect(
      screen.getByRole('combobox', { name: 'Approval mode' })
    ).toHaveTextContent('Read-only')
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Reasoning effort' })
    )
    expect(screen.getByRole('combobox', { name: 'Codex model' })).toBeEnabled()
    await userEvent.keyboard('{Escape}')
    expect(
      screen.getByRole('combobox', { name: 'Reasoning effort' })
    ).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Explain the previous result' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'ask',
        prompt: 'Explain the previous result',
      })
    )
  })

  test('a single submit arrow starts a task with the selected approval mode', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    const onMode = vi.fn()
    const view = render(
      <CodexComposer {...props} onMode={onMode} onSubmit={submit} />
    )
    expect(
      screen.queryByRole('button', { name: 'Ask' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Code' })
    ).not.toBeInTheDocument()
    const send = screen.getByRole('button', { name: 'Start task' })
    expect(send).toHaveAttribute('type', 'submit')
    expect(send.textContent).toBe('')
    const approval = screen.getByRole('combobox', { name: 'Approval mode' })
    expect(approval).toHaveTextContent('Request approval')
    await userEvent.click(approval)
    expect(
      screen.queryByRole('option', { name: /Approve for me/ })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: /Read-only/ }))
    expect(onMode).toHaveBeenLastCalledWith('ask')
    view.rerender(
      <CodexComposer {...props} mode='ask' onMode={onMode} onSubmit={submit} />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Explain this code' },
    })
    await userEvent.click(send)
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'ask', prompt: 'Explain this code' })
    )
  })

  test('changing approval mode after a failed send creates a new request identity', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Offline'))
    const view = render(
      <CodexComposer {...props} mode='ask' onSubmit={submit} />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Review this task' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await screen.findByRole('alert')
    view.rerender(<CodexComposer {...props} mode='code' onSubmit={submit} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await screen.findByRole('alert')
    expect(submit.mock.calls[0][0].mode).toBe('ask')
    expect(submit.mock.calls[1][0].mode).toBe('code')
    expect(submit.mock.calls[0][0].requestId).not.toBe(
      submit.mock.calls[1][0].requestId
    )
  })

  test('Enter uses the same selected approval mode as the submit arrow', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    render(<CodexComposer {...props} mode='ask' onSubmit={submit} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Explain the project' },
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'ask' })
      )
    )
  })

  test.each([false, true])(
    'project context precedes the input and approval controls in keyboard order when compact=%s',
    async (compact) => {
      const choose = vi.fn()
      render(
        <CodexComposer
          {...props}
          compact={compact}
          contextControls={
            <button type='button' onClick={choose}>
              Choose project
            </button>
          }
          onSubmit={vi.fn()}
        />
      )
      const project = screen.getByRole('button', { name: 'Choose project' })
      await userEvent.tab()
      expect(project).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      expect(choose).toHaveBeenCalledOnce()
      await userEvent.tab()
      expect(screen.getByRole('textbox')).toHaveFocus()
      await userEvent.tab()
      expect(
        screen.getByRole('combobox', { name: 'Approval mode' })
      ).toHaveFocus()
      await userEvent.tab()
      const reasoning = screen.getByRole('combobox', {
        name: 'Reasoning effort',
      })
      expect(reasoning).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      expect(
        await screen.findByRole('slider', { name: 'Reasoning effort' })
      ).toHaveFocus()
      await userEvent.keyboard('{Escape}')
      expect(reasoning).toHaveFocus()
    }
  )

  test('a model selector in the page header can be omitted from the composer without changing the submitted model', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    render(<CodexComposer {...props} hideModelSelector onSubmit={submit} />)
    expect(
      screen.queryByRole('combobox', { name: 'Codex model' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Approval mode' })
    ).toBeEnabled()
    expect(
      screen.getByRole('combobox', { name: 'Reasoning effort' })
    ).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Use the selected model' },
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'codex-test', effort: 'high' })
      )
    )
  })

  test('dropping multiple files shows a drop target and uploads every selected file', () => {
    const attach = vi.fn()
    render(
      <CodexComposer {...props} onAttachFiles={attach} onSubmit={vi.fn()} />
    )
    const textbox = screen.getByRole('textbox')
    const files = [
      new File(['first'], 'first.txt', { type: 'text/plain' }),
      new File(['second'], 'second.txt', { type: 'text/plain' }),
    ]
    const dataTransfer = { types: ['Files'], files }
    fireEvent.dragEnter(textbox, { dataTransfer })
    expect(screen.getByRole('status')).toHaveTextContent('Drop files here')
    fireEvent.drop(textbox, { dataTransfer })
    expect(attach).toHaveBeenCalledWith(files)
    expect(screen.queryByText('Drop files here')).not.toBeInTheDocument()
  })

  test('pasting an image attaches the file and leaves the text draft unchanged', () => {
    const attach = vi.fn()
    render(
      <CodexComposer {...props} onAttachFiles={attach} onSubmit={vi.fn()} />
    )
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'Describe this screenshot' } })
    const screenshot = new File(['pixels'], 'screenshot.png', {
      type: 'image/png',
    })
    fireEvent.paste(textbox, { clipboardData: { files: [screenshot] } })
    expect(attach).toHaveBeenCalledWith([screenshot])
    expect(textbox).toHaveValue('Describe this screenshot')
  })

  test('ordinary text paste remains native and does not open an upload', () => {
    const attach = vi.fn()
    render(
      <CodexComposer {...props} onAttachFiles={attach} onSubmit={vi.fn()} />
    )
    const prevented = !fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { files: [], getData: () => 'Pasted text' },
    })
    expect(prevented).toBe(false)
    expect(attach).not.toHaveBeenCalled()
  })

  test.each([{ uploading: true }, { busy: true }, { disabled: true }])(
    'unavailable attachments block drop and paste without starting another upload: %j',
    (state) => {
      const attach = vi.fn()
      render(
        <CodexComposer
          {...props}
          {...state}
          onAttachFiles={attach}
          onSubmit={vi.fn()}
        />
      )
      const textbox = screen.getByRole('textbox')
      const file = new File(['note'], 'notes.txt', { type: 'text/plain' })
      const dataTransfer = { types: ['Files'], files: [file] }
      fireEvent.dragEnter(textbox, { dataTransfer })
      expect(screen.queryByText('Drop files here')).not.toBeInTheDocument()
      expect(fireEvent.drop(textbox, { dataTransfer })).toBe(false)
      fireEvent.paste(textbox, { clipboardData: { files: [file] } })
      expect(attach).not.toHaveBeenCalled()
    }
  )

  test('a full set of attachments scrolls inside a bounded list so composing stays reachable', () => {
    const files = Array.from(
      { length: 20 },
      (_, index) => `attachment-${index}.txt`
    )
    render(
      <CodexComposer
        {...props}
        uploadedFiles={files}
        onRemoveUploadedFile={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    const attachments = screen.getByRole('list', { name: 'Uploaded files' })
    expect(attachments).toHaveClass(
      'max-h-36',
      'overflow-y-auto',
      'overflow-x-hidden'
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(20)
    expect(screen.getByRole('textbox')).toBeEnabled()
  })
})
