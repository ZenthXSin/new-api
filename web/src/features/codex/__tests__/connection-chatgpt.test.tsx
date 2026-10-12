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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { GitHubConnection } from '../components/github-connection'
import {
  SshConnections,
  type SshConnectionsProps,
} from '../components/ssh-connections'
import type { CodexSshTest } from '../types'

const clients: QueryClient[] = []
afterEach(() => {
  clients.forEach((client) => client.clear())
  clients.length = 0
})

function serverProps(): SshConnectionsProps {
  return {
    connections: [
      {
        id: 'development',
        name: 'Development server',
        host: 'dev.example.com',
        port: 22,
        username: 'developer',
        authType: 'key',
        fingerprint: 'SHA256:verified-server',
        createdAt: '2026-10-07T00:00:00Z',
      },
    ],
    loading: false,
    onRefresh: vi.fn(),
    onProbe: vi.fn(async () => ({
      host: 'dev.example.com',
      port: 22,
      addresses: [],
      keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:verified-server' }],
    })),
    onCreate: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onTest: vi.fn(async () => ({
      connected: true,
      home: '/home/developer',
      capabilities: { python: true, git: true, codex: true },
    })),
  }
}

describe('Connection settings interactions', () => {
  test('a pending GitHub revocation has a distinct status and keeps the disconnect action available', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: {
          configured: true,
          connected: false,
          revocationPending: true,
          capabilities: [],
          scopes: [],
        },
      },
    } as AxiosResponse)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(client)
    render(
      <QueryClientProvider client={client}>
        <GitHubConnection actor='settings-user' />
      </QueryClientProvider>
    )

    expect(
      await screen.findByText('GitHub disconnection pending')
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Disconnect GitHub' })
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Connect GitHub' })
    ).not.toBeInTheDocument()
  })

  test('Escape closes an SSH draft, restores focus and clears the credential on reopening', async () => {
    const props = serverProps()
    render(<SshConnections {...props} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Add SSH server' })
    )
    fireEvent.change(screen.getByLabelText('SSH private key'), {
      target: { value: 'fixture-only-secret' },
    })
    screen.getByLabelText('SSH private key').focus()
    await userEvent.keyboard('{Escape}')

    expect(
      screen.queryByRole('form', { name: 'Add SSH server' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add SSH server' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByLabelText('SSH private key')).toHaveValue('')
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  test('a pending SSH test announces progress, blocks duplicate requests and exposes its result', async () => {
    let finish!: (value: CodexSshTest) => void
    const props = serverProps()
    props.onTest = vi.fn(
      () =>
        new Promise<CodexSshTest>((resolve) => {
          finish = resolve
        })
    )
    render(<SshConnections {...props} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Test connection' })
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Testing connection...'
    )
    expect(
      screen.getByRole('button', { name: 'Testing connection...' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Remove SSH server' })
    ).toBeDisabled()
    await act(async () =>
      finish({
        connected: true,
        home: '/home/developer',
        capabilities: { python: true, git: true, codex: false },
      })
    )
    expect(await screen.findByText('SSH connection successful.')).toBeVisible()
    expect(props.onTest).toHaveBeenCalledOnce()
  })

  test('cancelling removal with Escape returns focus to the saved server action', async () => {
    const props = serverProps()
    render(<SshConnections {...props} />)
    const card = within(
      screen.getByRole('article', { name: 'Development server' })
    )
    await userEvent.click(
      card.getByRole('button', { name: 'Remove SSH server' })
    )
    expect(card.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')

    await waitFor(() =>
      expect(
        card.getByRole('button', { name: 'Remove SSH server' })
      ).toHaveFocus()
    )
    expect(
      card.queryByRole('button', { name: 'Confirm removal' })
    ).not.toBeInTheDocument()
    expect(props.onRemove).not.toHaveBeenCalled()
  })
})
