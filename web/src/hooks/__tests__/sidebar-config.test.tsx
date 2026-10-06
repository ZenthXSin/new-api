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
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  parseSidebarModulesAdmin,
  serializeSidebarModulesAdmin,
} from '@/features/system-settings/maintenance/config'
import { useAuthStore } from '@/stores/auth-store'

import { useSidebarConfig } from '../use-sidebar-config'
import { useSidebarData } from '../use-sidebar-data'

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAuthStore.getState().auth.reset()
})

function sidebarFor(admin?: object, user?: object, canConfigure = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['status'], {
    SidebarModulesAdmin: admin ? JSON.stringify(admin) : '',
  })
  useAuthStore.getState().auth.setUser({
    id: 1,
    username: 'alice',
    role: 1,
    permissions: { sidebar_settings: canConfigure },
    sidebar_modules: user ? JSON.stringify(user) : '',
  })
  function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        {props.children}
      </QueryClientProvider>
    )
  }
  const result = renderHook(
    () => useSidebarConfig(useSidebarData().navGroups),
    { wrapper: Wrapper }
  )
  return result
}

describe('group availability sidebar entry', () => {
  it('shows group availability in General for ordinary users with a legacy configuration', () => {
    const { result } = sidebarFor({ console: { enabled: true, detail: true } })
    expect(
      result.current.find((group) => group.id === 'general')?.items
    ).toContainEqual(
      expect.objectContaining({
        title: 'Group Availability',
        url: '/group-availability',
      })
    )
  })

  it.each([
    [{ console: { enabled: true, group_availability: false } }, undefined],
    [{ console: { enabled: false } }, undefined],
    [undefined, { console: { enabled: true, group_availability: false } }],
  ])('respects sidebar visibility settings (%j, %j)', (admin, user) => {
    const { result } = sidebarFor(admin, user)
    expect(
      result.current.flatMap((group) => group.items).map((item) => item.title)
    ).not.toContain('Group Availability')
  })

  it('preserves the independent availability setting when administrator settings are saved', () => {
    const config = parseSidebarModulesAdmin(
      '{"console":{"enabled":true,"detail":false}}'
    )
    expect(config.console.group_availability).toBe(true)
    config.console.group_availability = false
    const saved = parseSidebarModulesAdmin(serializeSidebarModulesAdmin(config))
    expect(saved.console.group_availability).toBe(false)
    expect(saved.console.detail).toBe(false)
  })
})
