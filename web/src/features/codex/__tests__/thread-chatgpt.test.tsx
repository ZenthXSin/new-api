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
import type { AxiosResponse } from 'axios'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { useCodexThread } from '../hooks/use-codex-thread'
import type { CodexDetail, CodexEvents } from '../types'
import { detail, workspace } from './fixtures'

const clients: QueryClient[] = []

function setup(initial?: CodexDetail) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  clients.push(client)
  const key = ['codex', 'actor-a', 'workspace', 'project-1', 'conversation-a']
  if (initial) client.setQueryData(key, initial)
  const view = renderHook(
    (props: { actor: string; conversation: string }) =>
      useCodexThread('project-1', props.actor, props.conversation),
    {
      initialProps: { actor: 'actor-a', conversation: 'conversation-a' },
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    }
  )
  return { client, key, ...view }
}

function response(data: CodexDetail | CodexEvents): AxiosResponse {
  return { data: { success: true, data } } as AxiosResponse
}

function deferredResponse() {
  let resolve!: (value: AxiosResponse) => void
  const promise = new Promise<AxiosResponse>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('an older detail refetch cannot erase output already received from the event stream', async () => {
  const snapshot = { ...detail(), conversationId: 'conversation-a' }
  const read = deferredResponse()
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (!url.endsWith('/events')) return read.promise
    return Promise.resolve(
      response({
        events: [
          {
            seq: 1,
            time: 1,
            method: 'item/agentMessage/delta',
            params: {
              turnId: 'turn-1',
              itemId: 'answer',
              delta: 'Live answer',
            },
          },
        ],
        nextCursor: 1,
        conversationId: 'conversation-a',
        workspace,
        pendingApprovals: [],
      })
    )
  })
  const view = setup(snapshot)
  await waitFor(() =>
    expect(view.result.current.data?.thread?.turns[0].items[0]?.text).toBe(
      'Live answer'
    )
  )
  await act(async () => {
    read.resolve(response(snapshot))
    await read.promise
  })
  await waitFor(() => expect(view.result.current.isFetching).toBe(false))
  expect(view.result.current.data?.thread?.turns[0].items[0]?.text).toBe(
    'Live answer'
  )
  expect(view.result.current.data?.nextCursor).toBe(1)
})

test('returning online retries immediately and clears the disconnected state', async () => {
  const snapshot = { ...detail(), conversationId: 'conversation-a' }
  let online = false
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (!url.endsWith('/events')) return response(snapshot)
    if (!online) throw new Error('Network disconnected')
    return response({
      events: [
        {
          seq: 1,
          time: 1,
          method: 'item/agentMessage/delta',
          params: { turnId: 'turn-1', itemId: 'answer', delta: 'Recovered' },
        },
      ],
      nextCursor: 1,
      conversationId: 'conversation-a',
      workspace,
      pendingApprovals: [],
    })
  })
  const view = setup()
  await waitFor(() =>
    expect(view.result.current.connectionError).toBeInstanceOf(Error)
  )
  await act(async () => {
    online = true
    window.dispatchEvent(new Event('online'))
  })
  await waitFor(() =>
    expect(view.result.current.data?.thread?.turns[0].items[0]?.text).toBe(
      'Recovered'
    )
  )
  expect(view.result.current.connectionError).toBeNull()
})

test('switching accounts aborts polling and ignores a late response from the previous account', async () => {
  const oldPage = deferredResponse()
  let oldSignal: AbortSignal | undefined
  vi.spyOn(api, 'get').mockImplementation((url, config) => {
    if (!url.endsWith('/events')) {
      return Promise.resolve(
        response({ ...detail(), conversationId: config?.params?.conversation })
      )
    }
    if (config?.params?.conversation === 'conversation-a') {
      oldSignal = config.signal as AbortSignal
      return oldPage.promise
    }
    return Promise.resolve(
      response({
        events: [],
        nextCursor: 0,
        conversationId: 'conversation-b',
        workspace,
        pendingApprovals: [],
      })
    )
  })
  const view = setup()
  await waitFor(() => expect(oldSignal).toBeDefined())
  view.rerender({ actor: 'actor-b', conversation: 'conversation-b' })
  await waitFor(() =>
    expect(view.result.current.data?.conversationId).toBe('conversation-b')
  )
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => {
    oldPage.resolve(
      response({
        events: [
          {
            seq: 1,
            time: 1,
            method: 'item/agentMessage/delta',
            params: {
              turnId: 'turn-1',
              itemId: 'answer',
              delta: 'Private old account',
            },
          },
        ],
        nextCursor: 1,
        conversationId: 'conversation-a',
        workspace,
        pendingApprovals: [],
      })
    )
    await oldPage.promise
  })
  expect(view.result.current.data?.thread?.turns[0].items).toEqual([])
  expect(
    view.client.getQueryData<CodexDetail>(view.key)?.thread?.turns[0].items
  ).toEqual([])
})

test('a late event response at the same cursor cannot resurrect an approval removed by a detail refresh', async () => {
  const stalePage = deferredResponse()
  const refreshed = {
    ...detail(),
    conversationId: 'conversation-a',
    nextCursor: 1,
  }
  let reads = 0
  let polls = 0
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (!url.endsWith('/events')) {
      reads += 1
      return Promise.resolve(response(refreshed))
    }
    polls += 1
    if (polls === 1) return stalePage.promise
    return Promise.resolve(
      response({
        events: [],
        nextCursor: 1,
        conversationId: 'conversation-a',
        workspace,
        pendingApprovals: [],
      })
    )
  })
  const view = setup()
  await waitFor(() => expect(polls).toBe(1))
  await act(async () => {
    await view.result.current.refetch()
  })
  expect(reads).toBe(2)
  await act(async () => {
    stalePage.resolve(
      response({
        events: [],
        nextCursor: 1,
        conversationId: 'conversation-a',
        workspace: { ...workspace, status: 'waiting_approval' },
        pendingApprovals: [
          {
            id: 'resolved',
            method: 'item/commandExecution/requestApproval',
            params: {},
          },
        ],
      })
    )
    await stalePage.promise
  })
  expect(
    view.client.getQueryData<CodexDetail>(view.key)?.pendingApprovals
  ).toEqual([])
})

test('reset recovery does not overwrite a newer detail response that finishes while recovery is in flight', async () => {
  const resetRead = deferredResponse()
  const initial = {
    ...detail(),
    conversationId: 'conversation-a',
    nextCursor: 1,
  }
  const refreshed = {
    ...initial,
    workspace: { ...workspace, name: 'Fresh project name' },
  }
  let reads = 0
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url.endsWith('/events')) {
      return Promise.resolve(
        response({
          events: [],
          nextCursor: 1,
          reset: true,
          conversationId: 'conversation-a',
          workspace,
          pendingApprovals: [],
        })
      )
    }
    reads += 1
    if (reads === 2) return resetRead.promise
    return Promise.resolve(response(reads === 1 ? initial : refreshed))
  })
  const view = setup()
  await waitFor(() => expect(reads).toBe(2))
  await act(async () => {
    await view.result.current.refetch()
  })
  await waitFor(() =>
    expect(view.result.current.data?.workspace.name).toBe('Fresh project name')
  )
  await act(async () => {
    resetRead.resolve(response(initial))
    await resetRead.promise
  })
  expect(view.client.getQueryData<CodexDetail>(view.key)?.workspace.name).toBe(
    'Fresh project name'
  )
})

test('unmounting aborts an in-flight event request and prevents its output from changing the cache', async () => {
  const pending = deferredResponse()
  let signal: AbortSignal | undefined
  vi.spyOn(api, 'get').mockImplementation((url, config) => {
    if (!url.endsWith('/events')) {
      return Promise.resolve(
        response({ ...detail(), conversationId: 'conversation-a' })
      )
    }
    signal = config?.signal as AbortSignal
    return pending.promise
  })
  const view = setup()
  await waitFor(() => expect(signal).toBeDefined())
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    pending.resolve(
      response({
        events: [
          {
            seq: 1,
            time: 1,
            method: 'item/agentMessage/delta',
            params: {
              turnId: 'turn-1',
              itemId: 'answer',
              delta: 'Late output',
            },
          },
        ],
        nextCursor: 1,
        conversationId: 'conversation-a',
        workspace,
        pendingApprovals: [],
      })
    )
    await pending.promise
  })
  expect(view.client.getQueryData<CodexDetail>(view.key)?.nextCursor).toBe(0)
})

test('a stalled event request times out and the next poll recovers new output', async () => {
  const snapshot = { ...detail(), conversationId: 'conversation-a' }
  let polls = 0
  let stalledSignal: AbortSignal | undefined
  vi.spyOn(api, 'get').mockImplementation((url, config) => {
    if (!url.endsWith('/events')) return Promise.resolve(response(snapshot))
    polls += 1
    if (polls === 1) {
      stalledSignal = config?.signal as AbortSignal
      return new Promise<AxiosResponse>((_resolve, reject) => {
        stalledSignal?.addEventListener(
          'abort',
          () => reject(new Error('Request aborted')),
          { once: true }
        )
      })
    }
    return Promise.resolve(
      response({
        events: [
          {
            seq: 1,
            time: 1,
            method: 'item/agentMessage/delta',
            params: {
              turnId: 'turn-1',
              itemId: 'answer',
              delta: 'Recovered after timeout',
            },
          },
        ],
        nextCursor: 1,
        conversationId: 'conversation-a',
        workspace,
        pendingApprovals: [],
      })
    )
  })
  vi.useFakeTimers()
  const view = setup(snapshot)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(stalledSignal).toBeDefined()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(stalledSignal?.aborted).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })
  expect(
    view.client.getQueryData<CodexDetail>(view.key)?.thread?.turns[0].items[0]
      ?.text
  ).toBe('Recovered after timeout')
})

test('going offline aborts an open event request and waits for online before resuming', async () => {
  const snapshot = { ...detail(), conversationId: 'conversation-a' }
  const network = vi
    .spyOn(window.navigator, 'onLine', 'get')
    .mockReturnValue(true)
  let polls = 0
  let signal: AbortSignal | undefined
  vi.spyOn(api, 'get').mockImplementation((url, config) => {
    if (!url.endsWith('/events')) return Promise.resolve(response(snapshot))
    polls += 1
    if (polls === 1) {
      signal = config?.signal as AbortSignal
      return new Promise<AxiosResponse>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new Error('Network disconnected')),
          { once: true }
        )
      })
    }
    return Promise.resolve(
      response({
        events: [],
        nextCursor: 0,
        conversationId: 'conversation-a',
        workspace,
        pendingApprovals: [],
      })
    )
  })
  const view = setup()
  await waitFor(() => expect(signal).toBeDefined())
  await act(async () => {
    network.mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
  })
  expect(signal?.aborted).toBe(true)
  expect(view.result.current.connectionError).toBeInstanceOf(Error)
  expect(polls).toBe(1)
  await act(async () => {
    network.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
  })
  await waitFor(() => expect(view.result.current.connectionError).toBeNull())
  expect(polls).toBe(2)
})

test('a server cursor reset restores its authoritative lower cursor instead of staying stuck on old history', async () => {
  const initial = {
    ...detail(),
    conversationId: 'conversation-a',
    nextCursor: 20,
  }
  const restored = {
    ...detail(),
    conversationId: 'conversation-a',
    nextCursor: 2,
    thread: { id: 'restored-thread', turns: [] },
  }
  let reads = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (!url.endsWith('/events')) {
      return response(++reads === 1 ? initial : restored)
    }
    return response({
      events: [],
      nextCursor: 2,
      reset: true,
      conversationId: 'conversation-a',
      workspace,
      pendingApprovals: [],
    })
  })
  const view = setup()
  await waitFor(() =>
    expect(view.result.current.data?.thread?.id).toBe('restored-thread')
  )
  expect(view.result.current.data?.nextCursor).toBe(2)
})
