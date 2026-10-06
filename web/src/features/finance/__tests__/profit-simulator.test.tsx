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
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import type { FinanceOverview } from '../api'
import { ProfitSimulator } from '../components/profit-simulator'

// Rendering the canvas is covered by real-browser validation.
vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))
vi.mock('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: () => undefined },
}))

const overview: FinanceOverview = {
  revenue_quota: 1500000000,
  cost_quota: 900000000,
  gross_profit_quota: 600000000,
  margin: 0.4,
  request_count: 10,
  cost_coverage: 1,
  paid_users_total: 2,
  paid_users_period: 1,
  paid_money_total: 25,
  paid_money_period: 12.5,
  manual_income_money: 0,
  manual_expense_money: 0,
  manual_income_quota: 0,
  manual_expense_quota: 0,
}

beforeEach(() => {
  localStorage.clear()
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
  localStorage.clear()
})

function renderSimulator() {
  return render(
    <ProfitSimulator
      overview={overview}
      rangeDays={30}
      overviewLoading={false}
      overviewError={false}
    />
  )
}

function enterNumber(label: string, value: string) {
  fireEvent.change(screen.getByRole('spinbutton', { name: label }), {
    target: { value },
  })
}

test('runs the requested duration at a fixed margin and exports only simulated daily values', async () => {
  const createObjectURL = vi.fn(() => 'blob:simulation')
  const revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURL,
  })
  let filename = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      filename = this.download
    }
  )
  renderSimulator()
  const user = userEvent.setup()
  fireEvent.change(screen.getByLabelText('Start Date'), {
    target: { value: '2027-02-01' },
  })
  enterNumber('Duration (days)', '2')
  enterNumber('Base daily revenue (USD)', '100')
  enterNumber('Minimum profit margin (%)', '20')
  enterNumber('Maximum profit margin (%)', '20')
  enterNumber('Revenue fluctuation (%)', '0')
  await user.click(screen.getByRole('button', { name: 'Run Simulation' }))

  expect(
    await screen.findByText('Simulation generated for 2 days.')
  ).toBeVisible()
  const details = screen.getByRole('region', {
    name: 'Daily Simulation Details',
  })
  expect(within(details).getAllByRole('row')).toHaveLength(3)
  expect(within(details).getByText('2027-02-02')).toBeVisible()
  expect(within(details).getAllByText('$20.00').length).toBeGreaterThan(0)
  await user.click(
    screen.getByRole('button', { name: 'Export Simulation CSV' })
  )
  expect(filename).toBe('profit-simulation-2027-02-01.csv')
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:simulation')
})

test('rejects an inverted margin range with a field error and does not generate results', async () => {
  renderSimulator()
  enterNumber('Minimum profit margin (%)', '50')
  enterNumber('Maximum profit margin (%)', '10')
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Run Simulation' }))

  expect(
    await screen.findByText(
      'The maximum margin must be at least the minimum margin'
    )
  ).toBeVisible()
  expect(
    screen.getByRole('spinbutton', { name: 'Maximum profit margin (%)' })
  ).toHaveAttribute('aria-invalid', 'true')
  expect(screen.queryByText('Simulation Results')).not.toBeInTheDocument()
  expect(screen.getByText('No simulation yet')).toBeVisible()
})

test('uses actual daily revenue in USD independently of display currency and allows returning to manual input', async () => {
  useSystemConfigStore.getState().setConfig({
    currency: {
      ...DEFAULT_CURRENCY_CONFIG,
      quotaDisplayType: 'CNY',
      usdExchangeRate: 7,
    },
  })
  renderSimulator()
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Use actual daily average' })
  )

  const revenue = screen.getByRole('spinbutton', {
    name: 'Base daily revenue (USD)',
  })
  expect(revenue).toHaveValue(100)
  expect(revenue).toHaveAttribute('readonly')
  await user.click(screen.getByRole('button', { name: 'Manual daily revenue' }))
  expect(revenue).not.toHaveAttribute('readonly')
})

test('disables actual averages after a failed finance query while manual simulation stays available', () => {
  render(
    <ProfitSimulator
      overview={undefined}
      rangeDays={30}
      overviewLoading={false}
      overviewError
    />
  )

  expect(
    screen.getByRole('button', { name: 'Use actual daily average' })
  ).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Run Simulation' })).toBeEnabled()
  expect(
    screen.getByText(
      'Actual revenue is unavailable. Enter a daily revenue manually.'
    )
  ).toBeVisible()
})

test('updates the actual average when the finance window changes and blocks unavailable actual data', async () => {
  const view = renderSimulator()
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'Use actual daily average' })
  )
  view.rerender(
    <ProfitSimulator
      overview={{ ...overview, revenue_quota: 350000000 }}
      rangeDays={7}
      overviewLoading={false}
      overviewError={false}
    />
  )

  expect(
    screen.getByRole('spinbutton', { name: 'Base daily revenue (USD)' })
  ).toHaveValue(100)
  view.rerender(
    <ProfitSimulator
      overview={{ ...overview, revenue_quota: 700000000 }}
      rangeDays={7}
      overviewLoading={false}
      overviewError={false}
    />
  )
  await waitFor(() =>
    expect(
      screen.getByRole('spinbutton', { name: 'Base daily revenue (USD)' })
    ).toHaveValue(200)
  )
  view.rerender(
    <ProfitSimulator
      overview={undefined}
      rangeDays={7}
      overviewLoading={false}
      overviewError
    />
  )
  expect(screen.getByRole('button', { name: 'Run Simulation' })).toBeDisabled()
  expect(
    screen.getByRole('button', { name: 'New Random Scenario' })
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Manual daily revenue' }))
  expect(screen.getByRole('button', { name: 'Run Simulation' })).toBeEnabled()
})

test('marks changed assumptions, creates a new seeded scenario, paginates daily details, and resets results', async () => {
  renderSimulator()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Run Simulation' }))
  expect(
    await screen.findByText('Simulation generated for 30 days.')
  ).toBeVisible()
  const details = screen.getByRole('region', {
    name: 'Daily Simulation Details',
  })
  expect(within(details).getAllByRole('row')).toHaveLength(21)
  await user.click(screen.getByRole('button', { name: 'Go to next page' }))
  expect(within(details).getAllByRole('row')).toHaveLength(11)
  enterNumber('Duration (days)', '5')
  expect(
    await screen.findByText(
      'Simulation parameters have changed. Run again to update the results.'
    )
  ).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'New Random Scenario' }))
  expect(
    await screen.findByText('Simulation generated for 5 days.')
  ).toBeVisible()
  expect(screen.getByRole('spinbutton', { name: 'Random Seed' })).toHaveValue(
    43
  )
  await waitFor(() =>
    expect(
      screen.queryByText(
        'Simulation parameters have changed. Run again to update the results.'
      )
    ).not.toBeInTheDocument()
  )
  await user.click(screen.getByRole('button', { name: 'Reset Simulation' }))
  expect(screen.getByText('No simulation yet')).toBeVisible()
  expect(
    screen.getByRole('spinbutton', { name: 'Duration (days)' })
  ).toHaveValue(30)
  expect(screen.getByRole('spinbutton', { name: 'Random Seed' })).toHaveValue(
    42
  )
})
