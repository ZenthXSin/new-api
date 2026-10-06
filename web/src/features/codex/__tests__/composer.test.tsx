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
describe('Codex task composer', () => {
  test('a failed request keeps the draft and retries with the same idempotency key', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(undefined)
    render(<CodexComposer {...props} onSubmit={submit} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Fix the login page' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connection lost'
    )
    expect(screen.getByRole('textbox')).toHaveValue('Fix the login page')
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0])
    expect(submit.mock.calls[0][0]).toMatchObject({
      prompt: 'Fix the login page',
      mode: 'code',
      model: 'codex-test',
      effort: 'high',
    })
  })
  test('editing a failed draft creates a different request key', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Disconnected'))
    render(<CodexComposer {...props} onSubmit={submit} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'First' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await screen.findByRole('alert')
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Second' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await screen.findByRole('alert')
    expect(submit.mock.calls[0][0].requestId).not.toBe(
      submit.mock.calls[1][0].requestId
    )
  })
  test('a busy submission ignores repeated form and keyboard submission', async () => {
    let resolve!: () => void
    const submit = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    render(<CodexComposer {...props} onSubmit={submit} />)
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'Build' } })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(submit).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(textbox).toHaveValue(''))
  })
  test('IME confirmation and shift-enter do not submit the task', () => {
    const submit = vi.fn()
    render(<CodexComposer {...props} onSubmit={submit} />)
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: '中文需求' } })
    fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    expect(submit).not.toHaveBeenCalled()
  })
  test('unavailable service blocks sending while preserving text', () => {
    const submit = vi.fn()
    render(<CodexComposer {...props} disabled onSubmit={submit} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Keep draft' },
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
    expect(submit).not.toHaveBeenCalled()
  })
  test('active tasks expose stop and lock execution mode', async () => {
    const stop = vi.fn()
    render(
      <CodexComposer {...props} running onStop={stop} onSubmit={vi.fn()} />
    )
    expect(screen.getByRole('combobox', { name: 'Codex mode' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Stop task' }))
    expect(stop).toHaveBeenCalledOnce()
  })
  test('stopping a task shows pending feedback and ignores repeated clicks', async () => {
    let finish!: () => void
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(
      <CodexComposer {...props} running onStop={stop} onSubmit={vi.fn()} />
    )
    const button = screen.getByRole('button', { name: 'Stop task' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Stopping task…')
    finish()
    await waitFor(() => expect(button).toBeEnabled())
  })
  test('textarea grows with a long draft and collapses when the draft is cleared', () => {
    render(<CodexComposer {...props} onSubmit={vi.fn()} />)
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    Object.defineProperty(textbox, 'scrollHeight', {
      configurable: true,
      value: 280,
    })
    fireEvent.change(textbox, {
      target: { value: 'A long task\nwith several lines' },
    })
    expect(textbox.style.height).toBe('224px')
    Object.defineProperty(textbox, 'scrollHeight', {
      configurable: true,
      value: 24,
    })
    fireEvent.change(textbox, { target: { value: '' } })
    expect(textbox.style.height).toBe('96px')
  })
  test('failed stop preserves the current draft and presents its error', async () => {
    render(
      <CodexComposer
        {...props}
        running
        onStop={vi.fn().mockRejectedValue(new Error('Unable to stop'))}
        onSubmit={vi.fn()}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Next task' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Stop task' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to stop')
    expect(screen.getByRole('textbox')).toHaveValue('Next task')
  })

  test('switching project draft scopes and remounting preserve only that account project draft', () => {
    const { rerender, unmount } = render(
      <CodexComposer
        {...props}
        draftKey='owner-a:project-a'
        onSubmit={vi.fn()}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Draft for A' },
    })
    rerender(
      <CodexComposer
        {...props}
        draftKey='owner-a:project-b'
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox')).toHaveValue('')
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Draft for B' },
    })
    rerender(
      <CodexComposer
        {...props}
        draftKey='owner-a:project-a'
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox')).toHaveValue('Draft for A')
    unmount()
    const other = render(
      <CodexComposer
        {...props}
        draftKey='owner-b:project-a'
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox')).toHaveValue('')
    other.unmount()
    render(
      <CodexComposer
        {...props}
        draftKey='owner-a:project-b'
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox')).toHaveValue('Draft for B')
    sessionStorage.clear()
  })
  test('retry after refresh uses the original request identifier then removes a successful draft', async () => {
    const first = vi.fn().mockRejectedValue(new Error('Offline'))
    const initial = render(
      <CodexComposer {...props} draftKey='owner:retry' onSubmit={first} />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Preserve request' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await screen.findByRole('alert')
    initial.unmount()
    const next = vi.fn().mockResolvedValue(undefined)
    render(<CodexComposer {...props} draftKey='owner:retry' onSubmit={next} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    expect(next.mock.calls[0][0].requestId).toBe(
      first.mock.calls[0][0].requestId
    )
    expect(sessionStorage.getItem('codex-draft:owner:retry')).toBeNull()
  })
  test('opening the composer does not steal focus from navigation or open the mobile keyboard', () => {
    render(<CodexComposer {...props} onSubmit={vi.fn()} />)
    expect(screen.getByRole('textbox')).not.toHaveFocus()
  })
  test('a submission finishing after switching project scopes does not clear the new project draft', async () => {
    let complete!: () => void
    const submit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    const view = render(
      <CodexComposer {...props} draftKey='late:a' onSubmit={submit} />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Task A' },
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    sessionStorage.setItem(
      'codex-draft:late:b',
      JSON.stringify({ draft: 'Keep B', retry: null })
    )
    view.rerender(
      <CodexComposer {...props} draftKey='late:b' onSubmit={submit} />
    )
    complete()
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    expect(screen.getByRole('textbox')).toHaveValue('Keep B')
    expect(sessionStorage.getItem('codex-draft:late:b')).toContain('Keep B')
    sessionStorage.clear()
  })

  test('an old successful request cannot erase a newer draft after reopening the same project', async () => {
    let complete!: () => void
    const submit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        })
    )
    const old = render(
      <CodexComposer {...props} draftKey='reopen:a' onSubmit={submit} />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'First request' },
    })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    old.unmount()
    render(<CodexComposer {...props} draftKey='reopen:a' onSubmit={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'New follow-up draft' },
    })
    await act(async () => {
      complete()
    })
    expect(sessionStorage.getItem('codex-draft:reopen:a')).toContain(
      'New follow-up draft'
    )
    expect(screen.getByRole('textbox')).toHaveValue('New follow-up draft')
    sessionStorage.clear()
  })

  test('browser storage failure does not block typing or sending the current draft', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full')
    })
    const submit = vi.fn().mockResolvedValue(undefined)
    render(
      <CodexComposer {...props} draftKey='storage:full' onSubmit={submit} />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Still send this task' },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    expect(submit).toHaveBeenCalledOnce()
  })
})
