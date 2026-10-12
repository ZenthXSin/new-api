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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, expect, test, vi } from 'vitest'

import type { User } from '@/features/users/types'
import { api } from '@/lib/api'

import { UserCodexConfigDialog } from '../components/user-codex-config-dialog'

const user: User = {
  id: 25,
  username: 'codex-config-fixture',
  display_name: 'Fixture',
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
  aff_code: '',
  aff_count: 0,
  aff_quota: 0,
  aff_history_quota: 0,
  inviter_id: 0,
  status: 1,
  role: 1,
}
const config = {
  userId: 25,
  enabled: null,
  allowDocker: null,
  allowSSH: null,
  cpuPercent: 0,
  memoryMB: 0,
  diskMB: 0,
  maxProjects: 0,
  idleSeconds: 0,
  defaultModel: 'gpt-6.1-sol',
  defaultGroup: '',
  defaultEffort: '',
}
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
const clients: QueryClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  vi.restoreAllMocks()
})

test.each(['max', 'ultra'])(
  'saving %s as an account default preserves it in the API request',
  async (effort) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    clients.push(client)
    const effective = { enabled: true, allowDocker: true, allowSSH: true }
    vi.spyOn(api, 'get').mockResolvedValue(response({ config, effective }))
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue(
        response({ config: { ...config, defaultEffort: effort }, effective })
      )
    const close = vi.fn()
    render(
      <QueryClientProvider client={client}>
        <UserCodexConfigDialog user={user} open onOpenChange={close} />
      </QueryClientProvider>
    )
    const selector = await screen.findByRole('combobox', {
      name: 'Default reasoning effort',
    })
    await userEvent.click(selector)
    await userEvent.click(
      screen.getByRole('option', { name: effort === 'max' ? 'Max' : 'Ultra' })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/codex-admin/users/25',
        expect.objectContaining({ defaultEffort: effort })
      )
    )
    await waitFor(() => expect(close).toHaveBeenCalledWith(false))
  }
)
