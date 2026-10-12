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
import { detail } from './fixtures'

const clients: QueryClient[] = []

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
})

test('a hidden tab leaves the server task running and catches up immediately when reopened', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get')
  visibility.mockReturnValue('hidden')
  const initial: CodexDetail = {
    ...detail(),
    workspace: { ...detail().workspace, status: 'running' },
    thread: { id: 'background-thread', turns: [] },
  }
  let polls = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (!url.endsWith('/events')) return response(initial)
    polls += 1
    return response({
      events: [
        {
          seq: 1,
          time: 1,
          method: 'turn/completed',
          params: {
            turn: {
              id: 'background-turn',
              status: 'completed',
              items: [
                {
                  id: 'background-answer',
                  type: 'agentMessage',
                  text: 'Finished on the server',
                },
              ],
            },
          },
        },
      ],
      nextCursor: 1,
      workspace: { ...initial.workspace, status: 'idle' },
      pendingApprovals: [],
    })
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  const view = renderHook(() => useCodexThread('project-1', 'actor'), {
    wrapper: (props: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    ),
  })
  await waitFor(() =>
    expect(view.result.current.data?.thread?.id).toBe('background-thread')
  )
  expect(polls).toBe(0)
  expect(view.result.current.data?.workspace.status).toBe('running')
  await act(async () => {
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await waitFor(() =>
    expect(view.result.current.data?.workspace.status).toBe('idle')
  )
  expect(polls).toBe(1)
  expect(view.result.current.data?.thread?.turns[0].items[0].text).toBe(
    'Finished on the server'
  )
  view.unmount()
})

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

test('an open default conversation reloads when deletion in another tab replaces its identity', async () => {
  const old = {
    ...detail(),
    conversationId: 'deleted',
    thread: { id: 'old-thread', turns: [] },
  }
  const replacement = {
    ...detail(),
    conversationId: 'replacement',
    thread: { id: 'new-thread', turns: [] },
  }
  let reads = 0
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    let data = replacement
    if (!url.endsWith('/events') && ++reads === 1) data = old
    return { data: { success: true, data } } as AxiosResponse
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  const view = renderHook(() => useCodexThread('project-1', 'actor'), {
    wrapper: (props: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    ),
  })
  await waitFor(() =>
    expect(view.result.current.data?.thread?.id).toBe('new-thread')
  )
  expect(view.result.current.data?.conversationId).toBe('replacement')
})

test('a detail request started before a cursor reset cannot resurrect the discarded history', async () => {
  const initial = {
    ...detail(),
    conversationId: 'conversation-a',
    nextCursor: 20,
  }
  const recovered = {
    ...detail(),
    conversationId: 'conversation-a',
    nextCursor: 2,
    thread: {
      id: 'thread-1',
      turns: [{ id: 'recovered-turn', status: 'inProgress', items: [] }],
    },
  }
  const staleRead = deferredResponse()
  const resetPage = deferredResponse()
  let reads = 0
  let polls = 0
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url.endsWith('/events')) {
      polls += 1
      if (polls === 1) return resetPage.promise
      return Promise.resolve(
        response({
          events: [
            {
              seq: 3,
              time: 3,
              method: 'item/agentMessage/delta',
              params: {
                turnId: 'recovered-turn',
                itemId: 'answer',
                delta: 'Recovered output',
              },
            },
          ],
          nextCursor: 3,
          conversationId: 'conversation-a',
          workspace: recovered.workspace,
          pendingApprovals: [],
        })
      )
    }
    reads += 1
    if (reads === 2) return staleRead.promise
    return Promise.resolve(response(reads === 1 ? initial : recovered))
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  clients.push(client)
  const view = renderHook(
    () => useCodexThread('project-1', 'actor', 'conversation-a'),
    {
      wrapper: (props: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          {props.children}
        </QueryClientProvider>
      ),
    }
  )
  await waitFor(() => expect(polls).toBe(1))
  let refetch: ReturnType<typeof view.result.current.refetch> | undefined
  await act(async () => {
    refetch = view.result.current.refetch()
  })
  expect(reads).toBe(2)
  await act(async () => {
    resetPage.resolve(
      response({
        events: [],
        nextCursor: 2,
        reset: true,
        conversationId: 'conversation-a',
        workspace: recovered.workspace,
        pendingApprovals: [],
      })
    )
  })
  await waitFor(() =>
    expect(view.result.current.data?.thread?.turns[0].id).toBe('recovered-turn')
  )
  await act(async () => {
    staleRead.resolve(response(initial))
    await refetch
  })
  expect(
    client.getQueryData<CodexDetail>([
      'codex',
      'actor',
      'workspace',
      'project-1',
      'conversation-a',
    ])?.thread?.turns[0].id
  ).toBe('recovered-turn')
  await waitFor(() => expect(view.result.current.isFetching).toBe(false))
  expect(view.result.current.data?.nextCursor).toBe(2)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() =>
    expect(view.result.current.data?.thread?.turns[0].items[0]?.text).toBe(
      'Recovered output'
    )
  )
  expect(view.result.current.data?.nextCursor).toBe(3)
})
