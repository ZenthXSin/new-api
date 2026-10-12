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
  CodexPublicPorts,
  CodexPublicPort,
  CodexTaskPage,
  CodexRepository,
  CodexSearchResult,
  CodexApprovalAnswer,
  CodexCatalog,
  CodexCreateInput,
  CodexGitHubStatus,
  CodexGitHubRepository,
  CodexSshConnection,
  CodexSshConnectionInput,
  CodexSshProbe,
  CodexSshTest,
  CodexDetail,
  CodexDiff,
  CodexEnvironment,
  CodexEvents,
  CodexFile,
  CodexFiles,
  CodexStatus,
  CodexTurnInput,
  CodexWorkspace,
  CodexProjectConversation,
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
  async ports(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexPublicPorts>>(
        '/api/codex/environment/ports',
        { ...config, signal }
      )
    )
  },
  async openPort(input: { localPort: number; label?: string }) {
    return unwrap(
      await api.post<
        Envelope<{ port: CodexPublicPort; limit: number; used: number }>
      >('/api/codex/environment/ports', input, config)
    )
  },
  async closePort(id: string) {
    return unwrap(
      await api.delete<
        Envelope<{ closed: boolean; id: string; limit: number; used: number }>
      >(`/api/codex/environment/ports/${encodeURIComponent(id)}`, config)
    )
  },
  async tasks(offset = 0, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexTaskPage>>('/api/codex/tasks', {
        ...config,
        signal,
        params: { offset, limit: 100 },
      })
    )
  },
  async repository(id: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<{ repository: CodexRepository }>>(
        `${path(id)}/repository`,
        {
          ...config,
          signal,
        }
      )
    )
  },
  async checkoutBranch(id: string, input: { branch: string; remote?: string }) {
    return unwrap(
      await api.post<
        Envelope<{ repository: CodexRepository; workspace: CodexWorkspace }>
      >(`${path(id)}/repository/checkout`, input, config)
    )
  },
  async search(query: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<
        Envelope<{
          query: string
          results: CodexSearchResult[]
          hasMore: boolean
        }>
      >('/api/codex/search', {
        ...config,
        signal,
        params: { query, limit: 40 },
      })
    )
  },
  async catalog(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexCatalog>>('/api/codex/catalog', {
        ...config,
        signal,
      })
    )
  },
  async githubStatus(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CodexGitHubStatus>>('/api/codex/github', {
        ...config,
        signal,
      })
    )
  },
  async githubAuthorize() {
    return unwrap(
      await api.post<Envelope<{ url: string }>>(
        '/api/codex/github/authorize',
        {},
        config
      )
    )
  },
  async githubCallback(input: { code: string; state: string }) {
    return unwrap(
      await api.post<Envelope<CodexGitHubStatus>>(
        '/api/codex/github/callback',
        input,
        config
      )
    )
  },
  async githubDisconnect() {
    return unwrap(
      await api.delete<Envelope<unknown>>('/api/codex/github', config)
    )
  },
  async githubRepositories(page: number, signal?: AbortSignal) {
    return unwrap(
      await api.get<
        Envelope<{ repositories: CodexGitHubRepository[]; hasMore: boolean }>
      >('/api/codex/github/repositories', {
        ...config,
        signal,
        params: { page, limit: 50 },
      })
    )
  },
  async sshConnections(signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<{ connections: CodexSshConnection[] }>>(
        '/api/codex/ssh/connections',
        { ...config, signal }
      )
    )
  },
  async sshProbe(input: { host: string; port: number }) {
    return unwrap(
      await api.post<Envelope<CodexSshProbe>>('/api/codex/ssh/probe', input, {
        ...config,
        timeout: 30_000,
      })
    )
  },
  async sshCreate(input: CodexSshConnectionInput) {
    return unwrap(
      await api.post<Envelope<{ connection: CodexSshConnection }>>(
        '/api/codex/ssh/connections',
        input,
        { ...config, timeout: 120_000 }
      )
    )
  },
  async sshRemove(id: string) {
    return unwrap(
      await api.delete<Envelope<unknown>>(
        `/api/codex/ssh/connections/${encodeURIComponent(id)}`,
        config
      )
    )
  },
  async sshTest(id: string) {
    return unwrap(
      await api.post<Envelope<CodexSshTest>>(
        `/api/codex/ssh/connections/${encodeURIComponent(id)}/test`,
        {},
        { ...config, timeout: 120_000 }
      )
    )
  },
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
  async create(input: CodexCreateInput) {
    return unwrap(
      await api.post<Envelope<{ workspace: CodexWorkspace }>>(
        '/api/codex/workspaces',
        input,
        { ...config, timeout: 120_000 }
      )
    )
  },
  async createConversation(id: string) {
    return unwrap(
      await api.post<Envelope<CodexDetail>>(
        `${path(id)}/conversations`,
        {},
        config
      )
    )
  },
  async conversations(id: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<{ conversations: CodexProjectConversation[] }>>(
        `${path(id)}/conversations`,
        { ...config, signal }
      )
    )
  },
  async updateConversation(
    id: string,
    conversation: string,
    input: { name?: string; archived?: boolean }
  ) {
    return unwrap(
      await api.patch<Envelope<CodexDetail>>(
        `${path(id)}/conversations/${encodeURIComponent(conversation)}`,
        input,
        config
      )
    )
  },
  async deleteConversation(id: string, conversation: string) {
    return unwrap(
      await api.delete<
        Envelope<{
          deleted: boolean
          conversationId: string
          workspace: CodexWorkspace
          conversations: CodexProjectConversation[]
        }>
      >(`${path(id)}/conversations/${encodeURIComponent(conversation)}`, config)
    )
  },
  async renameConversation(id: string, conversation: string, name: string) {
    return unwrap(
      await api.patch<Envelope<CodexDetail>>(
        `${path(id)}/conversations/${encodeURIComponent(conversation)}`,
        { name },
        config
      )
    )
  },
  async detail(id: string, signal?: AbortSignal, conversation?: string) {
    return unwrap(
      await api.get<Envelope<CodexDetail>>(path(id), {
        ...config,
        signal,
        params: { conversation },
      })
    )
  },
  async events(
    id: string,
    after: number,
    signal?: AbortSignal,
    conversation?: string
  ) {
    return unwrap(
      await api.get<Envelope<CodexEvents>>(`${path(id)}/events`, {
        ...config,
        params: { after, conversation },
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
  async turn(id: string, input: CodexTurnInput, conversation?: string) {
    return unwrap(
      await api.post<
        Envelope<{ workspace: CodexWorkspace; turnId: string | null }>
      >(`${path(id)}/turns`, input, {
        ...config,
        timeout: 120_000,
        params: { conversation },
      })
    )
  },
  async deleteMessage(
    id: string,
    turnId: string,
    role: 'user' | 'assistant',
    conversation?: string
  ) {
    return unwrap(
      await api.delete<Envelope<CodexDetail>>(
        `${path(id)}/turns/${encodeURIComponent(turnId)}/messages/${role}`,
        { ...config, params: { conversation } }
      )
    )
  },
  async interrupt(id: string, conversation?: string) {
    return unwrap(
      await api.post<Envelope<{ workspace: CodexWorkspace }>>(
        `${path(id)}/interrupt`,
        {},
        { ...config, params: { conversation } }
      )
    )
  },
  async cancelQueued(id: string, requestId: string, conversation?: string) {
    return unwrap(
      await api.delete<Envelope<unknown>>(
        `${path(id)}/queue/${encodeURIComponent(requestId)}`,
        { ...config, params: { conversation } }
      )
    )
  },
  async approve(
    id: string,
    requestId: string,
    answer: CodexApprovalAnswer,
    conversation?: string
  ) {
    return unwrap(
      await api.post<Envelope<unknown>>(
        `${path(id)}/approvals/${encodeURIComponent(requestId)}`,
        answer,
        { ...config, params: { conversation } }
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
  async download(id: string, filePath: string) {
    try {
      return (
        await api.get<Blob>(`${path(id)}/download`, {
          ...config,
          params: { path: filePath },
          responseType: 'blob',
          timeout: 310_000,
        })
      ).data
    } catch (error) {
      // Axios also decodes JSON failures as blobs for a binary request.
      if (error && typeof error === 'object' && 'response' in error) {
        const response = error.response as { data?: unknown }
        if (response.data instanceof Blob) {
          try {
            const failure: unknown = JSON.parse(await response.data.text())
            response.data = failure
          } catch {
            /* Retain the original transport error. */
          }
        }
      }
      throw error
    }
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
  async upload(id: string, filePath: string, file: File) {
    return unwrap(
      await api.post<Envelope<{ path: string; size: number }>>(
        `${path(id)}/upload`,
        file,
        {
          ...config,
          params: { path: filePath },
          headers: { 'Content-Type': 'application/octet-stream' },
          timeout: 120_000,
        }
      )
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
