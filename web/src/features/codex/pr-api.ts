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
  CodexPullRequestComment, CodexPullRequestContext, CodexPullRequestDetail,
  CodexPullRequestPage, CodexPullRequestReview, CodexPullRequestReviewEvent,
  CodexPullRequestTarget, CodexPullRequestTaskInput, CodexPullRequestTaskResult,
} from './pr-types'

type Envelope<T> = { success: boolean; data: T; message?: string }
const config = { skipRequestDedup: true, skipBusinessError: true, skipErrorHandler: true }
function unwrap<T>(response: { data: Envelope<T> }): T {
  if (!response.data.success) throw new Error(response.data.message || 'The pull request operation failed. Please try again.')
  return response.data.data
}
function pullRequestPath(target: CodexPullRequestTarget): string {
  const [owner, repository] = target.repository.split('/')
  return `/api/codex/github/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${target.number}`
}
export function pullRequestExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href
  } catch { /* Invalid provider links are displayed as text. */ }
  return undefined
}
export const codexPullRequestApi = {
  async list(input: { repository?: string; search?: string; state: 'open' | 'closed' | 'all'; page: number }, signal?: AbortSignal): Promise<CodexPullRequestPage> {
    return unwrap(await api.get<Envelope<CodexPullRequestPage>>('/api/codex/github/pulls', { ...config, signal, params: { ...input, limit: 30 } }))
  },
  async detail(target: CodexPullRequestTarget, signal?: AbortSignal): Promise<CodexPullRequestDetail> {
    return unwrap(await api.get<Envelope<CodexPullRequestDetail>>(pullRequestPath(target), { ...config, signal }))
  },
  async context(target: CodexPullRequestTarget, instruction: string, signal?: AbortSignal): Promise<CodexPullRequestContext> {
    return unwrap(await api.get<Envelope<CodexPullRequestContext>>(`${pullRequestPath(target)}/context`, { ...config, signal, params: { instruction } }))
  },
  async comment(target: CodexPullRequestTarget, body: string): Promise<{ comment: CodexPullRequestComment }> {
    return unwrap(await api.post<Envelope<{ comment: CodexPullRequestComment }>>(`${pullRequestPath(target)}/comments`, { body, confirmed: true }, config))
  },
  async review(target: CodexPullRequestTarget, input: { body: string; event: CodexPullRequestReviewEvent; commitId: string }): Promise<{ review: CodexPullRequestReview }> {
    return unwrap(await api.post<Envelope<{ review: CodexPullRequestReview }>>(`${pullRequestPath(target)}/reviews`, { ...input, confirmed: true }, config))
  },
  async task(target: CodexPullRequestTarget, input: CodexPullRequestTaskInput): Promise<CodexPullRequestTaskResult> {
    return unwrap(await api.post<Envelope<CodexPullRequestTaskResult>>(`${pullRequestPath(target)}/task`, input, { ...config, timeout: 120_000 }))
  },
}
