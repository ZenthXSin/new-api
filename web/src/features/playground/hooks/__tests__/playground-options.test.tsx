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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth-store'

import { usePlaygroundOptions } from '../use-playground-options'

vi.mock('../../api', () => ({
  getUserGroups: vi.fn(async () => [
    { label: 'default', value: 'default', ratio: 1 },
    { label: 'premium', value: 'premium', ratio: 2 },
  ]),
  getUserModels: vi.fn(async (group: string) =>
    group === 'default'
      ? [{ label: 'old-model', value: 'old-model' }]
      : [{ label: 'new-model', value: 'new-model' }]
  ),
}))

beforeEach(() => {
  useAuthStore.setState({
    auth: { ...useAuthStore.getState().auth, user: { id: 7 } as never },
  })
})

describe('playground group selection readiness', () => {
  it('rejects the previous model immediately after the group changes', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      )
    }
    const { result, rerender } = renderHook(
      ({ group, model }) =>
        usePlaygroundOptions({
          currentGroup: group,
          currentModel: model,
          setGroups: vi.fn(),
          setModels: vi.fn(),
          updateConfig: vi.fn(),
        }),
      {
        initialProps: { group: 'default', model: 'old-model' },
        wrapper: Wrapper,
      }
    )
    await waitFor(() => expect(result.current.isSelectionValid).toBe(true))
    rerender({ group: 'premium', model: 'old-model' })
    expect(result.current.isSelectionValid).toBe(false)
    expect(result.current.availableModels).not.toContainEqual({
      label: 'old-model',
      value: 'old-model',
    })
    await waitFor(() => expect(result.current.isLoadingModels).toBe(false))
    expect(result.current.isSelectionValid).toBe(false)
    expect(result.current.availableGroups).toHaveLength(2)
    expect(result.current.availableModels).toEqual([
      { label: 'new-model', value: 'new-model' },
    ])
    rerender({ group: 'premium', model: 'new-model' })
    expect(result.current.isSelectionValid).toBe(true)
    client.clear()
  })
})
