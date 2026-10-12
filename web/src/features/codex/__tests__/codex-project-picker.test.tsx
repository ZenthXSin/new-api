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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import {
  CodexBranchPicker,
  CodexProjectPicker,
} from '../components/codex-project-picker'
import type { CodexRepository } from '../types'
import { workspace } from './fixtures'

const repository: CodexRepository = {
  available: true,
  branch: 'release',
  head: 'a1b2c3d4e5f6',
  detached: false,
  dirty: false,
  checkoutSupported: true,
  checkoutReason: null,
  hasSubmodules: false,
  remotes: [{ name: 'origin', url: 'https://example.com/team/repository.git' }],
  branches: [
    { name: 'release', ref: 'refs/heads/release', remote: null, current: true },
    {
      name: 'feature/local',
      ref: 'refs/heads/feature/local',
      remote: null,
      current: false,
    },
    {
      name: 'feature/remote',
      ref: 'refs/remotes/origin/feature/remote',
      remote: 'origin',
      current: false,
    },
  ],
  branchesTruncated: false,
}

test('project search selects the exact project id and restores its trigger focus', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexProjectPicker
      workspaces={[workspace, { ...workspace, id: 'api', name: 'API service' }]}
      selected={workspace.id}
      onSelect={onSelect}
      onCreate={vi.fn()}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Choose project' })
  expect(trigger).toHaveTextContent(workspace.name)
  trigger.focus()
  await user.keyboard('{Enter}')
  const search = screen.getByRole('combobox', { name: 'Search projects' })
  await waitFor(() => expect(search).toHaveFocus())
  await user.type(search, 'API service')
  await user.keyboard('{Enter}')
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('api')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('projects on a remote server can be found by host or directory and preserve their exact id', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const remote = {
    ...workspace,
    id: 'remote-project',
    name: 'API service',
    remote: {
      connectionId: 'remote-connection',
      username: 'developer',
      host: 'build.example.com',
      path: '/srv/team/api',
    },
  }
  render(
    <CodexProjectPicker
      workspaces={[workspace, remote]}
      onSelect={onSelect}
      onCreate={vi.fn()}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Choose project' }))
  const search = screen.getByRole('combobox', { name: 'Search projects' })
  await user.type(search, 'build.example.com')
  expect(screen.getByRole('option', { name: /API service/ })).toHaveTextContent(
    'developer@build.example.com:/srv/team/api'
  )
  expect(
    screen.queryByRole('option', { name: workspace.name })
  ).not.toBeInTheDocument()
  await user.clear(search)
  await user.type(search, '/srv/team/api')
  await user.keyboard('{Enter}')
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('remote-project')
})

test('blank workspaces and new projects invoke distinct real actions', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const onCreate = vi.fn()
  render(
    <CodexProjectPicker
      workspaces={[]}
      onSelect={onSelect}
      onCreate={onCreate}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Choose project' })
  await user.click(trigger)
  await user.click(screen.getByRole('option', { name: 'Blank workspace' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(onCreate).not.toHaveBeenCalled()
  await user.click(trigger)
  await user.click(screen.getByRole('option', { name: 'New project' }))
  expect(onCreate).toHaveBeenCalledOnce()
  expect(onSelect).toHaveBeenCalledOnce()
})

test('project menus hide archived projects and show only authorized connection actions', async () => {
  const user = userEvent.setup()
  const onConnections = vi.fn()
  render(
    <CodexProjectPicker
      workspaces={[{ ...workspace, archived: true }]}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onConnections={onConnections}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Choose project' }))
  expect(
    screen.queryByRole('option', { name: workspace.name })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('option', { name: 'Connections' }))
  expect(onConnections).toHaveBeenCalledOnce()
})

test('loading project lists expose progress without stale project choices', async () => {
  const user = userEvent.setup()
  render(
    <CodexProjectPicker
      workspaces={[workspace]}
      loading
      onSelect={vi.fn()}
      onCreate={vi.fn()}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Choose project' }))
  expect(screen.getByRole('status')).toHaveTextContent('Loading projects…')
  expect(
    screen.queryByRole('option', { name: workspace.name })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('option', { name: 'Connections' })
  ).not.toBeInTheDocument()
})

test('Escape preserves the project selection and resets search before reopening', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexProjectPicker
      workspaces={[workspace]}
      onSelect={onSelect}
      onCreate={vi.fn()}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Choose project' })
  await user.click(trigger)
  await user.type(
    screen.getByRole('combobox', { name: 'Search projects' }),
    'missing-project'
  )
  expect(screen.getByText('No matching projects')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(onSelect).not.toHaveBeenCalled()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('combobox', { name: 'Search projects' })).toHaveValue(
    ''
  )
})

test.each([{ disabled: true }, { disabled: true, loading: true }])(
  'disabled project controls cannot open: %j',
  (state) => {
    render(
      <CodexProjectPicker
        workspaces={[workspace]}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        {...state}
      />
    )
    expect(
      screen.getByRole('combobox', { name: 'Choose project' })
    ).toBeDisabled()
  }
)

test('remote branch selection passes the unprefixed branch name and the remote separately', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<CodexBranchPicker repository={repository} onSelect={onSelect} />)
  const trigger = screen.getByRole('combobox', { name: 'Select branch' })
  expect(trigger).toHaveTextContent('release')
  await user.click(trigger)
  expect(screen.getByRole('option', { name: 'release' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  await user.type(
    screen.getByRole('combobox', { name: 'Search branches' }),
    'feature/remote'
  )
  await user.keyboard('{Enter}')
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('feature/remote', 'origin')
  await waitFor(() => expect(trigger).toHaveFocus())
})

test('local branch selection never invents a remote or a main branch', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<CodexBranchPicker repository={repository} onSelect={onSelect} />)
  await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
  expect(screen.queryByRole('option', { name: 'main' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('option', { name: 'feature/local' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('feature/local', undefined)
})

test('dirty repositories explain why branch changes are disabled and never dispatch checkout', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexBranchPicker
      repository={{ ...repository, dirty: true }}
      onSelect={onSelect}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
  expect(screen.getByRole('status')).toHaveTextContent(
    'Commit or stash your changes before switching branches.'
  )
  const option = screen.getByRole('option', { name: 'feature/local' })
  expect(option).toHaveAttribute('aria-disabled', 'true')
  await user.click(option)
  expect(onSelect).not.toHaveBeenCalled()
})

test.each([
  {
    checkoutReason: 'submodules' as const,
    message: 'Switch branches locally for repositories with submodules.',
  },
  {
    checkoutReason: 'operation_in_progress' as const,
    message: 'Finish the Git operation before switching branches.',
  },
])(
  'repository capability $checkoutReason prevents checkout with an accurate explanation',
  async ({ checkoutReason, message }) => {
    const user = userEvent.setup()
    render(
      <CodexBranchPicker
        repository={{ ...repository, checkoutSupported: false, checkoutReason }}
        onSelect={vi.fn()}
      />
    )
    await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(
      screen.getByRole('option', { name: 'feature/local' })
    ).toHaveAttribute('aria-disabled', 'true')
  }
)

test('non Git projects explain their state without offering fake branch choices', async () => {
  const user = userEvent.setup()
  render(
    <CodexBranchPicker
      repository={{
        ...repository,
        available: false,
        branch: null,
        branches: [],
      }}
      onSelect={vi.fn()}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
  expect(screen.getByRole('status')).toHaveTextContent(
    'This project is not a Git repository.'
  )
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
})

test('an unselected project asks for selection without guessing repository state', async () => {
  const user = userEvent.setup()
  render(<CodexBranchPicker onSelect={vi.fn()} />)
  await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
  expect(screen.getByRole('status')).toHaveTextContent(
    'Choose a project to view branches.'
  )
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
})

test('repository loading and errors hide stale branches and provide a working retry', async () => {
  const user = userEvent.setup()
  const onRetry = vi.fn()
  const view = render(
    <CodexBranchPicker
      repository={repository}
      loading
      onRetry={onRetry}
      onSelect={vi.fn()}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
  expect(screen.getByRole('status')).toHaveTextContent('Loading branches…')
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  view.rerender(
    <CodexBranchPicker
      repository={repository}
      error
      onRetry={onRetry}
      onSelect={vi.fn()}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Branches could not be loaded.'
  )
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledOnce()
  expect(
    screen.queryByRole('option', { name: 'feature/local' })
  ).not.toBeInTheDocument()
})

test('a backend branch error stays visible after filtering and retry invokes recovery', async () => {
  const user = userEvent.setup()
  const retry = vi.fn()
  const view = render(
    <CodexBranchPicker repository={repository} onSelect={vi.fn()} />
  )
  await user.click(screen.getByRole('combobox', { name: 'Select branch' }))
  await user.type(
    screen.getByRole('combobox', { name: 'Search branches' }),
    'feature'
  )
  view.rerender(
    <CodexBranchPicker
      repository={repository}
      error='unsupported_repository'
      onRetry={retry}
      onSelect={vi.fn()}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('unsupported_repository')
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retry).toHaveBeenCalledOnce()
})

test('detached repositories display their real short commit and disclose truncated branches', async () => {
  const user = userEvent.setup()
  render(
    <CodexBranchPicker
      repository={{
        ...repository,
        detached: true,
        branch: null,
        branchesTruncated: true,
      }}
      onSelect={vi.fn()}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Select branch' })
  expect(trigger).toHaveTextContent('a1b2c3d')
  await user.click(trigger)
  expect(screen.getByText('Detached HEAD')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent(
    'Some branches are not shown.'
  )
  await user.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
})
