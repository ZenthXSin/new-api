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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { codexApi } from '../api'
import { useCodexAttachments } from '../hooks/use-codex-attachments'

const maxBytes = 25 * 1024 * 1024

function wrapper(props: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  )
}

beforeEach(() => sessionStorage.clear())

test('switching accounts restores only the selected account attachments and preserves both saved drafts', () => {
  sessionStorage.setItem(
    'codex-attachments:first',
    JSON.stringify({ 'project:conversation': ['first-private.txt'] })
  )
  sessionStorage.setItem(
    'codex-attachments:second',
    JSON.stringify({ 'project:conversation': ['second-private.txt'] })
  )
  const hook = renderHook(
    (props: { actor: string }) =>
      useCodexAttachments(props.actor, 'project', 'conversation', maxBytes),
    { wrapper, initialProps: { actor: 'first' } }
  )

  expect(hook.result.current.uploadedFiles).toEqual(['first-private.txt'])
  hook.rerender({ actor: 'second' })
  expect(hook.result.current.uploadedFiles).toEqual(['second-private.txt'])
  act(() => hook.result.current.removeFile('second-private.txt'))
  hook.rerender({ actor: 'first' })
  expect(hook.result.current.uploadedFiles).toEqual(['first-private.txt'])
  expect(
    JSON.parse(sessionStorage.getItem('codex-attachments:second') || '{}')
  ).toEqual({ 'project:conversation': [] })
})

test('switching accounts during a batch preserves the completed upload for its owner and stops further requests', async () => {
  let finish: ((result: { path: string; size: number }) => void) | undefined
  const upload = vi.spyOn(codexApi, 'upload').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(
    (props: { actor: string }) =>
      useCodexAttachments(props.actor, 'project', 'conversation', maxBytes),
    { wrapper, initialProps: { actor: 'first' } }
  )
  act(() =>
    hook.result.current.uploadFiles([
      new File(['private'], 'first.txt'),
      new File(['private'], 'second.txt'),
    ])
  )
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  hook.rerender({ actor: 'second' })
  expect(hook.result.current.uploading).toBe(false)
  await act(async () => finish?.({ path: 'first.txt', size: 7 }))

  expect(upload).toHaveBeenCalledTimes(1)
  expect(hook.result.current.uploadedFiles).toEqual([])
  expect(hook.result.current.error).toBeUndefined()
  hook.rerender({ actor: 'first' })
  await waitFor(() => expect(hook.result.current.uploading).toBe(false))
  expect(hook.result.current.uploadedFiles).toEqual(['first.txt'])
  expect(hook.result.current.error).toMatch(/session changed/i)
})

test('upload progress and failure belong to the original conversation and selecting the failed file again retries it', async () => {
  let fail: ((reason: Error) => void) | undefined
  const upload = vi.spyOn(codexApi, 'upload').mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject
      })
  )
  const file = new File(['content'], 'notes.txt')
  const hook = renderHook(
    (props: { conversation: string }) =>
      useCodexAttachments('owner', 'project', props.conversation, maxBytes),
    { wrapper, initialProps: { conversation: 'first' } }
  )
  act(() => hook.result.current.uploadFiles([file]))
  await waitFor(() => expect(hook.result.current.uploading).toBe(true))
  hook.rerender({ conversation: 'second' })
  expect(hook.result.current.uploading).toBe(false)
  await act(async () => fail?.(new Error('Connection lost')))
  expect(hook.result.current.error).toBeUndefined()
  hook.rerender({ conversation: 'first' })
  await waitFor(() =>
    expect(hook.result.current.error).toBe('notes.txt: Connection lost')
  )

  upload.mockResolvedValueOnce({ path: 'notes.txt', size: 7 })
  act(() => hook.result.current.uploadFiles([file]))
  await waitFor(() =>
    expect(hook.result.current.uploadedFiles).toEqual(['notes.txt'])
  )
  expect(hook.result.current.error).toBeUndefined()
  expect(upload).toHaveBeenLastCalledWith('project', 'notes.txt', file)
})

test('overlapping file selections reserve remaining attachment slots before the first upload resolves', async () => {
  const existing = Array.from(
    { length: 19 },
    (_, index) => `saved-${index}.txt`
  )
  sessionStorage.setItem(
    'codex-attachments:owner',
    JSON.stringify({ 'project:conversation': existing })
  )
  let finish: ((result: { path: string; size: number }) => void) | undefined
  const upload = vi.spyOn(codexApi, 'upload').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  act(() => {
    hook.result.current.uploadFiles([new File(['a'], 'last.txt')])
    hook.result.current.uploadFiles([new File(['b'], 'overflow.txt')])
  })
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  expect(hook.result.current.error).toBe('Attach up to 20 files per message.')
  await act(async () => finish?.({ path: 'last.txt', size: 1 }))
  await waitFor(() => expect(hook.result.current.uploading).toBe(false))
  expect(hook.result.current.uploadedFiles).toEqual([...existing, 'last.txt'])
})

test('a successful send clears only its captured conversation paths and preserves files attached afterward', async () => {
  sessionStorage.setItem(
    'codex-attachments:owner',
    JSON.stringify({
      'project:first': ['sent.txt'],
      'project:second': ['second.txt'],
    })
  )
  vi.spyOn(codexApi, 'upload').mockResolvedValue({ path: 'later.txt', size: 1 })
  const hook = renderHook(
    (props: { conversation: string }) =>
      useCodexAttachments('owner', 'project', props.conversation, maxBytes),
    { wrapper, initialProps: { conversation: 'first' } }
  )
  const completeSend = hook.result.current.clearSubmitted
  const sentPaths = hook.result.current.uploadedFiles
  act(() => hook.result.current.uploadFiles([new File(['a'], 'later.txt')]))
  await waitFor(() =>
    expect(hook.result.current.uploadedFiles).toEqual(['sent.txt', 'later.txt'])
  )
  hook.rerender({ conversation: 'second' })
  act(() => completeSend(sentPaths))
  expect(hook.result.current.uploadedFiles).toEqual(['second.txt'])
  hook.rerender({ conversation: 'first' })
  expect(hook.result.current.uploadedFiles).toEqual(['later.txt'])
})

test('a configured upload limit rejects oversized files without claiming a fixed limit or sending bytes', async () => {
  const upload = vi.spyOn(codexApi, 'upload')
  const hook = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', 3),
    { wrapper }
  )
  act(() => hook.result.current.uploadFiles([new File(['large'], 'large.txt')]))
  await waitFor(() =>
    expect(hook.result.current.error).toBe('The file exceeds the upload limit.')
  )
  expect(upload).not.toHaveBeenCalled()
  expect(hook.result.current.uploading).toBe(false)
})

test('finishing an upload after leaving the workbench preserves its attachment for the next visit', async () => {
  let finish: ((result: { path: string; size: number }) => void) | undefined
  vi.spyOn(codexApi, 'upload').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  act(() => hook.result.current.uploadFiles([new File(['a'], 'notes.txt')]))
  await waitFor(() => expect(finish).toBeDefined())
  hook.unmount()
  await act(async () => finish?.({ path: 'notes.txt', size: 1 }))
  const restored = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  expect(restored.result.current.uploadedFiles).toEqual(['notes.txt'])
  expect(restored.result.current.uploading).toBe(false)
})

test('switching accounts away and back while an upload is pending still cancels the rest of that batch', async () => {
  let finish: ((result: { path: string; size: number }) => void) | undefined
  const upload = vi.spyOn(codexApi, 'upload').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(
    (props: { actor: string }) =>
      useCodexAttachments(props.actor, 'project', 'conversation', maxBytes),
    { wrapper, initialProps: { actor: 'first' } }
  )
  act(() =>
    hook.result.current.uploadFiles([
      new File(['a'], 'completed.txt'),
      new File(['b'], 'not-started.txt'),
    ])
  )
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  hook.rerender({ actor: 'second' })
  hook.rerender({ actor: 'first' })
  await act(async () => finish?.({ path: 'completed.txt', size: 1 }))
  await waitFor(() => expect(hook.result.current.uploading).toBe(false))
  expect(upload).toHaveBeenCalledTimes(1)
  expect(hook.result.current.uploadedFiles).toEqual(['completed.txt'])
  expect(hook.result.current.error).toMatch(/session changed/i)
})

test('a failed batch can retry its failed file without re-uploading or losing the files that already succeeded', async () => {
  const upload = vi
    .spyOn(codexApi, 'upload')
    .mockResolvedValueOnce({ path: 'complete.txt', size: 1 })
    .mockRejectedValueOnce(new Error('Connection lost'))
  const failed = new File(['b'], 'retry.txt')
  const hook = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  act(() =>
    hook.result.current.uploadFiles([new File(['a'], 'complete.txt'), failed])
  )
  await waitFor(() =>
    expect(hook.result.current.error).toBe('retry.txt: Connection lost')
  )
  expect(hook.result.current.uploadedFiles).toEqual(['complete.txt'])
  upload.mockResolvedValueOnce({ path: 'retry.txt', size: 1 })
  act(() => hook.result.current.uploadFiles([failed]))
  await waitFor(() => expect(hook.result.current.uploading).toBe(false))
  expect(hook.result.current.error).toBeUndefined()
  expect(hook.result.current.uploadedFiles).toEqual([
    'complete.txt',
    'retry.txt',
  ])
  expect(upload).toHaveBeenCalledTimes(3)
  expect(upload).toHaveBeenLastCalledWith('project', 'retry.txt', failed)
})

test('a send completing after an account change clears the original account draft without touching the new account', () => {
  for (const actor of ['first', 'second']) {
    sessionStorage.setItem(
      `codex-attachments:${actor}`,
      JSON.stringify({ 'project:conversation': ['shared-name.txt'] })
    )
  }
  const hook = renderHook(
    (props: { actor: string }) =>
      useCodexAttachments(props.actor, 'project', 'conversation', maxBytes),
    { wrapper, initialProps: { actor: 'first' } }
  )
  const completeSend = hook.result.current.clearSubmitted
  const sentPaths = hook.result.current.uploadedFiles
  hook.rerender({ actor: 'second' })
  act(() => completeSend(sentPaths))
  expect(hook.result.current.uploadedFiles).toEqual(['shared-name.txt'])
  hook.rerender({ actor: 'first' })
  expect(hook.result.current.uploadedFiles).toEqual([])
})

test('returning before an old upload finishes shows that attachment and preserves files added on the new visit', async () => {
  let finish: ((result: { path: string; size: number }) => void) | undefined
  vi.spyOn(codexApi, 'upload')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ path: 'new-visit.txt', size: 1 })
  const firstVisit = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  act(() =>
    firstVisit.result.current.uploadFiles([new File(['a'], 'old-visit.txt')])
  )
  await waitFor(() => expect(finish).toBeDefined())
  firstVisit.unmount()
  const nextVisit = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  act(() =>
    nextVisit.result.current.uploadFiles([new File(['b'], 'new-visit.txt')])
  )
  await waitFor(() =>
    expect(nextVisit.result.current.uploadedFiles).toEqual(['new-visit.txt'])
  )
  await act(async () => finish?.({ path: 'old-visit.txt', size: 1 }))
  expect(nextVisit.result.current.uploadedFiles).toEqual([
    'new-visit.txt',
    'old-visit.txt',
  ])
  expect(
    JSON.parse(sessionStorage.getItem('codex-attachments:owner') || '{}')
  ).toEqual({ 'project:conversation': ['new-visit.txt', 'old-visit.txt'] })
})

test('a send finishing after returning to the workbench clears the old references and preserves the new draft attachments', async () => {
  sessionStorage.setItem(
    'codex-attachments:owner',
    JSON.stringify({ 'project:conversation': ['sent.txt'] })
  )
  vi.spyOn(codexApi, 'upload').mockResolvedValueOnce({
    path: 'next-message.txt',
    size: 1,
  })
  const firstVisit = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  const completeSend = firstVisit.result.current.clearSubmitted
  const submitted = firstVisit.result.current.uploadedFiles
  firstVisit.unmount()
  const nextVisit = renderHook(
    () => useCodexAttachments('owner', 'project', 'conversation', maxBytes),
    { wrapper }
  )
  act(() =>
    nextVisit.result.current.uploadFiles([new File(['b'], 'next-message.txt')])
  )
  await waitFor(() => expect(nextVisit.result.current.uploading).toBe(false))
  act(() => completeSend(submitted))
  expect(nextVisit.result.current.uploadedFiles).toEqual(['next-message.txt'])
})

test('a homepage upload target binds the whole batch before the newly created project reaches hook props', async () => {
  let finish: ((result: { path: string; size: number }) => void) | undefined
  const upload = vi
    .spyOn(codexApi, 'upload')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({ path: 'second.txt', size: 1 })
  const hook = renderHook(
    (props: { workspaceId?: string; conversationId?: string }) =>
      useCodexAttachments(
        'owner',
        props.workspaceId,
        props.conversationId,
        maxBytes
      ),
    {
      wrapper,
      initialProps: {} as { workspaceId?: string; conversationId?: string },
    }
  )
  const first = new File(['a'], 'first.txt')
  const second = new File(['b'], 'second.txt')
  act(() =>
    hook.result.current.uploadFiles([first, second], {
      workspaceId: 'home-project',
      conversationId: 'home-conversation',
    })
  )
  await waitFor(() =>
    expect(upload).toHaveBeenCalledWith('home-project', 'first.txt', first)
  )
  hook.rerender({
    workspaceId: 'home-project',
    conversationId: 'home-conversation',
  })
  expect(hook.result.current.uploading).toBe(true)
  hook.rerender({
    workspaceId: 'other-project',
    conversationId: 'other-conversation',
  })
  await act(async () => finish?.({ path: 'first.txt', size: 1 }))
  await waitFor(() =>
    expect(upload).toHaveBeenCalledWith('home-project', 'second.txt', second)
  )
  expect(hook.result.current.uploadedFiles).toEqual([])
  hook.rerender({
    workspaceId: 'home-project',
    conversationId: 'home-conversation',
  })
  await waitFor(() => expect(hook.result.current.uploading).toBe(false))
  expect(hook.result.current.uploadedFiles).toEqual(['first.txt', 'second.txt'])
})

test('an explicit workspace target without a conversation does not inherit the previously selected conversation', async () => {
  const upload = vi
    .spyOn(codexApi, 'upload')
    .mockResolvedValueOnce({ path: 'new.txt', size: 1 })
  const hook = renderHook(
    (props: { workspaceId: string; conversationId?: string }) =>
      useCodexAttachments(
        'owner',
        props.workspaceId,
        props.conversationId,
        maxBytes
      ),
    {
      wrapper,
      initialProps: {
        workspaceId: 'previous',
        conversationId: 'previous-conversation',
      } as { workspaceId: string; conversationId?: string },
    }
  )
  act(() =>
    hook.result.current.uploadFiles([new File(['a'], 'new.txt')], {
      workspaceId: 'created',
    })
  )
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  expect(hook.result.current.uploadedFiles).toEqual([])
  hook.rerender({ workspaceId: 'created' })
  await waitFor(() =>
    expect(hook.result.current.uploadedFiles).toEqual(['new.txt'])
  )
})

test('an upload target captured before an account change cannot upload files under the new account', () => {
  const upload = vi.spyOn(codexApi, 'upload')
  const hook = renderHook(
    (props: { actor: string }) =>
      useCodexAttachments(props.actor, undefined, undefined, maxBytes),
    { wrapper, initialProps: { actor: 'first' } }
  )
  const uploadForPreviousAccount = hook.result.current.uploadFiles
  hook.rerender({ actor: 'second' })
  act(() =>
    uploadForPreviousAccount([new File(['a'], 'private.txt')], {
      workspaceId: 'created',
    })
  )
  expect(upload).not.toHaveBeenCalled()
  expect(hook.result.current.uploading).toBe(false)
  expect(hook.result.current.uploadedFiles).toEqual([])
})
