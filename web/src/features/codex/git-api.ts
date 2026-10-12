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
  CodexCommitInput,
  CodexGitResult,
  CodexGitStatus,
  CodexPullRequestInput,
} from './git-types'

type Envelope<T> = { success: boolean; data: T; message?: string }
const config = {
  skipRequestDedup: true,
  skipBusinessError: true,
  skipErrorHandler: true,
}
const path = (id: string) =>
  `/api/codex/workspaces/${encodeURIComponent(id)}/git`

function unwrap<T>(response: { data: Envelope<T> }): T {
  if (!response.data.success) {
    throw new Error(
      response.data.message ||
        'The Git operation failed. Refresh changes and try again.'
    )
  }
  return response.data.data
}

export const codexGitApi = {
  async status(id: string, signal?: AbortSignal): Promise<CodexGitStatus> {
    return unwrap(
      await api.get<Envelope<CodexGitStatus>>(`${path(id)}/status`, {
        ...config,
        signal,
      })
    )
  },
  async commit(id: string, input: CodexCommitInput): Promise<CodexGitResult> {
    return unwrap(
      await api.post<Envelope<CodexGitResult>>(`${path(id)}/commit`, input, {
        ...config,
        timeout: 120_000,
      })
    )
  },
  async push(
    id: string,
    input: { remote: string; expectedHead: string | null }
  ): Promise<CodexGitResult> {
    return unwrap(
      await api.post<Envelope<CodexGitResult>>(`${path(id)}/push`, input, {
        ...config,
        timeout: 120_000,
      })
    )
  },
  async pullRequest(
    id: string,
    input: CodexPullRequestInput
  ): Promise<CodexGitResult> {
    return unwrap(
      await api.post<Envelope<CodexGitResult>>(
        `${path(id)}/pull-request`,
        input,
        { ...config, timeout: 120_000 }
      )
    )
  },
}
