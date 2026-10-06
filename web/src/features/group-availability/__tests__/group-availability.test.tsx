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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError } from 'axios'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { api } from '@/lib/http-client'
import { useAuthStore } from '@/stores/auth-store'

import {
  getGroupAvailability,
  type AvailabilityGroup,
  type GroupAvailabilityData,
} from '../api'
import { GroupAvailability } from '../index'

const originalAdapter = api.defaults.adapter
let client: QueryClient

function availabilityGroup(
  overrides: Partial<AvailabilityGroup> = {}
): AvailabilityGroup {
  return {
    group: 'premium',
    display_name: 'Premium',
    status: 'healthy',
    sample_state: 'sufficient',
    request_count: null,
    success_count: null,
    error_count: null,
    success_rate: 98,
    cache_hit_rate: null,
    avg_ttft_ms: 250,
    avg_duration_ms: 2000,
    last_request_at: 1790937000,
    buckets: [
      {
        start_time: 1790935200,
        status: 'healthy',
        sample_state: 'sufficient',
        request_count: null,
        success_count: null,
        error_count: null,
        success_rate: 98,
        cache_hit_rate: null,
        avg_ttft_ms: 250,
        avg_duration_ms: 2000,
      },
    ],
    ...overrides,
  }
}

function availabilityData(
  groups = [availabilityGroup()]
): GroupAvailabilityData {
  return {
    range: '24h',
    source: 'passive_requests',
    bucket_seconds: 1800,
    generated_at: 1790938800,
    refresh_interval_seconds: 15,
    data_through: 1790937000,
    start_time: 1790852400,
    end_time: 1790938800,
    collection_started_at: 1790935000,
    coverage_complete: false,
    min_samples: 1,
    warning_error_rate: 5,
    critical_error_rate: 20,
    groups,
  }
}

function renderPage() {
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <GroupAvailability />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'ordinary', role: 1, group: 'premium' })
})

afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
  localStorage.clear()
})

test('uses the read-only aggregate endpoint and rejects business failures', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  api.defaults.adapter = async (config) => {
    expect(config.method).toBe('get')
    expect(config.url).toBe('/api/group-availability')
    expect(config.params).toEqual({ range: '7d', sort: 'name' })
    return {
      config,
      data: { success: false, message: 'Collection unavailable' },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  await expect(getGroupAvailability('7d')).rejects.toMatchObject({
    message: 'Unable to load group availability',
  })
  expect(errorToast).not.toHaveBeenCalled()
})

test('keeps HTTP failure details out of global toasts while preserving the page error state', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  api.defaults.adapter = async (config) => {
    throw new AxiosError(
      'Private upstream failure',
      'ERR_BAD_RESPONSE',
      config,
      undefined,
      {
        config,
        data: {
          success: false,
          message: 'Private channel provider diagnostic',
        },
        status: 503,
        statusText: 'Service Unavailable',
        headers: {},
      }
    )
  }
  renderPage()
  expect(
    await screen.findByText('Unable to load group availability')
  ).toBeVisible()
  expect(errorToast).not.toHaveBeenCalled()
  expect(screen.queryByText(/Private/)).not.toBeInTheDocument()
})

test('renders one aggregate card per group and hides counts and private details for ordinary users', async () => {
  const data = availabilityData([
    {
      ...availabilityGroup(),
      channel_id: 987,
      channel_name: 'Private channel',
      provider: 'Private upstream',
      error: 'Private upstream exception',
    } as AvailabilityGroup,
    availabilityGroup({
      group: 'basic',
      display_name: 'Basic',
      status: 'unknown',
      sample_state: 'none',
      success_rate: null,
      avg_ttft_ms: null,
      avg_duration_ms: null,
      last_request_at: null,
      buckets: [],
    }),
  ])
  api.defaults.adapter = async (config) => ({
    config,
    data: { success: true, data },
    status: 200,
    statusText: 'OK',
    headers: {},
  })
  renderPage()

  const premium = await screen.findByRole('region', { name: 'Premium' })
  expect(screen.getAllByRole('region', { name: 'Premium' })).toHaveLength(1)
  expect(within(premium).getByText('98.00%')).toBeVisible()
  expect(within(premium).getByText('250ms')).toBeVisible()
  expect(within(premium).getByText('2.00s')).toBeVisible()
  expect(screen.queryByText(/Observed requests:/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Private/)).not.toBeInTheDocument()
  const basic = screen.getByRole('region', { name: 'Basic' })
  expect(within(basic).getByText('No traffic')).toBeVisible()
  expect(within(basic).queryByText('0.00%')).not.toBeInTheDocument()
  expect(within(basic).queryByText('Healthy')).not.toBeInTheDocument()
  expect(screen.getByText('History is still accumulating')).toBeVisible()

  await userEvent
    .setup()
    .type(screen.getByRole('textbox', { name: 'Search groups' }), 'basic')
  expect(
    screen.queryByRole('region', { name: 'Premium' })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Basic' })).toBeVisible()
})

test('shows administrator counts and preserves unknown health when samples are insufficient', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 10, username: 'admin', role: 10, group: 'premium' })
  const data = availabilityData([
    availabilityGroup({
      request_count: 3,
      success_count: 3,
      error_count: 0,
      success_rate: 100,
      cache_hit_rate: 25,
      sample_state: 'insufficient',
      status: 'unknown',
    }),
  ])
  api.defaults.adapter = async (config) => ({
    config,
    data: { success: true, data },
    status: 200,
    statusText: 'OK',
    headers: {},
  })
  renderPage()
  const premium = await screen.findByRole('region', { name: 'Premium' })
  expect(within(premium).getByText('Observed requests: 3')).toBeVisible()
  expect(
    within(premium).getByRole('definition', { name: 'Cache hit rate' })
  ).toHaveTextContent('25.00%')
  expect(within(premium).getByText('Insufficient samples')).toBeVisible()
  expect(within(premium).getByText('100.00%')).toBeVisible()
  expect(within(premium).queryByText('Healthy')).not.toBeInTheDocument()
})

test('changes observation ranges and refreshes without calling mutations or channel endpoints', async () => {
  const ranges: string[] = []
  api.defaults.adapter = async (config) => {
    expect(config.method).toBe('get')
    expect(config.url).toBe('/api/group-availability')
    ranges.push(config.params.range)
    return {
      config,
      data: {
        success: true,
        data: { ...availabilityData(), range: config.params.range },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  renderPage()
  await screen.findByRole('region', { name: 'Premium' })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '7 days' }))
  await waitFor(() => expect(ranges).toEqual(['24h', '7d']))
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(ranges).toEqual(['24h', '7d', '7d']))
})

test('distinguishes access-empty data from failed requests and never displays server error details', async () => {
  let fail = false
  api.defaults.adapter = async (config) => ({
    config,
    data: fail
      ? { success: false, message: 'Private channel credentials diagnostic' }
      : { success: true, data: availabilityData([]) },
    status: 200,
    statusText: 'OK',
    headers: {},
  })
  renderPage()
  expect(await screen.findByText('No accessible groups')).toBeVisible()
  fail = true
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
  expect(
    await screen.findByText('Unable to load group availability')
  ).toBeVisible()
  expect(screen.queryByText('No accessible groups')).not.toBeInTheDocument()
  expect(screen.queryByText(/Private channel/)).not.toBeInTheDocument()
})

test('removes the previous account groups immediately when the account changes', async () => {
  let resolveSecond: (() => void) | undefined
  let calls = 0
  api.defaults.adapter = async (config) => {
    calls++
    if (calls === 2) {
      await new Promise<void>((resolve) => {
        resolveSecond = resolve
      })
    }
    return {
      config,
      data: {
        success: true,
        data: availabilityData(calls === 1 ? [availabilityGroup()] : []),
      },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  renderPage()
  await screen.findByRole('region', { name: 'Premium' })
  act(() =>
    useAuthStore
      .getState()
      .auth.setUser({ id: 2, username: 'other', role: 1, group: 'basic' })
  )
  expect(
    screen.queryByRole('region', { name: 'Premium' })
  ).not.toBeInTheDocument()
  await waitFor(() => expect(resolveSecond).toBeDefined())
  await act(async () => resolveSecond?.())
  expect(await screen.findByText('No accessible groups')).toBeVisible()
})

test.each([
  { label: 'reported cache hits', rate: 64.25, display: '64.25%' },
  { label: 'reported zero cache hits', rate: 0, display: '0.00%' },
  { label: 'unreported cache usage', rate: null, display: '—' },
  {
    label: 'older responses without cache usage',
    rate: undefined,
    display: '—',
  },
])(
  'shows $display for $label without exposing token totals',
  async ({ rate, display }) => {
    api.defaults.adapter = async (config) => ({
      config,
      data: {
        success: true,
        data: {
          ...availabilityData(),
          groups: [
            {
              ...availabilityGroup(),
              cache_hit_rate: rate,
              cache_read_tokens: 123456789,
              total_input_tokens: 987654321,
            },
          ],
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
    })
    renderPage()
    const premium = await screen.findByRole('region', { name: 'Premium' })
    expect(
      within(premium).getByRole('definition', { name: 'Cache hit rate' })
    ).toHaveTextContent(display)
    expect(screen.queryByText(/123456789|987654321/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Observed requests:/)).not.toBeInTheDocument()
  }
)

test('shows the cache rate for the keyboard-focused history bucket independently of the group total', async () => {
  const group = availabilityGroup({ cache_hit_rate: 64.25 })
  group.buckets[0].cache_hit_rate = 37.5
  api.defaults.adapter = async (config) => ({
    config,
    data: { success: true, data: availabilityData([group]) },
    status: 200,
    statusText: 'OK',
    headers: {},
  })
  renderPage()
  const premium = await screen.findByRole('region', { name: 'Premium' })
  const history = within(premium).getByRole('group', {
    name: 'Availability history for Premium',
  })
  act(() =>
    within(premium).getByRole('button', { name: 'Cache hit rate' }).focus()
  )
  await userEvent.setup().tab()
  expect(within(history).getByRole('button')).toHaveFocus()
  expect(await screen.findByText('Cache hit rate: 37.50%')).toBeVisible()
  expect(
    within(premium).getByRole('definition', { name: 'Cache hit rate' })
  ).toHaveTextContent('64.25%')
})

test('defaults to server auto order and can restore name order without exposing counts', async () => {
  const calls: string[] = []
  api.defaults.adapter = async (config) => {
    calls.push(config.params.sort)
    const busy = availabilityGroup({ group: 'z', display_name: 'Busy' })
    const quiet = availabilityGroup({ group: 'a', display_name: 'Quiet' })
    return {
      config,
      data: {
        success: true,
        data: availabilityData(
          config.params.sort === 'auto' ? [busy, quiet] : [quiet, busy]
        ),
      },
      status: 200,
      statusText: 'OK',
      headers: {},
    }
  }
  renderPage()
  await screen.findByRole('region', { name: 'Busy' })
  expect(calls).toEqual(['auto'])
  expect(screen.getAllByRole('region')).toEqual([
    screen.getByRole('region', { name: 'Busy' }),
    screen.getByRole('region', { name: 'Quiet' }),
  ])
  expect(screen.queryByText(/Observed requests:/)).not.toBeInTheDocument()
  await userEvent
    .setup()
    .click(screen.getByRole('switch', { name: 'Auto sort' }))
  await waitFor(() => expect(calls).toEqual(['auto', 'name']))
  await waitFor(() =>
    expect(screen.getAllByRole('region')).toEqual([
      screen.getByRole('region', { name: 'Quiet' }),
      screen.getByRole('region', { name: 'Busy' }),
    ])
  )
})

test('refreshes observation time and distinguishes sparse activity from an empty timeline', async () => {
  let refreshed = false
  api.defaults.adapter = async (config) => ({
    config,
    data: {
      success: true,
      data: availabilityData([
        availabilityGroup({
          sample_state: 'insufficient',
          status: 'unknown',
          request_count: 3,
          last_request_at: refreshed ? 1790938800 : 1790937000,
          buckets: [
            {
              ...availabilityGroup().buckets[0],
              start_time: 1790935200,
              sample_state: 'none',
              status: 'unknown',
              success_rate: null,
            },
            {
              ...availabilityGroup().buckets[0],
              start_time: 1790937000,
              sample_state: 'insufficient',
              status: 'unknown',
              success_rate: 100,
            },
          ],
        }),
      ]),
    },
    status: 200,
    statusText: 'OK',
    headers: {},
  })
  renderPage()
  const group = await screen.findByRole('region', { name: 'Premium' })
  const history = within(group).getByRole('group', {
    name: 'Availability history for Premium',
  })
  const empty = within(history).getByRole('button', { name: /No traffic/ })
  const sparse = within(history).getByRole('button', {
    name: /Insufficient samples/,
  })
  expect(empty.firstElementChild).not.toHaveClass('bg-info')
  expect(sparse.firstElementChild).toHaveClass('bg-info')
  const previous = within(group).getByText(/Last observed request:/).textContent
  refreshed = true
  await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() =>
    expect(
      within(group).getByText(/Last observed request:/).textContent
    ).not.toBe(previous)
  )
  expect(within(group).queryByText('Healthy')).not.toBeInTheDocument()
})
