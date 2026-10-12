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
export type CodexMode = 'code' | 'ask' | 'auto' | 'full-access'
export interface CodexTask {
  id: string
  workspaceId: string
  conversationId: string
  title: string
  workspaceName: string
  createdAt: number
  updatedAt: number
  status: CodexWorkspaceStatus
  latestTurnStatus: string | null
  turnCount: number
  mode: CodexMode
  model: string
  queuedCount: number
  approvalCount: number
  archived: boolean
  workspaceArchived: boolean
  conversationArchived: boolean
  source: 'local' | 'ssh'
  repository?: string
}
export interface CodexTaskPage {
  tasks: CodexTask[]
  total: number
  hasMore: boolean
  nextOffset: number | null
}
export interface CodexRepository {
  checkoutSupported: boolean
  checkoutReason:
    | 'submodules'
    | 'operation_in_progress'
    | 'not_repository'
    | null
  hasSubmodules: boolean
  available: boolean
  branch: string | null
  head: string | null
  detached: boolean
  dirty: boolean
  remotes: { name: string; url: string | null }[]
  branches: {
    name: string
    ref: string
    remote: string | null
    current: boolean
  }[]
  branchesTruncated: boolean
}
export interface CodexEnvironment {
  status: 'not_created' | 'stopped' | 'starting' | 'running' | 'error'
  mode: CodexMode
  runtime?: 'docker'
  network?: {
    mode: 'bridge'
    internetAccess: 'enabled'
    policyEditable: boolean
  }
  persistentStorage?: boolean
  filesystemIsolation?: 'user'
  activeTasks?: {
    workspaceId: string
    conversationId: string
    status: string
  }[]
  activeConversationId?: string | null
  activeWorkspaceId: string | null
  activeWorkspaceName: string | null
  projectCount: number
  idleSeconds: number
  limits: {
    cpus: number
    cpuPercent?: number
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
export interface CodexBranch {
  rootConversationId: string
  revisionId: string
  parentRevisionId?: string
  replayTurnId?: string
  turnIndex?: number
  version: number
}
export interface CodexSearchResult {
  id: string
  workspaceId: string
  workspaceName: string
  conversationId?: string
  conversationName: string
  workspaceArchived: boolean
  conversationArchived: boolean
  matchType: 'project' | 'conversation' | 'message'
  snippet: string
  turnId?: string
  role?: 'user' | 'assistant'
  updatedAt: number
}
export interface CodexProjectConversation {
  branch?: CodexBranch
  customName?: boolean
  archived?: boolean
  id: string
  name: string
  status: string
  createdAt: number
  updatedAt: number
  turnCount: number
}
export interface CodexWorkspace {
  conversationArchived?: boolean
  conversationId?: string
  conversationName?: string
  conversationCount?: number
  activeTasks?: {
    workspaceId: string
    conversationId: string
    status: string
  }[]
  activeConversationId?: string | null
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
  group?: string
  host?: { path: string }
  remote?: {
    connectionId: string
    path: string
    host: string
    username: string
  }
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
  deletedRoles?: ('user' | 'assistant')[]
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
  queuedTurns?: CodexQueuedTurn[]
  conversationId?: string
  conversations?: CodexProjectConversation[]
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
  queuedTurns?: CodexQueuedTurn[]
  conversationId?: string
  conversations?: CodexProjectConversation[]
  persistenceError?: boolean
  events: CodexEvent[]
  nextCursor: number
  workspace: CodexWorkspace
  pendingApprovals: CodexApproval[]
  reset?: boolean
}
export interface CodexTurnInput {
  busyAction?: 'queue' | 'interrupt'
  replayTurnId?: string
  group?: string
  prompt: string
  requestId: string
  model: string
  effort: string
  mode: CodexMode
}
export interface CodexQueuedTurn {
  requestId: string
  prompt: string
  model: string
  group: string
  effort: string
  mode: CodexMode
  conversationId: string
  createdAt: number
  status: 'queued' | 'paused' | 'starting'
  error?: string
  canResume?: boolean
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
  hash: string | null
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

export interface CodexCatalogModel {
  id: string
  name: string
  supported: boolean
  reason?: string
}
export interface CodexCatalog {
  groups: {
    id: string
    name: string
    description: string
    ratio: number | null
    models: CodexCatalogModel[]
  }[]
  defaultGroup: string
  defaultModel: string
}
export interface CodexSshConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'key' | 'password'
  fingerprint: string
  createdAt: string | number
  lastConnectedAt?: string | number
}
export interface CodexSshProbe {
  host: string
  port: number
  keys: { type: string; fingerprint: string }[]
  addresses: string[]
}
export interface CodexSshConnectionInput {
  name: string
  host: string
  port?: number
  username: string
  authType: 'key' | 'password'
  privateKey?: string
  password?: string
  fingerprint: string
}
export interface CodexSshTest {
  connected: boolean
  home: string
  capabilities: { python: boolean; git: boolean; codex: boolean }
}
export interface CodexGitHubStatus {
  configured: boolean
  connected: boolean
  revocationPending?: boolean
  login?: string
  avatarUrl?: string
  scopes: string[]
  capabilities: string[]
  reason?: string
}
export interface CodexGitHubRepository {
  id: number
  name: string
  fullName: string
  private: boolean
  cloneUrl: string
  defaultBranch: string
}
export interface CodexCreateInput {
  name: string
  repositoryUrl?: string
  branch?: string
  host?: { path: string }
  remote?: { connectionId: string; path: string }
}
export type CodexPublicPort = {
  id: string
  localPort: number
  remotePort: number
  publicHost: string
  address: string
  protocol: 'tcp'
  label: string
  status: 'running' | 'stopped'
  createdAt: number
}
export type CodexPublicPorts = {
  available: boolean
  limit: number
  used: number
  ports: CodexPublicPort[]
}
