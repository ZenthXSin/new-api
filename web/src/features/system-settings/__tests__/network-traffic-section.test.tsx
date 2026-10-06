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
import { afterEach, expect, test } from 'vitest'

import { api } from '@/lib/http-client'

import { SettingsPageProvider } from '../components/settings-page-context'
import { NetworkTrafficSection } from '../maintenance/network-traffic-section'

const originalAdapter = api.defaults.adapter
const client = new QueryClient({
  defaultOptions: { mutations: { retry: false } },
})
let actions: HTMLDivElement

afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  actions.remove()
})

function renderSettings() {
  actions = document.createElement('div')
  document.body.append(actions)
  render(
    <QueryClientProvider client={client}>
      <SettingsPageProvider actionsContainer={actions}>
        <NetworkTrafficSection
          defaultValues={{
            NetworkTrafficEnabled: false,
            NetworkTrafficDailyBudgetGB: 5,
          }}
        />
      </SettingsPageProvider>
    </QueryClientProvider>
  )
}

test('saves the budget before enabling through the existing administrator option API', async () => {
  const saved: unknown[] = []
  api.defaults.adapter = async (config) => {
    expect(config.url).toBe('/api/option/')
    expect(config.method).toBe('put')
    saved.push(JSON.parse(config.data))
    return {
      config,
      data: { success: true },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  renderSettings()
  const user = userEvent.setup()
  const budget = screen.getByRole('spinbutton', {
    name: 'Daily traffic budget (GB)',
  })
  await user.clear(budget)
  await user.type(budget, '2')
  await user.click(
    screen.getByRole('switch', { name: 'Enable background traffic' })
  )
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() =>
    expect(saved).toEqual([
      { key: 'NetworkTrafficDailyBudgetGB', value: 2 },
      { key: 'NetworkTrafficEnabled', value: true },
    ])
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  )
})

test('rejects budgets above the cap before sending any mutation', async () => {
  let calls = 0
  api.defaults.adapter = async () => {
    calls++
    throw new Error('unexpected mutation')
  }
  renderSettings()
  const user = userEvent.setup()
  const budget = screen.getByRole('spinbutton', {
    name: 'Daily traffic budget (GB)',
  })
  await user.clear(budget)
  await user.type(budget, '6')
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(
    await screen.findByText(
      'Daily traffic budget must be between 0.1 and 5 GB.'
    )
  ).toBeVisible()
  expect(calls).toBe(0)
})
