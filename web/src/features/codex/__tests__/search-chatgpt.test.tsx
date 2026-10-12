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

import {
  ChatGPTSearch,
  type CodexSearchResult,
} from '../components/chatgpt-search'
import type { CodexProjectConversation } from '../types'
import { workspace } from './fixtures'

const workspaces = [
  workspace,
  { ...workspace, id: 'backend', name: 'Backend service' },
]
const conversationsByWorkspace: Record<string, CodexProjectConversation[]> = {
  [workspace.id]: [
    {
      id: 'planning',
      name: 'Plan homepage',
      status: 'idle',
      createdAt: 1,
      updatedAt: 5,
      turnCount: 2,
    },
    {
      id: 'older',
      name: 'Review routes',
      archived: true,
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      turnCount: 2,
    },
  ],
  backend: [
    {
      id: 'api',
      name: 'Review routes',
      status: 'idle',
      createdAt: 3,
      updatedAt: 9,
      turnCount: 1,
    },
  ],
}

function SearchHarness(props: {
  onSelect?: (workspaceId: string, conversationId?: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>
        Open search
      </button>
      <ChatGPTSearch
        open={open}
        onOpenChange={setOpen}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        onSelect={props.onSelect ?? (() => undefined)}
      />
    </>
  )
}

describe('Codex task search', () => {
  test('opening search focuses the input and orders loaded chats by most recent update with project context', async () => {
    render(<SearchHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    expect(screen.getByRole('dialog', { name: 'Search tasks' })).toBeVisible()
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Search tasks' })
      ).toHaveFocus()
    )
    const results = screen.getAllByRole('option')
    expect(results).toHaveLength(3)
    expect(results[0]).toHaveTextContent('Review routesBackend service')
    expect(results[1]).toHaveTextContent('Plan homepageWebsite project')
    expect(results[2]).toHaveTextContent('Review routesWebsite projectArchived')
  })

  test('typing filters chat titles immediately without matching case or surrounding spaces', async () => {
    render(<SearchHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    await userEvent.type(screen.getByRole('combobox'), ' HOMEPAGE ')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Plan homepage')
  })

  test('searching a project name returns its chats and a direct project result', async () => {
    const onSelect = vi.fn()
    render(<SearchHarness onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    await userEvent.type(screen.getByRole('combobox'), 'backend')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Projects' })).getByRole(
        'option'
      )
    )
    expect(onSelect).toHaveBeenCalledWith('backend', undefined)
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  })

  test('arrow keys change the selected chat and Enter closes search before navigating to the correct conversation', async () => {
    const events: string[] = []
    const onSelect = vi.fn((workspaceId: string, conversationId?: string) =>
      events.push(`${workspaceId}/${conversationId}`)
    )
    const onOpenChange = vi.fn((open: boolean) => events.push(`open:${open}`))
    render(
      <ChatGPTSearch
        open
        onOpenChange={onOpenChange}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        onSelect={onSelect}
      />
    )
    const input = screen.getByRole('combobox')
    await waitFor(() => expect(input).toHaveFocus())
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}')
    expect(onSelect).toHaveBeenCalledWith(workspace.id, 'planning')
    expect(events).toEqual(['open:false', `${workspace.id}/planning`])
  })

  test('clicking an archived chat selects its own project and conversation even when another chat shares its title', async () => {
    const onSelect = vi.fn()
    render(<SearchHarness onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    await userEvent.type(screen.getByRole('combobox'), 'Review routes')
    await userEvent.click(
      screen.getByRole('option', { name: /Website projectArchived/ })
    )
    expect(onSelect).toHaveBeenCalledWith(workspace.id, 'older')
  })

  test('filtering after a keyboard selection resets Enter to a matching chat instead of the now hidden chat', async () => {
    const onSelect = vi.fn()
    render(<SearchHarness onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    await userEvent.type(screen.getByRole('combobox'), 'homepage')
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(workspace.id, 'planning')
  })

  test('Escape closes the dialog and reopening clears the previous query', async () => {
    render(<SearchHarness />)
    const trigger = screen.getByRole('button', { name: 'Open search' })
    await userEvent.click(trigger)
    await userEvent.type(screen.getByRole('combobox'), 'homepage')
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(trigger).toHaveFocus())
    await userEvent.click(trigger)
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  test('the close button dismisses search without selecting a result', async () => {
    const onSelect = vi.fn()
    render(<SearchHarness onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close search' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('a query with no title or project match shows an honest empty state and Enter performs no navigation', async () => {
    const onSelect = vi.fn()
    render(<SearchHarness onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open search' }))
    await userEvent.type(
      screen.getByRole('combobox'),
      'not loaded message body'
    )
    expect(screen.getByRole('status')).toHaveTextContent('No tasks found')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await userEvent.keyboard('{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      'Searches loaded task titles and project names.'
    )
  })

  test('loading preserves available matches and does not announce an empty result prematurely', () => {
    render(
      <ChatGPTSearch
        open
        loading
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading tasks...'
    )
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })

  test('a workspace without loaded conversations offers only its real project and never invents a chat', () => {
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={[workspace]}
        conversationsByWorkspace={{}}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(
      within(screen.getByRole('group', { name: 'Projects' })).getByRole(
        'option'
      )
    ).toHaveTextContent(workspace.name)
    expect(screen.queryByText('Recent tasks')).not.toBeInTheDocument()
  })

  test('an account with no projects or conversations shows the initial empty state', () => {
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={[]}
        conversationsByWorkspace={{}}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'No tasks yet.'
    )
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})

describe('Codex server task search', () => {
  const remoteResult: CodexSearchResult = {
    id: 'message:backend:api',
    workspaceId: 'backend',
    workspaceName: 'Backend service',
    conversationId: 'api',
    conversationName: 'Review routes',
    workspaceArchived: false,
    conversationArchived: true,
    matchType: 'message',
    snippet: 'The response includes <script>alert(1)</script> as plain text.',
    turnId: 'turn-6',
    role: 'assistant',
    updatedAt: 9,
  }

  test('opening with an initial query requests its results once without overwriting later typing', async () => {
    const onQueryChange = vi.fn()
    const props = {
      onOpenChange: vi.fn(),
      workspaces,
      conversationsByWorkspace,
      onSelect: vi.fn(),
      onQueryChange,
      remoteResults: [],
    }
    const view = render(
      <ChatGPTSearch {...props} open initialQuery='response' />
    )
    expect(screen.getByRole('combobox')).toHaveValue('response')
    expect(onQueryChange).toHaveBeenCalledWith('response')
    await userEvent.type(screen.getByRole('combobox'), ' headers')
    view.rerender(
      <ChatGPTSearch {...props} open initialQuery='different query' />
    )
    expect(screen.getByRole('combobox')).toHaveValue('response headers')
    expect(onQueryChange).toHaveBeenLastCalledWith('response headers')
  })

  test('clearing a query with the clear control restores recent tasks and focuses the search input', async () => {
    const onQueryChange = vi.fn()
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[remoteResult]}
        onQueryChange={onQueryChange}
        onSelect={vi.fn()}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'response')
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.getByRole('combobox')).toHaveFocus()
    expect(onQueryChange).toHaveBeenLastCalledWith('')
    expect(screen.getByRole('group', { name: 'Recent tasks' })).toBeVisible()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  test('pending remote search disables stale results until the new results finish loading', async () => {
    const onSelect = vi.fn()
    const props = {
      onOpenChange: vi.fn(),
      workspaces,
      conversationsByWorkspace,
      onSelect,
      onQueryChange: vi.fn(),
      remoteResults: [remoteResult],
    }
    const view = render(<ChatGPTSearch {...props} open loading />)
    await userEvent.type(screen.getByRole('combobox'), 'response')
    expect(screen.getByRole('option')).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
    view.rerender(<ChatGPTSearch {...props} open loading={false} />)
    await waitFor(() =>
      expect(screen.getByRole('option')).toHaveAttribute(
        'aria-selected',
        'true'
      )
    )
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('backend', 'api', 'turn-6')
  })

  test('opening from a task title search initializes the query and later prop updates do not overwrite typing', async () => {
    const props = {
      onOpenChange: vi.fn(),
      workspaces,
      conversationsByWorkspace,
      onSelect: vi.fn(),
      onQueryChange: vi.fn(),
      remoteResults: [remoteResult],
    }
    const { rerender } = render(
      <ChatGPTSearch {...props} open={false} initialQuery='response' />
    )
    rerender(<ChatGPTSearch {...props} open initialQuery='response' />)
    expect(screen.getByRole('combobox')).toHaveValue('response')
    await userEvent.type(screen.getByRole('combobox'), ' body')
    rerender(<ChatGPTSearch {...props} open initialQuery='response body' />)
    expect(screen.getByRole('combobox')).toHaveValue('response body')
    rerender(<ChatGPTSearch {...props} open={false} initialQuery='' />)
    rerender(<ChatGPTSearch {...props} open initialQuery='different task' />)
    expect(screen.getByRole('combobox')).toHaveValue('different task')
  })

  test('server message matches render safe excerpts with archive context and select the matching turn', async () => {
    const onSelect = vi.fn()
    const onQueryChange = vi.fn()
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[remoteResult]}
        onQueryChange={onQueryChange}
        onSelect={onSelect}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'response')
    expect(onQueryChange).toHaveBeenLastCalledWith('response')
    const result = screen.getByRole('option')
    expect(result).toHaveTextContent(remoteResult.snippet)
    expect(result).toHaveTextContent('Backend service')
    expect(result).toHaveTextContent('Archived')
    expect(result.querySelector('script')).toBeNull()
    expect(screen.queryByText('Plan homepage')).not.toBeInTheDocument()
    await userEvent.click(result)
    expect(onSelect).toHaveBeenCalledWith('backend', 'api', 'turn-6')
    expect(onQueryChange).toHaveBeenLastCalledWith('')
  })

  test('an empty server result does not substitute a locally matching title', async () => {
    const onSelect = vi.fn()
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[]}
        onQueryChange={vi.fn()}
        onSelect={onSelect}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'homepage')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('No tasks found')
    expect(screen.getByText('Try a different word or phrase.')).toBeVisible()
    await userEvent.keyboard('{Enter}')
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('a server failure hides stale matches and retries through the provided action', async () => {
    const onRetry = vi.fn()
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[remoteResult]}
        onQueryChange={vi.fn()}
        error='Search is temporarily unavailable.'
        onRetry={onRetry}
        onSelect={vi.fn()}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'response')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Search is temporarily unavailable.'
    )
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  test('loading server results announces progress without reporting no matches', async () => {
    render(
      <ChatGPTSearch
        open
        loading
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[]}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'response')
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading tasks...'
    )
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })

  test('a result limit explains how to find further matches without claiming full message output', async () => {
    render(
      <ChatGPTSearch
        open
        hasMore
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[remoteResult]}
        onQueryChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'response')
    expect(screen.getByRole('status')).toHaveTextContent(
      'More matches are available. Refine your search to see more specific results.'
    )
    expect(
      screen.getByText(
        'Message matches show excerpts. Open a task to read the full conversation.'
      )
    ).toBeVisible()
  })

  test('clearing server search returns recent loaded chats and suppresses an earlier failure', async () => {
    const onQueryChange = vi.fn()
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[]}
        onQueryChange={onQueryChange}
        error='Search is temporarily unavailable.'
        onSelect={vi.fn()}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'response')
    await userEvent.clear(screen.getByRole('combobox'))
    expect(onQueryChange).toHaveBeenLastCalledWith('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText('Recent tasks')).toBeVisible()
  })

  test('a server project result opens the workspace without inventing a conversation id', async () => {
    const onSelect = vi.fn()
    const projectResult: CodexSearchResult = {
      id: 'project:backend',
      workspaceId: 'backend',
      workspaceName: 'Backend service',
      workspaceArchived: true,
      conversationName: '',
      conversationArchived: false,
      matchType: 'project',
      snippet: '',
      updatedAt: 9,
    }
    render(
      <ChatGPTSearch
        open
        onOpenChange={vi.fn()}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        remoteResults={[projectResult]}
        onQueryChange={vi.fn()}
        onSelect={onSelect}
      />
    )
    await userEvent.type(screen.getByRole('combobox'), 'backend')
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith('backend', undefined)
  })
})
