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
export type CloudEnvironmentStatus =
  | 'draft'
  | 'ready'
  | 'published'
  | 'changes_pending'
  | 'preparing'
  | 'publishing'
  | 'error'

export interface CloudRepository {
  url: string
  branch: string
  path: string
}

export interface CloudEnvironmentVariable {
  name: string
  value?: string
  secret: boolean
  hasValue: boolean
}

export interface CloudEnvironmentConfig {
  repositories: CloudRepository[]
  installScript: string
  startSkill: string
  internetAccess: 'enabled'
  allowedDomains: string[]
  networkSecrets?: never[]
  environmentVariables: CloudEnvironmentVariable[]
  privacy: 'private'
  advanced: { setupTimeoutSeconds: number }
}

export interface CloudEnvironmentCapabilities {
  runtime: 'docker'
  internetModes: string[]
  networkSecrets: boolean
  sharingModes: string[]
  snapshotScope: string
  systemPackageInstall: boolean
  limits: { maxRepositories: number; maxEnvironmentVariables: number }
  unsupportedReasons: {
    internetAccess: string
    networkSecrets: string
    sharing: string
    systemPackageInstall: string
  }
}

export interface CloudEnvironment {
  id: string
  name: string
  description: string
  createdAt: number
  updatedAt: number
  setupWorkspaceId: string
  draftRevision: number
  preparedRevision: number | null
  publishedVersion: number | null
  publishedAt: number | null
  status: CloudEnvironmentStatus
  lastError: string | null
  setupLog?: string
  operation?: CloudEnvironmentOperation
  config: CloudEnvironmentConfig
  published: {
    version: number
    createdAt: number
    snapshot: { bytes: number; files: number }
    config: CloudEnvironmentConfig
  } | null
}

export interface CloudEnvironmentInput {
  name: string
  description: string
  config: CloudEnvironmentConfig
}

export interface CloudEnvironmentOperation {
  type: 'setup' | 'publish'
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  finishedAt?: number
  error?: { code: string; message: string }
}

export interface CloudEnvironmentDetail {
  environment: CloudEnvironment
  operation?: CloudEnvironmentOperation | null
}

export interface ExecutionTarget {
  type: 'cloud' | 'docker' | 'ssh' | 'host'
  environmentId?: string
}
