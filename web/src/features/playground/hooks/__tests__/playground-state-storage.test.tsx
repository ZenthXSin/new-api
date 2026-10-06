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
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { createUserMessage } from '../../lib/message/message-utils'
import { loadMessages, saveMessages } from '../../lib/storage/storage'
import type { Message } from '../../types'
import { usePlaygroundState } from '../use-playground-state'

// IndexedDB is a browser boundary; the hook still uses the real validators and
// settings storage. Browser acceptance covers actual IndexedDB transactions.
vi.mock('../../lib/storage/storage', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/storage/storage')>()
  return { ...actual, loadMessages: vi.fn(), saveMessages: vi.fn() }
})
const stored = new Map<number, Message[]>()
beforeEach(() => {
  localStorage.clear()
  stored.clear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'first', role: 1 })
  vi.mocked(loadMessages).mockImplementation(
    async (id) => stored.get(id ?? -1) ?? null
  )
  vi.mocked(saveMessages).mockImplementation(async (messages, id) => {
    stored.set(id ?? -1, structuredClone(messages))
  })
})

describe('playground durable state', () => {
  it('retries a failed read without replacing previously saved history', async () => {
    const history = [createUserMessage('Do not overwrite')]
    stored.set(7, history)
    vi.mocked(loadMessages).mockRejectedValueOnce(
      new Error('temporary IndexedDB error')
    )
    const { result } = renderHook(() => usePlaygroundState())
    await waitFor(() => expect(result.current.storageStatus).toBe('error'))
    await expect(result.current.commitMessages([])).rejects.toThrow('account')
    expect(saveMessages).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.retrySave()
    })
    expect(result.current.messages).toEqual(history)
    expect(result.current.storageStatus).toBe('saved')
    expect(saveMessages).not.toHaveBeenCalled()
  })
  it('keeps settings errors visible after successful conversation writes and permits explicit recovery', async () => {
    localStorage.setItem('playground_v2:7:config', 'invalid JSON')
    const { result } = renderHook(() => usePlaygroundState())
    await waitFor(() => expect(result.current.isLoadingMessages).toBe(false))
    expect(result.current.storageError).toBe('settings')
    await act(async () => {
      await result.current.commitMessages([createUserMessage('Saved content')])
    })
    expect(result.current.storageStatus).toBe('saved')
    expect(result.current.storageError).toBe('settings')
    await act(async () => {
      await result.current.retrySave()
    })
    expect(result.current.storageError).toBeNull()
  })
  it('flushes a pending streamed update to its previous owner on immediate account switching', async () => {
    const oldHistory = [createUserMessage('Account seven pending update')]
    const newHistory = [createUserMessage('Account eight history')]
    stored.set(8, newHistory)
    const { result } = renderHook(() => usePlaygroundState())
    await waitFor(() => expect(result.current.isLoadingMessages).toBe(false))
    act(() => {
      result.current.updateMessages(oldHistory)
    })
    // No timer advance: changing account must flush the pending 300 ms save.
    act(() => {
      useAuthStore
        .getState()
        .auth.setUser({ id: 8, username: 'second', role: 1 })
    })
    expect(result.current.messages).not.toEqual(oldHistory)
    await waitFor(() => expect(result.current.messages).toEqual(newHistory))
    expect(stored.get(7)).toEqual(oldHistory)
    expect(stored.get(8)).toEqual(newHistory)
  })
  it('flushes pending changes when the actor-keyed page unmounts', async () => {
    const history = [createUserMessage('Last received token')]
    const hook = renderHook(() => usePlaygroundState())
    await waitFor(() =>
      expect(hook.result.current.isLoadingMessages).toBe(false)
    )
    act(() => {
      hook.result.current.updateMessages(history)
    })
    hook.unmount()
    await waitFor(() => expect(stored.get(7)).toEqual(history))
  })
  it('does not accept a draft when durable persistence fails', async () => {
    const history = [createUserMessage('Existing conversation')]
    stored.set(7, history)
    const { result } = renderHook(() => usePlaygroundState())
    await waitFor(() => expect(result.current.messages).toEqual(history))
    vi.mocked(saveMessages).mockRejectedValueOnce(new Error('quota exceeded'))
    await act(async () => {
      await expect(
        result.current.commitMessages([
          ...history,
          createUserMessage('New draft'),
        ])
      ).rejects.toThrow('quota exceeded')
    })
    expect(result.current.messages).toEqual(history)
    expect(stored.get(7)).toEqual(history)
    expect(result.current.storageStatus).toBe('error')
  })
  it('does not mark new streamed tokens saved when an older write finishes', async () => {
    const first = [createUserMessage('First partial answer')]
    const latest = [
      {
        ...first[0],
        versions: [
          {
            ...first[0].versions[0],
            content: 'First partial answer plus final token',
          },
        ],
      },
    ]
    const hook = renderHook(() => usePlaygroundState())
    await waitFor(() =>
      expect(hook.result.current.isLoadingMessages).toBe(false)
    )
    let finishWrite: () => void = () => {
      throw new Error('Write not started')
    }
    vi.mocked(saveMessages).mockImplementationOnce(
      (messages, id) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            stored.set(id ?? -1, structuredClone(messages))
            resolve()
          }
        })
    )
    act(() => {
      hook.result.current.updateMessages(first)
    })
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    act(() => {
      hook.result.current.updateMessages(latest)
    })
    await act(async () => {
      finishWrite()
    })
    expect(hook.result.current.storageStatus).toBe('saving')
    hook.unmount()
    await waitFor(() => expect(stored.get(7)).toEqual(latest))
  })
  it('shows the storage limit without accepting an oversized draft or changing saved history', async () => {
    const history = [createUserMessage('Saved history')]
    stored.set(7, history)
    const { result } = renderHook(() => usePlaygroundState())
    await waitFor(() => expect(result.current.messages).toEqual(history))
    const draft = createUserMessage('x'.repeat(20 * 1024 * 1024))
    await act(async () => {
      await expect(
        result.current.commitMessages([...history, draft])
      ).rejects.toThrow('limit')
    })
    expect(result.current.messages).toEqual(history)
    expect(stored.get(7)).toEqual(history)
    expect(result.current.storageError).toBe('limit')
  })
})
