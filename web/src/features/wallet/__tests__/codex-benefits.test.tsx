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

import { defaultCodexPlan } from '@/features/codex-admin/types'
import { api } from '@/lib/api'

import { SubscriptionPlansCard } from '../components/subscription-plans-card'

const clients: QueryClient[] = []
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse

test.each([false, true])(
  'a plan with Codex enabled=%s advertises only the included Codex benefits',
  async (enabled) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(client)
    vi.spyOn(api, 'get').mockImplementation(async (path) => {
      if (path === '/api/subscription/plans') {
        return response([
          {
            plan: {
              id: 1,
              title: 'Trial plan',
              price_amount: 0,
              duration_unit: 'month',
              duration_value: 1,
              codex: {
                ...defaultCodexPlan,
                enabled,
                memoryMB: 2048,
                maxProjects: 3,
                allowDocker: true,
                allowSSH: false,
              },
            },
          },
        ])
      }
      if (path === '/api/subscription/self') {
        return response({ subscriptions: [], all_subscriptions: [] })
      }
      throw new Error('Unexpected fixture request')
    })
    client.setQueryData(['codex-access', 25, 'fixture'], { enabled: false })
    const post = vi.spyOn(api, 'post').mockResolvedValue(response({}))
    render(
      <QueryClientProvider client={client}>
        <SubscriptionPlansCard topupInfo={null} userQuota={1000000} />
      </QueryClientProvider>
    )
    await screen.findByText('Trial plan')
    expect(screen.queryByText('Online Codex', { exact: true }) !== null).toBe(
      enabled
    )
    expect(
      screen.queryByText('Memory limit (MB): 2048', { exact: true }) !== null
    ).toBe(enabled)
    expect(
      screen.queryByText('SSH execution', { exact: true })
    ).not.toBeInTheDocument()
    if (enabled) {
      await userEvent.click(
        screen.getByRole('button', { name: 'Subscribe Now' })
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Pay with Balance' })
      )
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/api/subscription/balance/pay', {
          plan_id: 1,
        })
      )
      await waitFor(() =>
        expect(
          client.getQueryState(['codex-access', 25, 'fixture'])?.isInvalidated
        ).toBe(true)
      )
    }
  }
)
