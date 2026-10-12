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
import { describe, expect, test, vi } from 'vitest'

import { SshConnections } from '../components/ssh-connections'
import type { CodexSshConnection, CodexSshProbe } from '../types'

const connection: CodexSshConnection = {
  id: 'server-1',
  name: 'Development server',
  host: 'dev.example.com',
  port: 22,
  username: 'developer',
  authType: 'key',
  fingerprint: 'SHA256:trusted-host-key',
  createdAt: '2026-10-06T12:00:00Z',
}
const probe: CodexSshProbe = {
  host: 'dev.example.com',
  port: 22,
  keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:trusted-host-key' }],
  addresses: ['203.0.113.5'],
}

function callbacks() {
  return {
    connections: [] as CodexSshConnection[],
    loading: false,
    onRefresh: vi.fn(),
    onProbe: vi.fn(async () => probe),
    onCreate: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onTest: vi.fn(async () => ({
      connected: true as const,
      home: '/home/developer',
      capabilities: { python: true, git: true, codex: true },
    })),
  }
}

async function fillKeyConnection() {
  await userEvent.click(screen.getByRole('button', { name: 'Add SSH server' }))
  fireEvent.change(screen.getByLabelText('Connection name'), {
    target: { value: 'Development server' },
  })
  fireEvent.change(screen.getByLabelText('SSH host'), {
    target: { value: 'dev.example.com' },
  })
  fireEvent.change(screen.getByLabelText('SSH username'), {
    target: { value: 'developer' },
  })
  fireEvent.change(screen.getByLabelText('SSH private key'), {
    target: {
      value:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
    },
  })
}

describe('SSH connections', () => {
  test('saving requires a probed and explicitly confirmed server fingerprint', async () => {
    const props = callbacks()
    render(<SshConnections {...props} />)
    expect(screen.getByText('No SSH servers connected yet.')).toBeVisible()
    await fillKeyConnection()
    expect(
      screen.getByRole('button', { name: 'Connect and save' })
    ).toBeDisabled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    expect(props.onProbe).toHaveBeenCalledWith({
      host: 'dev.example.com',
      port: 22,
    })
    expect(await screen.findByText('SHA256:trusted-host-key')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Connect and save' })
    ).toBeDisabled()
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'I verified this server fingerprint.',
      })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Connect and save' })
    )
    await waitFor(() =>
      expect(props.onCreate).toHaveBeenCalledWith({
        name: 'Development server',
        host: 'dev.example.com',
        port: 22,
        username: 'developer',
        authType: 'key',
        fingerprint: 'SHA256:trusted-host-key',
        privateKey:
          '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
      })
    )
    expect(await screen.findByText('SSH server connected.')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Add SSH server' })
    )
    expect(screen.getByLabelText('SSH private key')).toHaveValue('')
  })

  test('changing the server address discards its previous fingerprint confirmation', async () => {
    render(<SshConnections {...callbacks()} />)
    await fillKeyConnection()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    await userEvent.click(
      await screen.findByRole('checkbox', {
        name: 'I verified this server fingerprint.',
      })
    )
    fireEvent.change(screen.getByLabelText('SSH port'), {
      target: { value: '2222' },
    })
    await waitFor(() =>
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    )
    expect(
      screen.getByRole('button', { name: 'Connect and save' })
    ).toBeDisabled()
  })

  test('closing clears credentials and prevents a late probe from restoring an old fingerprint', async () => {
    let finish!: (value: CodexSshProbe) => void
    const props = {
      ...callbacks(),
      onProbe: vi.fn(
        () =>
          new Promise<CodexSshProbe>((resolve) => {
            finish = resolve
          })
      ),
    }
    const view = render(<SshConnections {...props} active />)
    await fillKeyConnection()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    view.rerender(<SshConnections {...props} active={false} />)
    finish(probe)
    view.rerender(<SshConnections {...props} active />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Add SSH server' })
    )
    expect(screen.getByLabelText('SSH private key')).toHaveValue('')
    expect(screen.getByLabelText('SSH host')).toHaveValue('')
    expect(
      screen.queryByText('SHA256:trusted-host-key')
    ).not.toBeInTheDocument()
  })

  test('password authentication submits only the selected credential and reports login failures', async () => {
    const props = {
      ...callbacks(),
      onCreate: vi.fn(async () => {
        throw new Error('SSH authentication failed')
      }),
    }
    render(<SshConnections {...props} />)
    await fillKeyConnection()
    await userEvent.click(screen.getByRole('radio', { name: 'Password' }))
    expect(screen.queryByLabelText('SSH private key')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('SSH password'), {
      target: { value: 'fixture-password' },
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    await userEvent.click(
      await screen.findByRole('checkbox', {
        name: 'I verified this server fingerprint.',
      })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Connect and save' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'SSH authentication failed'
    )
    expect(props.onCreate).toHaveBeenCalledWith({
      name: 'Development server',
      host: 'dev.example.com',
      port: 22,
      username: 'developer',
      authType: 'password',
      password: 'fixture-password',
      fingerprint: 'SHA256:trusted-host-key',
    })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add SSH server' })
    )
    expect(screen.getByLabelText('SSH private key')).toHaveValue('')
  })

  test('removing a saved connection requires confirmation and retains a server rejected as in use', async () => {
    const props = {
      ...callbacks(),
      connections: [connection],
      onRemove: vi.fn(async () => {
        throw new Error('This server is used by a project.')
      }),
    }
    render(<SshConnections {...props} />)
    const card = within(
      screen.getByRole('article', { name: 'Development server' })
    )
    await userEvent.click(
      card.getByRole('button', { name: 'Remove SSH server' })
    )
    expect(props.onRemove).not.toHaveBeenCalled()
    await userEvent.click(card.getByRole('button', { name: 'Confirm removal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This server is used by a project.'
    )
    expect(card.getByText('developer@dev.example.com:22')).toBeVisible()
    expect(props.onRemove).toHaveBeenCalledWith('server-1')
  })

  test('testing a saved server displays its home directory and missing development tools', async () => {
    const props = {
      ...callbacks(),
      connections: [connection],
      onTest: vi.fn(async () => ({
        connected: true as const,
        home: '/home/developer',
        capabilities: { python: true, git: true, codex: false },
      })),
    }
    render(<SshConnections {...props} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Test connection' })
    )
    expect(
      await screen.findByText('Remote home: /home/developer')
    ).toBeVisible()
    expect(screen.getByText('Codex CLI: missing')).toBeVisible()
    expect(props.onTest).toHaveBeenCalledWith('server-1')
  })

  test('an invalid port prevents probing and shows a field error', async () => {
    const props = callbacks()
    render(<SshConnections {...props} />)
    await fillKeyConnection()
    fireEvent.change(screen.getByLabelText('SSH port'), {
      target: { value: '65536' },
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a port between 1 and 65535.'
    )
    expect(screen.getByLabelText('SSH port')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(props.onProbe).not.toHaveBeenCalled()
  })

  test('a failed fingerprint check preserves the form and offers a retry without enabling save', async () => {
    const props = {
      ...callbacks(),
      onProbe: vi
        .fn()
        .mockRejectedValueOnce(new Error('SSH server unreachable'))
        .mockResolvedValue(probe),
    }
    render(<SshConnections {...props} />)
    await fillKeyConnection()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'SSH server unreachable'
    )
    expect(
      screen.getByRole('button', { name: 'Connect and save' })
    ).toBeDisabled()
    expect(screen.getByLabelText('Connection name')).toHaveValue(
      'Development server'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    expect(
      await screen.findByRole('checkbox', {
        name: 'I verified this server fingerprint.',
      })
    ).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('choosing a different server key requires confirming that key again', async () => {
    const props = {
      ...callbacks(),
      onProbe: vi.fn(async () => ({
        ...probe,
        keys: [
          ...probe.keys,
          { type: 'rsa-sha2-512', fingerprint: 'SHA256:second-host-key' },
        ],
      })),
    }
    render(<SshConnections {...props} />)
    await fillKeyConnection()
    await userEvent.click(
      screen.getByRole('button', { name: 'Check server fingerprint' })
    )
    await userEvent.click(
      await screen.findByRole('checkbox', {
        name: 'I verified this server fingerprint.',
      })
    )
    await userEvent.click(screen.getByRole('radio', { name: /rsa-sha2-512/ }))
    expect(
      screen.getByRole('checkbox', {
        name: 'I verified this server fingerprint.',
      })
    ).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: 'Connect and save' })
    ).toBeDisabled()
  })

  test('cancelling the form returns keyboard focus to Add SSH server', async () => {
    render(<SshConnections {...callbacks()} />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Add SSH server' })
    )
    expect(screen.getByLabelText('Connection name')).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Add SSH server' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByLabelText('Connection name')).toHaveFocus()
  })

  test('disabled controls block mutations across several saved servers while names remain accessible', () => {
    const second = {
      ...connection,
      id: 'server-2',
      name: 'A remote server with a very long descriptive name for a production-like development environment',
    }
    render(
      <SshConnections
        {...callbacks()}
        disabled
        connections={[connection, second]}
      />
    )
    expect(screen.getByRole('article', { name: second.name })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Add SSH server' })
    ).toBeDisabled()
    for (const button of screen.getAllByRole('button', {
      name: 'Test connection',
    })) {
      expect(button).toBeDisabled()
    }
    for (const button of screen.getAllByRole('button', {
      name: 'Remove SSH server',
    })) {
      expect(button).toBeDisabled()
    }
  })

  test('loading shows progress and a list error allows retry', async () => {
    const props = callbacks()
    const view = render(<SshConnections {...props} loading />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading SSH servers...'
    )
    expect(
      screen.getByRole('button', { name: 'Refresh SSH servers' })
    ).toBeDisabled()
    view.rerender(<SshConnections {...props} error='Connection lost' />)
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost')
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh SSH servers' })
    )
    expect(props.onRefresh).toHaveBeenCalledOnce()
  })
})
