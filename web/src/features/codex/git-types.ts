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
export interface CodexGitFile {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
  status: string
}

export interface CodexGitStatus {
  available: boolean
  branch: string | null
  head: string | null
  statusVersion: string
  dirty: boolean
  detached: boolean
  files: CodexGitFile[]
  diff: string
  truncated?: boolean
  remotes: { name: string; url: string | null }[]
  publishRemotes: { name: string; repository: string; url: string }[]
  upstream: string | null
  ahead: number | null
  behind: number | null
  defaultBranch?: string | null
  commitSupported: boolean
  commitReason: string | null
  pushSupported: boolean
  pushReason: string | null
  pullRequestSupported: boolean
  pullRequestReason: string | null
  githubAuthenticated: boolean
  ghAvailable: boolean
}

export interface CodexGitResult {
  status: CodexGitStatus
  commit?: { sha: string; subject: string }
  push?: { remote: string; branch: string; head: string }
  pullRequest?: { url: string; number: number }
}

export interface CodexCommitInput {
  message: string
  paths?: string[]
  all?: boolean
  expectedStatusVersion: string
  expectedHead: string | null
}

export interface CodexPullRequestInput {
  title: string
  body: string
  base: string
  draft: boolean
  remote: string
  expectedHead: string | null
}
