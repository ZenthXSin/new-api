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
  CloudEnvironment,
  CloudEnvironmentCapabilities,
  CloudEnvironmentDetail,
  CloudEnvironmentInput,
} from './cloud-types'
import type { CodexWorkspace } from './types'

type Envelope<T> = { success: boolean; data: T; message?: string }
const requestConfig = {
  skipRequestDedup: true,
  skipBusinessError: true,
  skipErrorHandler: true,
}
const basePath = '/api/codex/environments'
const environmentPath = (id: string): string =>
  `${basePath}/${encodeURIComponent(id)}`

function unwrap<T>(response: { data: Envelope<T> }): T {
  if (!response.data.success) {
    throw new Error(
      response.data.message ||
        'The environment request failed. Please try again.'
    )
  }
  return response.data.data
}

export const cloudApi = {
  async list(signal?: AbortSignal) {
    return unwrap(
      await api.get<
        Envelope<{
          environments: CloudEnvironment[]
          capabilities?: CloudEnvironmentCapabilities
        }>
      >(basePath, {
        ...requestConfig,
        signal,
      })
    )
  },
  async detail(id: string, signal?: AbortSignal) {
    return unwrap(
      await api.get<Envelope<CloudEnvironmentDetail>>(environmentPath(id), {
        ...requestConfig,
        signal,
      })
    )
  },
  async create(input: CloudEnvironmentInput) {
    return unwrap(
      await api.post<
        Envelope<{ environment: CloudEnvironment; workspace?: CodexWorkspace }>
      >(basePath, input, { ...requestConfig, timeout: 120_000 })
    )
  },
  async update(id: string, input: CloudEnvironmentInput) {
    return unwrap(
      await api.patch<Envelope<{ environment: CloudEnvironment }>>(
        environmentPath(id),
        input,
        requestConfig
      )
    )
  },
  async remove(id: string) {
    return unwrap(
      await api.delete<Envelope<unknown>>(environmentPath(id), requestConfig)
    )
  },
  async setup(id: string) {
    return unwrap(
      await api.post<
        Envelope<CloudEnvironmentDetail & { workspace: CodexWorkspace }>
      >(
        `${environmentPath(id)}/setup`,
        {},
        { ...requestConfig, timeout: 120_000 }
      )
    )
  },
  async publish(id: string) {
    return unwrap(
      await api.post<Envelope<CloudEnvironmentDetail>>(
        `${environmentPath(id)}/publish`,
        {},
        { ...requestConfig, timeout: 120_000 }
      )
    )
  },
  async startTask(id: string, input: { name: string; requestId: string }) {
    return unwrap(
      await api.post<
        Envelope<{ workspace: CodexWorkspace; environment?: CloudEnvironment }>
      >(`${environmentPath(id)}/tasks`, input, {
        ...requestConfig,
        timeout: 120_000,
      })
    )
  },
}

export const cloudEnvironmentQueryKey = (
  actor = 'current'
): readonly string[] => ['codex', actor, 'cloud-environments']
