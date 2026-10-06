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
import { api } from '@/lib/api'

import type {
  CodexApprovalAnswer,
  CodexDetail,
  CodexDiff,
  CodexEnvironment,
  CodexEvents,
  CodexFile,
  CodexFiles,
  CodexStatus,
  CodexTurnInput,
  CodexWorkspace,
} from './types'

type Envelope<T> = { success: boolean; data: T; message?: string }
const config = {
  skipRequestDedup: true,
  skipBusinessError: true,
  skipErrorHandler: true,
}
function unwrap<T>(response: { data: Envelope<T> }): T {
  if (!response.data.success) {
    throw new Error(
      response.data.message || 'The Codex request failed. Please try again.'
    )
  }
  return response.data.data
}
const path = (id: string) => `/api/codex/workspaces/${encodeURIComponent(id)}`
export const codexApi = {
  async environment(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<{ environment: CodexEnvironment }>>(
        '/api/codex/environment',
        { ...config, signal }
      )
    )
  },
  async startEnvironment() {
    return unwrap(
      await api.post<Envelope<{ environment: CodexEnvironment }>>(
        '/api/codex/environment/start',
        {},
        { ...config, timeout: 120_000 }
      )
    )
  },
  async stopEnvironment() {
    return unwrap(
      await api.post<Envelope<{ environment: CodexEnvironment }>>(
        '/api/codex/environment/stop',
        {},
        { ...config, timeout: 120_000 }
      )
    )
  },
  async status(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexStatus>>('/api/codex/status', {
        ...config,
        signal,
      })
    )
  },
  async list(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<{ workspaces: CodexWorkspace[] }>>(
        '/api/codex/workspaces',
        { ...config, signal }
      )
    )
  },
  async create(input: {
    name: string
    repositoryUrl?: string
    branch?: string
  }) {
    return unwrap(
      await api.post<Envelope<{ workspace: CodexWorkspace }>>(
        '/api/codex/workspaces',
        input,
        { ...config, timeout: 120_000 }
      )
    )
  },
  async detail(id: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexDetail>>(path(id), { ...config, signal })
    )
  },
  async events(id: string, after: number, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexEvents>>(`${path(id)}/events`, {
        ...config,
        params: { after },
        signal,
      })
    )
  },
  async update(id: string, input: { name?: string; archived?: boolean }) {
    return unwrap(
      await api.patch<Envelope<{ workspace: CodexWorkspace }>>(
        path(id),
        input,
        config
      )
    )
  },
  async remove(id: string) {
    return unwrap(await api.delete<Envelope<unknown>>(path(id), config))
  },
  async turn(id: string, input: CodexTurnInput) {
    return unwrap(
      await api.post<
        Envelope<{ workspace: CodexWorkspace; turnId: string | null }>
      >(`${path(id)}/turns`, input, { ...config, timeout: 120_000 })
    )
  },
  async interrupt(id: string) {
    return unwrap(
      await api.post<Envelope<{ workspace: CodexWorkspace }>>(
        `${path(id)}/interrupt`,
        {},
        config
      )
    )
  },
  async approve(id: string, requestId: string, answer: CodexApprovalAnswer) {
    return unwrap(
      await api.post<Envelope<unknown>>(
        `${path(id)}/approvals/${encodeURIComponent(requestId)}`,
        answer,
        config
      )
    )
  },
  async files(id: string, directory: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexFiles>>(`${path(id)}/files`, {
        ...config,
        params: { path: directory },
        signal,
      })
    )
  },
  async file(id: string, filePath: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexFile>>(`${path(id)}/file`, {
        ...config,
        params: { path: filePath },
        signal,
      })
    )
  },
  async save(
    id: string,
    input: { path: string; content: string; expectedHash: string | null }
  ) {
    return unwrap(
      await api.put<Envelope<CodexFile>>(`${path(id)}/file`, input, config)
    )
  },
  async diff(id: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexDiff>>(`${path(id)}/diff`, {
        ...config,
        signal,
      })
    )
  },
  async import(id: string, file: File) {
    const data = new FormData()
    data.append('file', file)
    return unwrap(
      await api.post<Envelope<unknown>>(`${path(id)}/import`, data, {
        ...config,
        timeout: 120_000,
      })
    )
  },
  async export(id: string) {
    return (
      await api.get<Blob>(`${path(id)}/export`, {
        ...config,
        responseType: 'blob',
        timeout: 120_000,
      })
    ).data
  },
}

export function codexError(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = error.response as {
      data?: { message?: unknown; error?: unknown }
    }
    if (typeof response?.data?.message === 'string') {
      return response.data.message
    }
  }
  return error instanceof Error
    ? error.message
    : 'The Codex request failed. Please try again.'
}
export function downloadCodexFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
