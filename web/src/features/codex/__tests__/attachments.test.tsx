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

function wrapper(props: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return (
    <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
  )
}

beforeEach(() => sessionStorage.clear())

test('uploads completed after switching conversations stay attached to their original conversation and survive a refresh', async () => {
  let finish: ((result: { path: string; size: number }) => void) | undefined
  vi.spyOn(codexApi, 'upload').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const hook = renderHook(
    (props: { conversation: string }) =>
      useCodexAttachments(
        'actor',
        'project',
        props.conversation,
        25 * 1024 * 1024
      ),
    {
      wrapper,
      initialProps: { conversation: 'first' },
    }
  )
  act(() => hook.result.current.uploadFiles([new File(['image'], 'photo.png')]))
  await waitFor(() => expect(finish).toBeDefined())
  hook.rerender({ conversation: 'second' })
  await act(async () => finish?.({ path: 'photo.png', size: 5 }))
  expect(hook.result.current.uploadedFiles).toEqual([])
  hook.rerender({ conversation: 'first' })
  await waitFor(() =>
    expect(hook.result.current.uploadedFiles).toEqual(['photo.png'])
  )
  hook.unmount()
  const restored = renderHook(
    () => useCodexAttachments('actor', 'project', 'first', 25 * 1024 * 1024),
    { wrapper }
  )
  expect(restored.result.current.uploadedFiles).toEqual(['photo.png'])
})

test('a conflict in a multi-file upload preserves successful attachments and reports the failed filename', async () => {
  vi.spyOn(codexApi, 'upload')
    .mockResolvedValueOnce({ path: 'first.txt', size: 1 })
    .mockRejectedValueOnce(new Error('File already exists'))
  const hook = renderHook(
    () =>
      useCodexAttachments('actor', 'project', 'conversation', 25 * 1024 * 1024),
    { wrapper }
  )
  act(() =>
    hook.result.current.uploadFiles([
      new File(['a'], 'first.txt'),
      new File(['b'], 'existing.txt'),
    ])
  )
  await waitFor(() =>
    expect(hook.result.current.error).toBe('existing.txt: File already exists')
  )
  expect(hook.result.current.uploadedFiles).toEqual(['first.txt'])
  act(() => hook.result.current.clearSubmitted(['first.txt']))
  expect(hook.result.current.uploadedFiles).toEqual([])
})
