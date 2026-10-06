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
export type CodexMode = 'code' | 'ask'
export interface CodexEnvironment {
  status: 'not_created' | 'stopped' | 'starting' | 'running' | 'error'
  mode: CodexMode
  activeWorkspaceId: string | null
  activeWorkspaceName: string | null
  projectCount: number
  idleSeconds: number
  limits: {
    cpus: number
    memoryBytes: number
    diskBytes: number
  }
  lastError?: string
}
export type CodexWorkspaceStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'interrupted'
  | 'error'
export interface CodexModel {
  id: string
  name?: string
  efforts?: string[]
  defaultEffort?: string
}
export interface CodexStatus {
  available: boolean
  configured: boolean
  reason?: string
  version: string
  defaultModel: string
  defaultEffort: string
  models: CodexModel[]
  efforts: string[]
  limits: {
    maxActive: number
    maxWorkspaces: number
    uploadBytes: number
    fileBytes: number
  }
  capabilities: {
    gitImport: boolean
    zipImport: boolean
    files: boolean
    diff: boolean
    approvals: boolean
  }
}
export interface CodexWorkspace {
  id: string
  name: string
  ownerId?: number
  status: CodexWorkspaceStatus
  model: string
  effort: string
  mode: CodexMode
  createdAt: string | number
  updatedAt: string | number
  threadId?: string | null
  activeTurnId?: string | null
  lastError?: string
  archived: boolean
}
export interface CodexItem {
  id: string
  type: string
  text?: string
  content?: { type: string; text?: string; url?: string; path?: string }[]
  summary?: string[]
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string
  exitCode?: number | null
  changes?: { path: string; kind?: { type?: string } | string; diff?: string }[]
  [key: string]: unknown
}
export interface CodexTurn {
  plan?: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]
  planExplanation?: string | null
  diff?: string
  id: string
  status: string
  items: CodexItem[]
  error?: { message?: string } | null
}
export interface CodexThread {
  id: string
  turns: CodexTurn[]
}
export interface CodexApproval {
  id: string
  method: string
  params: Record<string, unknown>
  createdAt?: string | number
}
export interface CodexDetail {
  persistenceError?: boolean
  workspace: CodexWorkspace
  thread: CodexThread | null
  pendingApprovals: CodexApproval[]
  nextCursor: number
  events: CodexEvent[]
}
export interface CodexEvent {
  seq: number
  method: string
  params: Record<string, unknown>
  time: number
}
export interface CodexEvents {
  persistenceError?: boolean
  events: CodexEvent[]
  nextCursor: number
  workspace: CodexWorkspace
  pendingApprovals: CodexApproval[]
  reset?: boolean
}
export interface CodexTurnInput {
  prompt: string
  requestId: string
  model: string
  effort: string
  mode: CodexMode
}
export interface CodexFileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
}
export interface CodexFiles {
  path: string
  entries: CodexFileEntry[]
}
export interface CodexFile {
  path: string
  content: string
  hash: string
  size?: number
  binary?: boolean
  truncated?: boolean
}
export interface CodexDiff {
  diff: string
  files: { path: string; status: string }[]
  truncated?: boolean
}

export type CodexApprovalAnswer =
  | { decision: 'accept' | 'decline' }
  | { answers: Record<string, { answers: string[] }> }
