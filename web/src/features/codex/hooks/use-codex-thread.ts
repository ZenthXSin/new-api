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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { codexApi } from '../api'
import {
  applyCodexEvents,
  isCodexBusy,
  restoreCodexDetail,
} from '../lib/events'
import type { CodexDetail } from '../types'

function isTabHidden() {
  return document.visibilityState === 'hidden'
}

async function readCodexWithTimeout<T>(
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error('The Codex request failed. Please try again.')
      ),
    30_000
  )
  try {
    const result = await read(controller.signal)
    if (controller.signal.aborted) throw controller.signal.reason
    return result
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export function useCodexThread(
  workspaceId: string | undefined,
  actor: string,
  conversationId?: string
) {
  const client = useQueryClient()
  const identity = JSON.stringify([
    actor,
    workspaceId,
    conversationId || 'default',
  ])
  const recoveryVersions = useRef(new Map<string, number>())
  const [connection, setConnection] = useState<{
    identity: string
    error: unknown
  } | null>(null)
  const queryKey = [
    'codex',
    actor,
    'workspace',
    workspaceId,
    conversationId || 'default',
  ]
  const detail = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const started = client.getQueryState<CodexDetail>(queryKey)
      const recoveryVersion = recoveryVersions.current.get(identity)
      const restored = restoreCodexDetail(
        await readCodexWithTimeout(signal, (requestSignal) =>
          codexApi.detail(workspaceId ?? '', requestSignal, conversationId)
        )
      )
      const latest = client.getQueryData<CodexDetail>(queryKey)
      // Refetches can overlap the event stream. A slower snapshot must not
      // discard output which has already advanced this conversation's cursor.
      if (latest) {
        // A recovered cursor belongs to a new history generation. A snapshot
        // requested before recovery can have a larger, now-obsolete cursor.
        if (recoveryVersion !== recoveryVersions.current.get(identity)) {
          return latest
        }
        const changed =
          started?.dataUpdateCount !==
          client.getQueryState(queryKey)?.dataUpdateCount
        if (
          changed &&
          latest.conversationId !== started?.data?.conversationId
        ) {
          return latest
        }
        if (
          latest.conversationId === restored.conversationId &&
          (latest.nextCursor > restored.nextCursor ||
            (changed && latest.nextCursor === restored.nextCursor))
        ) {
          return latest
        }
      }
      return restored
    },
    enabled: !!workspaceId,
    staleTime: 0,
    retry: 1,
  })
  const loaded = !!detail.data
  useEffect(() => {
    if (!workspaceId || !loaded) return
    const key = [
      'codex',
      actor,
      'workspace',
      workspaceId,
      conversationId || 'default',
    ]
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let inFlight = false
    let retryImmediately = false
    let activeRequest: AbortController | undefined
    async function poll() {
      const started = client.getQueryState<CodexDetail>(key)
      const current = started?.data
      if (!current || controller.signal.aborted || inFlight || isTabHidden()) {
        return
      }
      if (!window.navigator.onLine) {
        setConnection({ identity, error: new Error('Network disconnected') })
        return
      }
      inFlight = true
      activeRequest = new AbortController()
      const requestSignal = activeRequest.signal
      retryImmediately = false
      try {
        const page = await readCodexWithTimeout(requestSignal, (signal) =>
          codexApi.events(
            workspaceId ?? '',
            current.nextCursor,
            signal,
            conversationId
          )
        )
        if (controller.signal.aborted) return
        const latest = client.getQueryData<CodexDetail>(key)
        // Another request may have replaced the default conversation while
        // this request was in flight. Never restore its former identity.
        if (
          !latest ||
          latest.conversationId !== current.conversationId ||
          (started?.dataUpdateCount !==
            client.getQueryState(key)?.dataUpdateCount &&
            page.nextCursor <= latest.nextCursor)
        ) {
          retryImmediately = true
        } else if (
          page.reset ||
          (page.conversationId &&
            page.conversationId !== current.conversationId)
        ) {
          const restoringVersion = client.getQueryState(key)?.dataUpdateCount
          const restored = restoreCodexDetail(
            await readCodexWithTimeout(requestSignal, (signal) =>
              codexApi.detail(workspaceId ?? '', signal, conversationId)
            )
          )
          if (controller.signal.aborted) return
          client.setQueryData<CodexDetail>(key, (previous) => {
            if (
              !previous ||
              previous.conversationId !== latest.conversationId ||
              restoringVersion !== client.getQueryState(key)?.dataUpdateCount
            ) {
              return previous
            }
            if (
              previous.nextCursor > latest.nextCursor &&
              previous.conversationId === restored.conversationId
            ) {
              return previous
            }
            recoveryVersions.current.set(
              identity,
              (recoveryVersions.current.get(identity) ?? 0) + 1
            )
            return restored
          })
        } else {
          client.setQueryData<CodexDetail>(key, (previous) =>
            previous ? applyCodexEvents(previous, page) : previous
          )
        }
        failures = 0
        setConnection(null)
      } catch (error) {
        if (controller.signal.aborted) return
        failures += 1
        setConnection({ identity, error })
      } finally {
        inFlight = false
        activeRequest = undefined
      }
      if (
        controller.signal.aborted ||
        !window.navigator.onLine ||
        isTabHidden()
      ) {
        return
      }
      const state = client.getQueryData<CodexDetail>(key)
      const delay = isCodexBusy(state?.workspace.status ?? '') ? 1000 : 5000
      timer = setTimeout(
        () => void poll(),
        retryImmediately ? 0 : Math.min(15_000, delay * Math.max(1, failures))
      )
    }
    function reconnect() {
      if (controller.signal.aborted) return
      clearTimeout(timer)
      failures = 0
      if (inFlight) {
        retryImmediately = true
        return
      }
      void poll()
    }
    function disconnect() {
      clearTimeout(timer)
      const error = new Error('Network disconnected')
      activeRequest?.abort(error)
      setConnection({ identity, error })
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') reconnect()
      else clearTimeout(timer)
    }
    setConnection(null)
    window.addEventListener('offline', disconnect)
    window.addEventListener('online', reconnect)
    window.addEventListener('focus', reconnect)
    document.addEventListener('visibilitychange', onVisibilityChange)
    void poll()
    return () => {
      controller.abort()
      activeRequest?.abort()
      clearTimeout(timer)
      window.removeEventListener('offline', disconnect)
      window.removeEventListener('online', reconnect)
      window.removeEventListener('focus', reconnect)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [workspaceId, conversationId, loaded, actor, client, identity])
  return {
    ...detail,
    connectionError:
      connection?.identity === identity ? connection.error : null,
  }
}
