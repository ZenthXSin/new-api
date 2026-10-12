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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { EnvironmentPanel } from '../components/environment-panel'
import { environment } from './fixtures'

const panelProps = {
  loading: false,
  unavailable: false,
  pending: null,
  onStart: vi.fn(),
  onStop: vi.fn(),
  onRetry: vi.fn(),
  onSelect: vi.fn(),
}

describe('Environment settings', () => {
  test('a new Docker environment offers creation and starts with the keyboard', async () => {
    const onStart = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, status: 'not_created', projectCount: 0 }}
        onStart={onStart}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Docker environment' })
    ).toBeVisible()
    expect(screen.getByText('Hosted on this server')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Environment not created'
    )
    const create = screen.getByRole('button', {
      name: 'Create and start environment',
    })
    expect(create).toHaveAccessibleDescription(
      'Your environment will be created when you start it or send your first task.'
    )
    expect(create).toHaveClass('max-w-full', 'whitespace-normal')
    expect(
      screen.queryByRole('button', { name: 'Stop environment' })
    ).not.toBeInTheDocument()
    await userEvent.tab()
    expect(create).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onStart).toHaveBeenCalledOnce()
    expect(panelProps.onSelect).not.toHaveBeenCalled()
  })

  test('a failed environment offers another start attempt alongside stop recovery', async () => {
    const onStart = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          status: 'error',
          lastError: 'Unable to start the environment',
        }}
        onStart={onStart}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Environment error')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to start the environment'
    )
    expect(
      screen.getByRole('button', { name: 'Stop environment' })
    ).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Retry start' }))
    expect(onStart).toHaveBeenCalledOnce()
  })

  test('stopping a failed environment hides start recovery until stopping finishes', () => {
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, status: 'error' }}
        pending='stop'
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Stopping environment...'
    )
    expect(
      screen.getByRole('button', { name: 'Stop environment' })
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /Start environment|Retry start/ })
    ).not.toBeInTheDocument()
  })

  test('missing percentage limits display actual allocations without inventing usage', () => {
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          limits: {
            cpus: 1.5,
            memoryBytes: 3 * 1024 ** 3,
            diskBytes: 20 * 1024 ** 3,
          },
        }}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Resource limits' })
    ).toBeVisible()
    expect(screen.getByText('1.5 vCPU')).toBeVisible()
    expect(screen.getByText('3,072 MB')).toBeVisible()
    expect(screen.getByText('20 GiB')).toBeVisible()
    expect(screen.queryByText(/5%/)).not.toBeInTheDocument()
  })

  test('memory displays an MB allocation even when an old server returns a percentage', () => {
    const limits = {
      ...environment.limits,
      memoryBytes: 1536 * 1024 ** 2,
      memoryPercent: 10,
    }
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, limits }}
      />
    )
    expect(screen.getByText('1,536 MB')).toBeVisible()
    expect(screen.queryByText(/10%/)).not.toBeInTheDocument()
  })

  test('Docker details display the network policy and persistent storage returned by the runtime', () => {
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          runtime: 'docker',
          network: {
            mode: 'bridge',
            internetAccess: 'enabled',
            policyEditable: false,
          },
          persistentStorage: true,
          filesystemIsolation: 'user',
        }}
      />
    )
    expect(
      screen.getByRole('heading', { name: 'Runtime details' })
    ).toBeVisible()
    expect(screen.getByText('Dedicated Docker bridge')).toBeVisible()
    expect(
      screen.getByText('Internet access is allowed by the runtime policy.')
    ).toBeVisible()
    expect(
      screen.getByText('Network policy is managed by your administrator.')
    ).toBeVisible()
    expect(
      screen.getByText('Files are kept when the environment stops.')
    ).toBeVisible()
    expect(
      screen.getByText('Projects share your personal environment.')
    ).toBeVisible()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  test('an older runtime response does not invent network or isolation capabilities', () => {
    render(<EnvironmentPanel {...panelProps} environment={environment} />)
    expect(
      screen.queryByRole('heading', { name: 'Runtime details' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Dedicated Docker bridge')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Internet access is allowed by the runtime policy.')
    ).not.toBeInTheDocument()
  })

  test('loading a known environment blocks actions until its status is current', async () => {
    const onStart = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={environment}
        loading
        onStart={onStart}
      />
    )
    expect(
      screen.getByRole('region', { name: 'Personal environment' })
    ).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading environment...'
    )
    const start = screen.getByRole('button', { name: 'Start environment' })
    expect(start).toBeDisabled()
    await userEvent.click(start)
    expect(onStart).not.toHaveBeenCalled()
  })

  test('stopping keeps the stop control disabled until the server responds', async () => {
    const onStop = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, status: 'running' }}
        pending='stop'
        onStop={onStop}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Stopping environment...'
    )
    const stop = screen.getByRole('button', { name: 'Stop environment' })
    expect(stop).toBeDisabled()
    await userEvent.click(stop)
    expect(onStop).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: 'Start environment' })
    ).not.toBeInTheDocument()
  })

  test('a locally running task blocks stopping before the environment poll catches up', async () => {
    const onStop = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, status: 'running' }}
        taskRunning
        onStop={onStop}
      />
    )
    const stop = screen.getByRole('button', { name: 'Stop environment' })
    expect(stop).toBeDisabled()
    expect(stop).toHaveAccessibleDescription(
      'Stop the active task before stopping your environment.'
    )
    await userEvent.click(stop)
    expect(onStop).not.toHaveBeenCalled()
  })

  test('opening the active project selects the conversation running the task', async () => {
    const onSelect = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          status: 'running',
          activeWorkspaceId: 'project-2',
          activeWorkspaceName: 'API service',
          activeConversationId: 'conversation-3',
        }}
        onSelect={onSelect}
      />
    )
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /API service/ })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('project-2', 'conversation-3')
  })

  test('missing environment data offers a retry instead of an unusable start action', async () => {
    const onRetry = vi.fn()
    render(<EnvironmentPanel {...panelProps} onRetry={onRetry} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Environment unavailable'
    )
    expect(
      screen.queryByRole('button', { name: 'Start environment' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Retry environment' })
    )
    expect(onRetry).toHaveBeenCalledOnce()
  })

  test('a failed poll of a starting environment allows refreshing its stale status', async () => {
    const onRetry = vi.fn()
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{ ...environment, status: 'starting' }}
        unavailable
        error='Connection lost'
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Environment unavailable'
    )
    const retry = screen.getByRole('button', { name: 'Retry environment' })
    expect(retry).toBeEnabled()
    expect(retry).toHaveAccessibleDescription(
      'Refresh environment status to reconnect and try again.'
    )
    await userEvent.click(retry)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  test('long active project names remain accessible without expanding the settings panel', async () => {
    const onSelect = vi.fn()
    const name =
      'customer-portal-application-release-review-with-international-payment-integrations'
    render(
      <EnvironmentPanel
        {...panelProps}
        environment={{
          ...environment,
          status: 'running',
          activeWorkspaceId: 'project-2',
          activeConversationId: 'review-conversation',
          activeWorkspaceName: name,
        }}
        onSelect={onSelect}
      />
    )
    const activeProject = screen.getByRole('button', {
      name: `Active project: ${name}`,
    })
    expect(screen.getByText(name)).toHaveClass('truncate')
    expect(screen.getByText(name)).toHaveAttribute('title', name)
    expect(activeProject).toHaveClass('min-w-0', 'w-full')
    await userEvent.tab()
    expect(activeProject).toHaveFocus()
    await userEvent.keyboard(' ')
    expect(onSelect).toHaveBeenCalledWith('project-2', 'review-conversation')
  })
})
