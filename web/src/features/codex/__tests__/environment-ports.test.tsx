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
import { afterEach, describe, expect, test, vi } from 'vitest'

import { codexApi } from '../api'
import { EnvironmentPorts } from '../components/environment-ports'
import type { CodexPublicPorts } from '../types'

const allocation = {
  id: 'b013cb66-4cdd-4d31-86df-a20d85d78973',
  localPort: 3000,
  remotePort: 31000,
  publicHost: 'preview.example',
  address: 'preview.example:31000',
  protocol: 'tcp' as const,
  label: 'Preview',
  status: 'running' as const,
  createdAt: 1,
}
function renderPorts(data: CodexPublicPorts, running = true) {
  vi.spyOn(codexApi, 'ports').mockResolvedValue(data)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <EnvironmentPorts actor='owner-1' running={running} />
    </QueryClientProvider>
  )
  return userEvent.setup()
}
afterEach(() => vi.restoreAllMocks())

describe('Docker public ports', () => {
  test('opening a container port refreshes the assigned public address and closing releases it', async () => {
    const data = { available: true, limit: 10, used: 0, ports: [] }
    const user = renderPorts(data)
    vi.spyOn(codexApi, 'openPort').mockImplementation(async () => {
      vi.mocked(codexApi.ports).mockResolvedValue({
        ...data,
        used: 1,
        ports: [allocation],
      })
      return { port: allocation, limit: 10, used: 1 }
    })
    const close = vi
      .spyOn(codexApi, 'closePort')
      .mockImplementation(async () => {
        vi.mocked(codexApi.ports).mockResolvedValue(data)
        return { closed: true, id: allocation.id, limit: 10, used: 0 }
      })
    await user.type(await screen.findByLabelText('Container port'), '3000')
    await user.type(screen.getByLabelText('Port label (optional)'), 'Preview')
    await user.click(screen.getByRole('button', { name: 'Open port' }))
    expect(
      await screen.findByText('3000 → preview.example:31000')
    ).toBeVisible()
    expect(screen.getByLabelText('Container port')).toHaveValue(null)
    await user.click(screen.getByRole('button', { name: 'Close port 31000' }))
    expect(close).toHaveBeenCalledWith(allocation.id)
    expect(
      await screen.findByText('No public ports are configured.')
    ).toBeVisible()
  })
  test('a failed opening keeps the values so the user can retry', async () => {
    const user = renderPorts({ available: true, limit: 10, used: 0, ports: [] })
    const open = vi
      .spyOn(codexApi, 'openPort')
      .mockRejectedValue(new Error('Port forwarding unavailable'))
    await user.type(await screen.findByLabelText('Container port'), '3000')
    await user.type(screen.getByLabelText('Port label (optional)'), 'Preview')
    await user.click(screen.getByRole('button', { name: 'Open port' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Port forwarding unavailable'
    )
    expect(screen.getByLabelText('Container port')).toHaveValue(3000)
    expect(screen.getByLabelText('Port label (optional)')).toHaveValue(
      'Preview'
    )
    open.mockResolvedValue({ port: allocation, limit: 10, used: 1 })
    await user.click(screen.getByRole('button', { name: 'Open port' }))
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    )
  })
  test('the ten-port quota disables opening but permits closing an existing allocation', async () => {
    const user = renderPorts({
      available: true,
      limit: 10,
      used: 10,
      ports: [allocation],
    })
    await user.type(await screen.findByLabelText('Container port'), '4000')
    expect(screen.getByRole('button', { name: 'Open port' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Close port 31000' })
    ).toBeEnabled()
  })
  test('a stopped environment disables port input and displays the restart instruction', async () => {
    renderPorts(
      {
        available: true,
        limit: 10,
        used: 1,
        ports: [{ ...allocation, status: 'stopped' }],
      },
      false
    )
    expect(await screen.findByLabelText('Container port')).toBeDisabled()
    expect(
      screen.getByText('Start your Docker environment before opening ports.')
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Close port 31000' })
    ).toBeEnabled()
  })
})
