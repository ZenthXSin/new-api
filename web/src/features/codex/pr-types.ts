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
export interface CodexPullRequestAuthor {
  login: string
  avatarUrl: string
  url: string
}
export interface CodexPullRequestRef {
  ref: string
  sha: string
  repository: string
}
export interface CodexPullRequest {
  number: number
  title: string
  repository: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: CodexPullRequestAuthor
  createdAt: string
  updatedAt: string
  body: string
  head: CodexPullRequestRef | null
  base: CodexPullRequestRef | null
  additions: number
  deletions: number
  changedFiles: number
  commits: number
}
export interface CodexPullRequestComment {
  id: number
  body: string
  author: CodexPullRequestAuthor
  url: string
  createdAt: string
  updatedAt: string
}
export interface CodexPullRequestReviewComment extends CodexPullRequestComment {
  path: string
  line: number | null
  side: string
  diffHunk: string
  commitId: string
}
export interface CodexPullRequestReview {
  id: number
  body: string
  state: string
  author: CodexPullRequestAuthor
  url: string
  submittedAt: string
  commitId: string
}
export interface CodexPullRequestCheck {
  id: number
  name: string
  status: string
  conclusion: string
  url: string
  startedAt: string
  completedAt: string
  summary: string
}
export interface CodexPullRequestFile {
  path: string
  previousPath: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch: string
  patchTruncated: boolean
}
export interface CodexPullRequestDetail {
  pullRequest: CodexPullRequest
  comments: CodexPullRequestComment[]
  reviewComments: CodexPullRequestReviewComment[]
  reviews: CodexPullRequestReview[]
  checks: CodexPullRequestCheck[]
  files: CodexPullRequestFile[]
  diff: string
  diffTruncated: boolean
  truncated: boolean
  warnings: string[]
}
export interface CodexPullRequestPage {
  pullRequests: CodexPullRequest[]
  totalCount: number
  hasMore: boolean
  page: number
}
export interface CodexPullRequestTarget {
  repository: string
  number: number
}
export type CodexPullRequestReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'
export interface CodexPullRequestContext {
  repositoryUrl: string
  repository: string
  number: number
  headSha: string
  headRef: string
  baseSha: string
  baseRef: string
  prompt: string
  warnings: string[]
  truncated: boolean
}
export interface CodexPullRequestTaskInput {
  requestId: string
  instruction: string
  mode: 'ask' | 'review'
  model: string
  group?: string
  effort?: string
  expectedHead: string
  environmentId?: string
}
export interface CodexPullRequestTaskResult {
  workspaceId: string
  conversationId?: string
  turnId?: string
}
