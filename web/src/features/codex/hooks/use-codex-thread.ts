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
import { useEffect, useState } from 'react'

import { codexApi } from '../api'
import { applyCodexEvents, isCodexBusy } from '../lib/events'
import type { CodexDetail } from '../types'

export function useCodexThread(workspaceId: string | undefined, actor: string) {
  const client = useQueryClient()
  const [connectionError, setConnectionError] = useState<unknown>(null)
  const queryKey = ['codex', actor, 'workspace', workspaceId]
  const detail = useQuery({
    queryKey,
    queryFn: ({ signal }) => codexApi.detail(workspaceId ?? '', signal),
    enabled: !!workspaceId,
    staleTime: 0,
    retry: 1,
  })
  const loaded = !!detail.data
  useEffect(() => {
    if (!workspaceId || !loaded) return
    const key = ['codex', actor, 'workspace', workspaceId]
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    async function poll() {
      const current = client.getQueryData<CodexDetail>(key)
      if (!current || controller.signal.aborted) return
      try {
        const page = await codexApi.events(
          workspaceId ?? '',
          current.nextCursor,
          controller.signal
        )
        if (controller.signal.aborted) return
        if (page.reset) {
          const restored = await codexApi.detail(
            workspaceId ?? '',
            controller.signal
          )
          if (!controller.signal.aborted) client.setQueryData(key, restored)
        } else {
          client.setQueryData<CodexDetail>(key, (previous) =>
            previous ? applyCodexEvents(previous, page) : previous
          )
        }
        failures = 0
        setConnectionError(null)
      } catch (error) {
        if (controller.signal.aborted) return
        failures += 1
        setConnectionError(error)
      }
      if (controller.signal.aborted) return
      const state = client.getQueryData<CodexDetail>(key)
      const delay = isCodexBusy(state?.workspace.status ?? '') ? 1000 : 5000
      timer = setTimeout(
        () => void poll(),
        Math.min(15_000, delay * Math.max(1, failures))
      )
    }
    setConnectionError(null)
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [workspaceId, loaded, actor, client])
  return { ...detail, connectionError }
}
