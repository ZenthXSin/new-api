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
import type {
  CodexDetail,
  CodexEnvironment,
  CodexStatus,
  CodexWorkspace,
} from '../types'

export const environment: CodexEnvironment = {
  status: 'stopped',
  mode: 'code',
  activeWorkspaceId: null,
  activeWorkspaceName: null,
  projectCount: 1,
  idleSeconds: 600,
  limits: {
    cpus: 2,
    cpuPercent: 5,
    memoryBytes: 2 * 1024 ** 3,
    diskBytes: 10 * 1024 ** 3,
  },
}

export const status: CodexStatus = {
  available: true,
  configured: true,
  version: '1',
  defaultModel: 'codex-test',
  defaultEffort: 'high',
  efforts: ['low', 'medium', 'high'],
  models: [{ id: 'codex-test', name: 'Codex Test' }],
  limits: {
    maxActive: 2,
    maxWorkspaces: 20,
    uploadBytes: 25 * 1024 * 1024,
    fileBytes: 1024 * 1024,
  },
  capabilities: {
    gitImport: true,
    zipImport: true,
    files: true,
    diff: true,
    approvals: true,
  },
}
export const workspace: CodexWorkspace = {
  id: 'project-1',
  name: 'Website project',
  status: 'idle',
  model: 'codex-test',
  effort: 'high',
  mode: 'code',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
}
export function detail(): CodexDetail {
  return {
    workspace: { ...workspace },
    thread: {
      id: 'thread-1',
      turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
    },
    pendingApprovals: [],
    nextCursor: 0,
    events: [],
  }
}
