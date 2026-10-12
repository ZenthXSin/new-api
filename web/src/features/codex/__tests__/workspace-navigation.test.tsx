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
import i18next from 'i18next'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'

import zh from '@/i18n/locales/zh.json'

import { ProjectTime, WorkspaceList } from '../components/workspace-list'
import { workspace } from './fixtures'

const props = {
  workspaces: [
    workspace,
    { ...workspace, id: 'old', name: 'Archived project', archived: true },
  ],
  expandedWorkspaceIds: [] as string[],
  onToggleWorkspace: vi.fn(),
  open: true,
  onClose: vi.fn(),
  onNew: vi.fn(),
  onSelect: vi.fn(),
  onBack: vi.fn(),
}
describe('Codex project navigation', () => {
  test('Chinese project timestamps render with the site language code', async () => {
    const previous = i18next.language
    try {
      await i18next.changeLanguage('zhCN')
      render(<ProjectTime value={Date.now() - 3600_000} />)
      expect(screen.getByText(/1.*小时/)).toHaveAttribute('datetime')
    } finally {
      await i18next.changeLanguage(previous)
    }
  })
  test('projects share one compact list, retain running status, and the section can collapse without hiding recent tasks', async () => {
    render(
      <WorkspaceList
        {...props}
        tasks={<p>Recent task fixture</p>}
        workspaces={[
          {
            ...workspace,
            id: 'active',
            name: 'API service',
            status: 'running',
            updatedAt: Date.now(),
          },
          { ...workspace, updatedAt: Date.now() - 3600_000 },
        ]}
      />
    )
    expect(screen.getByRole('button', { name: 'API service' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Website project' })
    ).toBeVisible()
    expect(screen.getByLabelText('Running')).toBeVisible()
    expect(
      screen.queryByRole('region', { name: 'Recent projects' })
    ).not.toBeInTheDocument()
    const section = screen.getByRole('button', { name: /^Projects$/ })
    expect(section).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(section)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Website project' })
      ).not.toBeInTheDocument()
    )
    expect(screen.getByText('Recent task fixture')).toBeVisible()
    await userEvent.click(section)
    expect(
      await screen.findByRole('button', { name: 'Website project' })
    ).toBeVisible()
  })
  test('clearing a project search restores the list and keyboard Escape closes the mobile drawer', async () => {
    const onClose = vi.fn()
    render(<WorkspaceList {...props} onClose={onClose} />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search projects' }),
      'missing'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear project search' })
    )
    expect(
      screen.getByRole('textbox', { name: 'Search projects' })
    ).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Website project' })
    ).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })
  test('the selected project is accessible and archived projects are separated', async () => {
    render(<WorkspaceList {...props} selected={workspace.id} />)
    expect(
      screen.getByRole('button', { name: 'Website project' })
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.queryByRole('button', { name: 'Archived project' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Show archived projects' })
    )
    expect(
      screen.getByRole('button', { name: 'Show archived projects' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'Archived project' })
    ).toBeVisible()
  })
  test('one project contains independently selectable conversations', async () => {
    const onConversation = vi.fn()
    const conversations = [
      {
        id: 'conversation-one',
        name: 'Planning',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        turnCount: 2,
      },
      {
        id: 'conversation-two',
        name: 'Implementation',
        status: 'running',
        createdAt: 2,
        updatedAt: 2,
        turnCount: 1,
      },
    ]
    render(
      <WorkspaceList
        {...props}
        selected={workspace.id}
        conversationId='conversation-one'
        expandedWorkspaceIds={[workspace.id]}
        conversationsByWorkspace={{ [workspace.id]: conversations }}
        onConversation={onConversation}
      />
    )
    expect(screen.getByRole('button', { name: 'Planning' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByRole('button', { name: 'Implementation' })).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Implementation' })
    )
    expect(onConversation).toHaveBeenCalledWith(
      workspace.id,
      'conversation-two'
    )
    expect(
      screen.getAllByRole('button', {
        name: 'New conversation in Website project',
      })
    ).toHaveLength(1)
  })
  test('the collapsed desktop rail has a control to restore the project list', async () => {
    const media = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...media(query),
      matches: query === '(min-width: 768px)',
    }))
    const onToggle = vi.fn()
    render(
      <WorkspaceList {...props} open={false} collapsed onToggle={onToggle} />
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Open project list' })
    )
    expect(onToggle).toHaveBeenCalledOnce()
  })
  test('search filters names and displays an explicit no-match state', async () => {
    render(<WorkspaceList {...props} />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search projects' }),
      'unknown'
    )
    expect(screen.getByText('No matching projects.')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Website project' })
    ).not.toBeInTheDocument()
  })
  test('project arrows expand independently while clicking a project name only selects it', async () => {
    const onSelect = vi.fn()
    function Navigation() {
      const [expanded, setExpanded] = useState<string[]>([])
      return (
        <WorkspaceList
          {...props}
          workspaces={[
            workspace,
            { ...workspace, id: 'project-two', name: 'Second project' },
          ]}
          expandedWorkspaceIds={expanded}
          onToggleWorkspace={(id) =>
            setExpanded((current) =>
              current.includes(id)
                ? current.filter((entry) => entry !== id)
                : [...current, id]
            )
          }
          onSelect={onSelect}
          conversationsByWorkspace={{
            [workspace.id]: [
              {
                id: 'planning',
                name: 'Planning',
                status: 'idle',
                createdAt: 1,
                updatedAt: 1,
                turnCount: 0,
              },
            ],
            'project-two': [
              {
                id: 'review',
                name: 'Review',
                status: 'idle',
                createdAt: 1,
                updatedAt: 1,
                turnCount: 0,
              },
            ],
          }}
        />
      )
    }
    render(<Navigation />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Expand project Website project' })
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Expand project Second project' })
    )
    expect(screen.getByRole('button', { name: 'Planning' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review' })).toBeVisible()
    expect(onSelect).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Website project' })
    )
    expect(onSelect).toHaveBeenCalledWith(workspace.id)
    expect(
      screen.getByRole('button', { name: 'Collapse project Website project' })
    ).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse project Website project' })
    )
    expect(
      screen.queryByRole('button', { name: 'Planning' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review' })).toBeVisible()
  })
  test('each project places its new conversation button after project actions and passes that project id', async () => {
    const onNew = vi.fn()
    render(
      <WorkspaceList
        {...props}
        onNew={onNew}
        renderProjectActions={(entry) => (
          <button type='button' aria-label={`Actions for ${entry.name}`}>
            ...
          </button>
        )}
      />
    )
    const actions = screen.getByRole('button', {
      name: 'Actions for Website project',
    })
    actions.focus()
    await userEvent.tab()
    const create = screen.getByRole('button', {
      name: 'New conversation in Website project',
    })
    expect(create).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onNew).toHaveBeenCalledWith(workspace.id)
    expect(
      screen.queryByRole('button', { name: 'New conversation' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Projects$/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
  test('conversation menus rename archive and request deletion for the correct project without selecting it', async () => {
    const conversation = {
      id: 'planning',
      name: 'Planning',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      turnCount: 0,
    }
    const onRenameConversation = vi.fn(),
      onArchiveConversation = vi.fn(),
      onDeleteConversation = vi.fn(),
      onConversation = vi.fn()
    render(
      <WorkspaceList
        {...props}
        expandedWorkspaceIds={[workspace.id]}
        conversationsByWorkspace={{ [workspace.id]: [conversation] }}
        onConversation={onConversation}
        onRenameConversation={onRenameConversation}
        onArchiveConversation={onArchiveConversation}
        onDeleteConversation={onDeleteConversation}
      />
    )
    const trigger = screen.getByRole('button', {
      name: 'Conversation actions for Planning',
    })
    await userEvent.click(trigger)
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Rename conversation' })
    )
    expect(onRenameConversation).toHaveBeenCalledWith(
      workspace.id,
      conversation
    )
    await userEvent.click(trigger)
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Archive conversation' })
    )
    expect(onArchiveConversation).toHaveBeenCalledWith(
      workspace.id,
      conversation
    )
    await userEvent.click(trigger)
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Delete conversation' })
    )
    expect(onDeleteConversation).toHaveBeenCalledWith(
      workspace.id,
      conversation
    )
    expect(onConversation).not.toHaveBeenCalled()
  })
  test('archived conversations stay separate and their menu offers restore', async () => {
    const conversation = {
      id: 'old-chat',
      name: 'Earlier discussion',
      status: 'idle',
      archived: true,
      createdAt: 1,
      updatedAt: 1,
      turnCount: 1,
    }
    const onArchiveConversation = vi.fn()
    render(
      <WorkspaceList
        {...props}
        expandedWorkspaceIds={[workspace.id]}
        conversationsByWorkspace={{ [workspace.id]: [conversation] }}
        onArchiveConversation={onArchiveConversation}
      />
    )
    expect(
      screen.queryByRole('button', { name: 'Earlier discussion' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('No conversations yet.')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Show archived conversations' })
    )
    expect(
      screen.getByRole('button', { name: 'Earlier discussion' })
    ).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Conversation actions for Earlier discussion',
      })
    )
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Restore conversation' })
    )
    expect(onArchiveConversation).toHaveBeenCalledWith(
      workspace.id,
      conversation
    )
  })
  test('running conversations disable destructive actions and keyboard Escape returns focus to their menu', async () => {
    const onClose = vi.fn()
    render(
      <WorkspaceList
        {...props}
        onClose={onClose}
        expandedWorkspaceIds={[workspace.id]}
        conversationsByWorkspace={{
          [workspace.id]: [
            {
              id: 'active-chat',
              name: 'Active discussion',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              turnCount: 1,
            },
          ],
        }}
        onRenameConversation={vi.fn()}
        onArchiveConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', {
      name: 'Conversation actions for Active discussion',
    })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(
      screen.getByRole('menuitem', { name: 'Archive conversation' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('menuitem', { name: 'Delete conversation' })
    ).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
  })
  test('expanded projects show loading errors retry and empty archived results locally', async () => {
    const onRetryConversations = vi.fn()
    const { rerender } = render(
      <WorkspaceList
        {...props}
        expandedWorkspaceIds={[workspace.id]}
        loadingWorkspaceIds={[workspace.id]}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading conversations...'
    )
    rerender(
      <WorkspaceList
        {...props}
        expandedWorkspaceIds={[workspace.id]}
        conversationErrors={{ [workspace.id]: 'Network unavailable' }}
        onRetryConversations={onRetryConversations}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryConversations).toHaveBeenCalledWith(workspace.id)
    rerender(
      <WorkspaceList
        {...props}
        expandedWorkspaceIds={[workspace.id]}
        conversationsByWorkspace={{ [workspace.id]: [] }}
      />
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Show archived conversations' })
    )
    expect(screen.getByText('No archived conversations.')).toBeVisible()
  })

  test('an archived conversation loaded after expansion remains visible when it is selected', () => {
    const { rerender } = render(
      <WorkspaceList
        {...props}
        selected={workspace.id}
        conversationId='archived-chat'
        expandedWorkspaceIds={[workspace.id]}
        loadingWorkspaceIds={[workspace.id]}
      />
    )
    rerender(
      <WorkspaceList
        {...props}
        selected={workspace.id}
        conversationId='archived-chat'
        expandedWorkspaceIds={[workspace.id]}
        conversationsByWorkspace={{
          [workspace.id]: [
            {
              id: 'archived-chat',
              name: 'Earlier discussion',
              archived: true,
              status: 'idle',
              createdAt: 1,
              updatedAt: 1,
              turnCount: 1,
            },
          ],
        }}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Earlier discussion' })
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('button', { name: 'Show active conversations' })
    ).toHaveAttribute('aria-pressed', 'true')
  })
  test('Chinese labels translate generated conversation names and preserve custom names', async () => {
    const previous = i18next.language
    i18next.addResourceBundle('zhCN', 'translation', zh.translation)
    try {
      await i18next.changeLanguage('zhCN')
      render(
        <WorkspaceList
          {...props}
          expandedWorkspaceIds={[workspace.id]}
          conversationsByWorkspace={{
            [workspace.id]: [
              {
                id: 'new',
                name: 'New conversation',
                customName: false,
                status: 'idle',
                createdAt: 1,
                updatedAt: 1,
                turnCount: 0,
              },
              {
                id: 'custom',
                name: 'New conversation',
                customName: true,
                status: 'idle',
                createdAt: 1,
                updatedAt: 1,
                turnCount: 0,
              },
              {
                id: 'root',
                name: 'Conversation 1',
                status: 'idle',
                createdAt: 1,
                updatedAt: 1,
                turnCount: 0,
              },
            ],
          }}
        />
      )
      expect(screen.getByRole('button', { name: '新对话' })).toBeVisible()
      expect(
        screen.getByRole('button', { name: 'New conversation' })
      ).toBeVisible()
      expect(screen.getByRole('button', { name: '对话 1' })).toBeVisible()
    } finally {
      await i18next.changeLanguage(previous)
      i18next.removeResourceBundle('zhCN', 'translation')
    }
  })
})
