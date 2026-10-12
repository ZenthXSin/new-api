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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { WorkspaceList } from '../components/workspace-list'
import type { CodexProjectConversation } from '../types'
import { workspace } from './fixtures'

const conversations: CodexProjectConversation[] = [
  {
    id: 'plan',
    name: 'Plan a landing page',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    turnCount: 1,
  },
  {
    id: 'review',
    name: 'Review the checkout',
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    turnCount: 2,
  },
  {
    id: 'archive',
    name: 'Archived landing page',
    status: 'idle',
    archived: true,
    createdAt: 1,
    updatedAt: 1,
    turnCount: 1,
  },
]
function navigationProps() {
  return {
    workspaces: [workspace],
    expandedWorkspaceIds: [workspace.id],
    conversationsByWorkspace: { [workspace.id]: conversations },
    selected: workspace.id,
    conversationId: 'plan',
    open: true,
    onToggleWorkspace: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onCreate: vi.fn(),
    onSelect: vi.fn(),
    onConversation: vi.fn(),
    onBack: vi.fn(),
  }
}

describe('ChatGPT sidebar navigation', () => {
  test('compact shortcuts and bulk management stay reachable beside project history', async () => {
    const props = navigationProps()
    const onManage = vi.fn()
    const onEnvironments = vi.fn()
    const onConnections = vi.fn()
    render(
      <WorkspaceList
        {...props}
        onManage={onManage}
        onEnvironments={onEnvironments}
        onConnections={onConnections}
        onPullRequests={vi.fn()}
      />
    )
    const shortcuts = screen.getByRole('button', {
      name: 'Connections',
    }).parentElement
    expect(shortcuts).toContainElement(
      screen.getByRole('button', { name: 'Environments' })
    )
    expect(shortcuts).toContainElement(
      screen.getByRole('button', { name: 'Pull requests' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Manage projects and conversations' })
    )
    expect(onManage).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Environments' }))
    expect(onEnvironments).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Connections' }))
    expect(onConnections).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: 'Website project' })
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Collapse project Website project' })
    ).toHaveAttribute('aria-expanded', 'true')
  })
  test('the collapsed desktop rail keeps New task and Search tasks reachable by keyboard', async () => {
    const matchMedia = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query === '(min-width: 768px)',
    }))
    const onNewChat = vi.fn()
    const onSearch = vi.fn()
    render(
      <WorkspaceList
        {...navigationProps()}
        open={false}
        collapsed
        onNewChat={onNewChat}
        onSearch={onSearch}
      />
    )
    screen.getByRole('button', { name: 'Open project list' }).focus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'New task' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onNewChat).toHaveBeenCalledOnce()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Search tasks' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onSearch).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'Website project' })
    ).not.toBeInTheDocument()
  })

  test('the collapsed rail disables New task while project creation is unavailable', () => {
    const matchMedia = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query === '(min-width: 768px)',
    }))
    render(
      <WorkspaceList
        {...navigationProps()}
        open={false}
        collapsed
        createDisabled
        onNewChat={vi.fn()}
        onSearch={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Search tasks' })).toBeEnabled()
  })

  test('New task uses the global empty-chat entry when it is available', async () => {
    const props = navigationProps()
    const onNewChat = vi.fn()
    render(<WorkspaceList {...props} onNewChat={onNewChat} />)
    await userEvent.click(screen.getByRole('button', { name: /^New task$/ }))
    expect(onNewChat).toHaveBeenCalledOnce()
    expect(props.onNew).not.toHaveBeenCalled()
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  test('selecting an archived project reveals its history automatically', () => {
    const props = navigationProps()
    render(
      <WorkspaceList
        {...props}
        workspaces={[{ ...workspace, archived: true }]}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Website project' })
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('button', { name: 'Show archived projects' })
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('New task starts a conversation in the selected project', async () => {
    const props = navigationProps()
    render(<WorkspaceList {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /^New task$/ }))
    expect(props.onNew).toHaveBeenCalledWith(workspace.id)
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  test('New task opens project creation when no active project exists', async () => {
    const props = navigationProps()
    render(<WorkspaceList {...props} workspaces={[]} selected={undefined} />)
    await userEvent.click(screen.getByRole('button', { name: /^New task$/ }))
    expect(props.onCreate).toHaveBeenCalledOnce()
    expect(props.onNew).not.toHaveBeenCalled()
  })

  test('a running selected project disables New task until the run finishes', () => {
    const props = navigationProps()
    const { rerender } = render(
      <WorkspaceList
        {...props}
        workspaces={[{ ...workspace, status: 'running' }]}
      />
    )
    expect(screen.getByRole('button', { name: /^New task$/ })).toBeDisabled()
    rerender(<WorkspaceList {...props} />)
    expect(screen.getByRole('button', { name: /^New task$/ })).toBeEnabled()
  })

  test('the Search tasks entry opens the global search when supplied', async () => {
    const onSearch = vi.fn()
    render(<WorkspaceList {...navigationProps()} onSearch={onSearch} />)
    await userEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    expect(onSearch).toHaveBeenCalledOnce()
  })

  test('search finds conversation titles across active and archived history', async () => {
    const props = navigationProps()
    render(<WorkspaceList {...props} />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search projects' }),
      'landing'
    )
    expect(
      screen.getByRole('button', { name: 'Plan a landing page' })
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Archived landing page' })
    ).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Review the checkout' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Archived landing page' })
    )
    expect(props.onConversation).toHaveBeenCalledWith(workspace.id, 'archive')
  })

  test('typing a search loads previously collapsed project histories for matching', async () => {
    const onToggle = vi.fn()
    function Sidebar() {
      const [expanded, setExpanded] = useState<string[]>([])
      return (
        <WorkspaceList
          {...navigationProps()}
          expandedWorkspaceIds={expanded}
          conversationsByWorkspace={
            expanded.length ? { [workspace.id]: conversations } : {}
          }
          onToggleWorkspace={(id) => {
            onToggle(id)
            setExpanded((ids) => [...ids, id])
          }}
        />
      )
    }
    render(<Sidebar />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search projects' }),
      'checkout'
    )
    expect(onToggle).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: 'Review the checkout' })
    ).toBeVisible()
  })

  test('Escape clears a search without dismissing the mobile sidebar', async () => {
    const props = navigationProps()
    render(<WorkspaceList {...props} />)
    const input = screen.getByRole('textbox', { name: 'Search projects' })
    await userEvent.type(input, 'checkout')
    await userEvent.keyboard('{Escape}')
    expect(input).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Plan a landing page' })
    ).toBeVisible()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  test('project history puts the most recently updated chat first', () => {
    render(<WorkspaceList {...navigationProps()} />)
    const projectHistory = screen.getByRole('group', {
      name: 'Project conversations',
    })
    const rows = within(projectHistory).getAllByRole('group')
    expect(rows[0]).toHaveAccessibleName('Review the checkout')
    expect(rows[1]).toHaveAccessibleName('Plan a landing page')
    expect(
      screen.getByRole('button', { name: 'Plan a landing page' })
    ).toHaveAttribute('aria-current', 'page')
  })

  test('a conversation menu stays keyboard reachable and does not select its chat', async () => {
    const props = navigationProps()
    const onRenameConversation = vi.fn()
    render(
      <WorkspaceList {...props} onRenameConversation={onRenameConversation} />
    )
    const conversation = screen.getByRole('button', {
      name: 'Plan a landing page',
    })
    conversation.focus()
    await userEvent.tab()
    const actions = screen.getByRole('button', {
      name: 'Conversation actions for Plan a landing page',
    })
    expect(actions).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Rename conversation' })
    )
    expect(onRenameConversation).toHaveBeenCalledWith(
      workspace.id,
      conversations[0]
    )
    expect(props.onConversation).not.toHaveBeenCalled()
  })
})

describe('Codex Web navigation drawer', () => {
  test('the closed navigation drawer occupies no desktop sidebar', () => {
    const media = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...media(query),
      matches: query === '(min-width: 768px)',
    }))
    render(
      <WorkspaceList
        {...navigationProps()}
        presentation='drawer'
        open={false}
      />
    )
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Website project' })
    ).not.toBeInTheDocument()
  })

  test('desktop navigation opens a named modal with task and environment entries', async () => {
    const media = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...media(query),
      matches: query === '(min-width: 768px)',
    }))
    render(
      <WorkspaceList
        {...navigationProps()}
        presentation='drawer'
        tasks={<section aria-label='Tasks'>Recent tasks</section>}
        onEnvironments={vi.fn()}
        onSettings={vi.fn()}
        onSearch={vi.fn()}
        onConnections={vi.fn()}
      />
    )
    const dialog = screen.getByRole('dialog', { name: 'Codex projects' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Close project list' })
      ).toHaveFocus()
    )
    expect(within(dialog).getByRole('region', { name: 'Tasks' })).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Environments' })
    ).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Search tasks' })
    ).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'Website project' })
    ).toBeVisible()
    expect(
      within(dialog).getByRole('button', { name: 'New task' })
    ).toBeVisible()
  })

  test('drawer entries close navigation before calling their real destination', async () => {
    const actions: string[] = []
    render(
      <WorkspaceList
        {...navigationProps()}
        presentation='drawer'
        onClose={() => actions.push('close')}
        onEnvironments={() => actions.push('environments')}
        onSearch={() => actions.push('search')}
        onSettings={() => actions.push('settings')}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Environments' }))
    await userEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(actions).toEqual([
      'close',
      'environments',
      'close',
      'search',
      'close',
      'settings',
    ])
  })

  test('New task opens a draft while project navigation remains available', async () => {
    const onNewChat = vi.fn()
    render(<WorkspaceList {...navigationProps()} onNewChat={onNewChat} />)
    await userEvent.click(screen.getByRole('button', { name: 'New task' }))
    expect(onNewChat).toHaveBeenCalledOnce()
    expect(
      screen.getByRole('button', { name: 'Website project' })
    ).toBeVisible()
  })

  test('Escape closes the desktop drawer and restores its external menu button', async () => {
    const media = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...media(query),
      matches: query === '(min-width: 768px)',
    }))
    function Navigation() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type='button' onClick={() => setOpen(true)}>
            Open navigation
          </button>
          <WorkspaceList
            {...navigationProps()}
            presentation='drawer'
            open={open}
            onClose={() => setOpen(false)}
          />
        </>
      )
    }
    render(<Navigation />)
    const opener = screen.getByRole('button', { name: 'Open navigation' })
    await userEvent.click(opener)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Close project list' })
      ).toHaveFocus()
    )
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(opener).toHaveFocus()
  })
})

test('collapsing a project removes history from keyboard navigation and reopening restores it', async () => {
  function Sidebar() {
    const [expanded, setExpanded] = useState([workspace.id])
    return (
      <WorkspaceList
        {...navigationProps()}
        expandedWorkspaceIds={expanded}
        onToggleWorkspace={() =>
          setExpanded((ids) => (ids.length ? [] : [workspace.id]))
        }
      />
    )
  }
  render(<Sidebar />)
  const collapse = screen.getByRole('button', {
    name: 'Collapse project Website project',
  })
  await userEvent.click(collapse)
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Plan a landing page' })
    ).not.toBeInTheDocument()
  )
  expect(
    screen.getByRole('button', { name: 'Expand project Website project' })
  ).toHaveAttribute('aria-expanded', 'false')
  await userEvent.keyboard('{Enter}')
  expect(
    await screen.findByRole('button', { name: 'Plan a landing page' })
  ).toHaveAttribute('aria-current', 'page')
})

test('global task search is reachable from the sidebar header without a duplicate navigation row', async () => {
  const onSearch = vi.fn()
  render(<WorkspaceList {...navigationProps()} onSearch={onSearch} />)
  const search = screen.getByRole('button', { name: 'Search tasks' })
  expect(search.closest('header')).not.toBeNull()
  await userEvent.click(search)
  expect(onSearch).toHaveBeenCalledOnce()
})
