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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { Codex } from '..'
import type {
  CodexProjectConversation,
  CodexTask,
  CodexWorkspace,
} from '../types'
import { detail, environment, status, workspace } from './fixtures'

async function setup() {
  const projects: CodexWorkspace[] = [
    {
      ...workspace,
      id: 'project-a',
      name: 'Project A',
      conversationId: 'conversation-a',
    },
    {
      ...workspace,
      id: 'project-b',
      name: 'Project B',
      conversationId: 'conversation-b',
    },
  ]
  const conversations: Record<string, CodexProjectConversation[]> = {
    'project-a': [
      {
        id: 'conversation-a',
        name: 'Planning A',
        status: 'idle',
        createdAt: 1,
        updatedAt: 2,
        turnCount: 0,
      },
    ],
    'project-b': [
      {
        id: 'conversation-b',
        name: 'Planning B',
        status: 'idle',
        createdAt: 1,
        updatedAt: 2,
        turnCount: 0,
      },
    ],
  }
  function projectDetail(id: string, conversationId?: string) {
    const project = projects.find((entry) => entry.id === id) ?? projects[0]
    const conversation =
      conversations[id]?.find((entry) => entry.id === conversationId) ??
      conversations[id]?.[0]
    return {
      ...detail(),
      workspace: {
        ...project,
        conversationId: conversation?.id,
        conversationName: conversation?.name,
        conversationArchived: conversation?.archived ?? false,
      },
      conversationId: conversation?.id,
      conversations: conversations[id] ?? [],
      thread: { id: `thread-${id}`, turns: [] },
    }
  }
  const response = (data: unknown) =>
    ({ data: { success: true, data } }) as AxiosResponse
  vi.spyOn(api, 'get').mockImplementation(async (url, options) => {
    if (url.endsWith('/status')) return response(status)
    if (url.endsWith('/catalog')) return response({})
    if (url.endsWith('/environment')) return response({ environment })
    if (url.endsWith('/workspaces')) return response({ workspaces: projects })
    if (url.endsWith('/tasks')) {
      const tasks: CodexTask[] = projects.flatMap((project) =>
        conversations[project.id].map((conversation) => ({
          id: `${project.id}:${conversation.id}`,
          workspaceId: project.id,
          conversationId: conversation.id,
          title: conversation.name,
          workspaceName: project.name,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          status: project.status,
          latestTurnStatus: null,
          turnCount: conversation.turnCount,
          mode: project.mode,
          model: project.model,
          queuedCount: 0,
          approvalCount: 0,
          archived: project.archived || !!conversation.archived,
          workspaceArchived: project.archived,
          conversationArchived: !!conversation.archived,
          source: 'local',
        }))
      )
      return response({
        tasks,
        total: tasks.length,
        hasMore: false,
        nextOffset: null,
      })
    }
    const id = url.split('/')[4]
    if (url.endsWith('/conversations')) {
      return response({ conversations: conversations[id] })
    }
    if (url.endsWith('/repository')) {
      return response({
        repository: {
          available: false,
          checkoutSupported: false,
          checkoutReason: 'not_repository',
          hasSubmodules: false,
          branch: null,
          head: null,
          detached: false,
          dirty: false,
          remotes: [],
          branches: [],
          branchesTruncated: false,
        },
      })
    }
    if (url.endsWith('/events')) {
      return response({
        events: [],
        nextCursor: 0,
        workspace: projectDetail(id, options?.params?.conversation).workspace,
        pendingApprovals: [],
      })
    }
    return response(projectDetail(id, options?.params?.conversation))
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    const id = url.split('/')[4]
    if (url.endsWith('/conversations')) {
      const conversation: CodexProjectConversation = {
        id: `new-${id}`,
        name: 'New conversation',
        status: 'idle',
        createdAt: 3,
        updatedAt: 3,
        turnCount: 0,
      }
      conversations[id].push(conversation)
      return response(projectDetail(id, conversation.id))
    }
    return response(projectDetail(id))
  })
  const patch = vi
    .spyOn(api, 'patch')
    .mockImplementation(async (url, input) => {
      const id = url.split('/')[4]
      const conversation = conversations[id].find(
        (entry) => entry.id === url.split('/')[6]
      )
      Object.assign(conversation ?? {}, input)
      return response(projectDetail(id, conversation?.id))
    })
  const remove = vi.spyOn(api, 'delete').mockImplementation(async (url) => {
    const id = url.split('/')[4]
    conversations[id] = conversations[id].filter(
      (entry) => entry.id !== url.split('/')[6]
    )
    return response({ deleted: true, ...projectDetail(id) })
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: function TestApp() {
      const [selection, setSelection] = useState({
        workspace: 'project-a',
        conversation: 'conversation-a',
      })
      return (
        <Codex
          workspaceId={selection.workspace}
          conversationId={selection.conversation}
          onSelect={(id, conversation) =>
            setSelection({
              workspace: id ?? '',
              conversation: conversation ?? '',
            })
          }
          onBack={() => {}}
        />
      )
    },
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/codex'] }),
    defaultPendingMinMs: 0,
  })
  await router.load()
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByRole('heading', { name: 'Planning A' })
  return { post, patch, remove, projects }
}

afterEach(() => sessionStorage.clear())

test('cancelling a sidebar project rename cannot redirect a later stop command to that project', async () => {
  const { post, projects } = await setup()
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  await userEvent.click(
    screen.getByRole('button', { name: 'Open project list' })
  )
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Project actions' })[0]
  )
  await userEvent.click(
    screen.getByRole('menuitem', { name: 'Rename project' })
  )
  await userEvent.click(
    within(
      await screen.findByRole('dialog', { name: 'Rename project' })
    ).getByRole('button', { name: 'Cancel' })
  )
  projects[1].status = 'running'
  await userEvent.click(
    screen.getByRole('button', { name: 'Open task Planning B' })
  )
  await userEvent.click(
    await screen.findByRole('button', { name: 'Stop task' })
  )
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/codex/workspaces/project-b/interrupt',
      {},
      expect.objectContaining({ params: { conversation: 'conversation-b' } })
    )
  )
  expect(post).not.toHaveBeenCalledWith(
    '/api/codex/workspaces/project-a/interrupt',
    expect.anything(),
    expect.anything()
  )
})

test('starting a task in another project creates and opens that project conversation', async () => {
  const { post } = await setup()
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Choose project' })
  )
  await userEvent.click(screen.getByRole('option', { name: 'Project B' }))
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Implement checkout'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByRole('heading', { name: 'New conversation' })
  expect(post).toHaveBeenCalledWith(
    '/api/codex/workspaces/project-b/conversations',
    {},
    expect.anything()
  )
  expect(post).toHaveBeenCalledWith(
    '/api/codex/workspaces/project-b/turns',
    expect.objectContaining({ prompt: 'Implement checkout' }),
    expect.objectContaining({ params: { conversation: 'new-project-b' } })
  )
  expect(screen.getByText('Project B')).toBeVisible()
})

test('archiving a task makes its conversation read only and the sidebar archive filter restores it', async () => {
  const { patch } = await setup()
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  await userEvent.click(
    screen.getByRole('button', { name: 'Open project list' })
  )
  await userEvent.click(
    await screen.findByRole('button', { name: 'Task options for Planning A' })
  )
  await userEvent.click(screen.getByRole('menuitem', { name: 'Archive task' }))
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      '/api/codex/workspaces/project-a/conversations/conversation-a',
      { archived: true },
      expect.anything()
    )
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Show archived tasks' })
  )
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open task Planning A' })
  )
  await screen.findByText('Restore this conversation to continue.')
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
  await userEvent.click(
    screen.getByRole('button', { name: 'Open project list' })
  )
  expect(
    screen.getByRole('button', { name: 'Show archived tasks' })
  ).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(
    await screen.findByRole('button', { name: 'Task options for Planning A' })
  )
  await userEvent.click(screen.getByRole('menuitem', { name: 'Restore task' }))
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      '/api/codex/workspaces/project-a/conversations/conversation-a',
      { archived: false },
      expect.anything()
    )
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Show archived tasks' })
    ).toHaveAttribute('aria-pressed', 'false')
  )
  expect(
    await screen.findByRole('button', { name: 'Open task Planning A' })
  ).toBeVisible()
})

test('deleting another project task targets its conversation without selecting or deleting the previous project task', async () => {
  const { remove } = await setup()
  await userEvent.click(screen.getByRole('button', { name: 'New task' }))
  await userEvent.click(
    screen.getByRole('button', { name: 'Open project list' })
  )
  await userEvent.click(
    await screen.findByRole('button', { name: 'Task options for Planning B' })
  )
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete task' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete conversation?' })
  expect(within(dialog).getByText('Planning B')).toBeVisible()
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Delete conversation' })
  )
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/codex/workspaces/project-b/conversations/conversation-b',
      expect.anything()
    )
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Open task Planning B' })
    ).not.toBeInTheDocument()
  )
  expect(
    screen.getByRole('button', { name: 'Open task Planning A' })
  ).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Open task Planning A' })
  )
  expect(
    await screen.findByRole('heading', { name: 'Planning A' })
  ).toBeVisible()
})
