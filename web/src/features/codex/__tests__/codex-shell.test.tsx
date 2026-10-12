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
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, type AxiosResponse } from 'axios'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { Route as CodexRoute } from '@/routes/_authenticated/codex/index'
import { Route as AuthenticatedRoute } from '@/routes/_authenticated/route'
import { useAuthStore } from '@/stores/auth-store'

import type { CloudEnvironment } from '../cloud-types'
import type {
  CodexCatalog,
  CodexStatus,
  CodexDetail,
  CodexTask,
  CodexTaskPage,
  CodexTurnInput,
} from '../types'
import { detail, environment, status, workspace } from './fixtures'

const conversationId = '11111111-1111-4111-8111-111111111111'
const preparedConversationId = '22222222-2222-4222-8222-222222222222'
const archivedConversationId = '33333333-3333-4333-8333-333333333333'
const basePath = '/api/codex/workspaces/project-1'
const clients: QueryClient[] = []
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse

const currentTask: CodexTask = {
  id: `project-1:${conversationId}`,
  workspaceId: 'project-1',
  conversationId,
  title: 'Review current deployment',
  workspaceName: 'Website project',
  createdAt: 1,
  updatedAt: 3,
  status: 'idle',
  latestTurnStatus: 'completed',
  turnCount: 2,
  mode: 'code',
  model: 'codex-test',
  queuedCount: 0,
  approvalCount: 0,
  archived: false,
  workspaceArchived: false,
  conversationArchived: false,
  source: 'local',
}

const cloudEnvironment: CloudEnvironment = {
  id: 'env-1',
  name: 'Web runtime',
  description: '',
  createdAt: 1,
  updatedAt: 1,
  setupWorkspaceId: 'setup-1',
  draftRevision: 1,
  preparedRevision: 1,
  publishedVersion: 1,
  publishedAt: 1,
  status: 'published',
  lastError: null,
  config: {
    repositories: [],
    installScript: '',
    startSkill: '',
    internetAccess: 'enabled',
    allowedDomains: [],
    environmentVariables: [],
    privacy: 'private',
    advanced: { setupTimeoutSeconds: 300 },
  },
  published: {
    version: 1,
    createdAt: 1,
    snapshot: { bytes: 1, files: 1 },
    config: {
      repositories: [],
      installScript: '',
      startSkill: '',
      internetAccess: 'enabled',
      allowedDomains: [],
      environmentVariables: [],
      privacy: 'private',
      advanced: { setupTimeoutSeconds: 300 },
    },
  },
}

async function selectCloudEnvironment() {
  await userEvent.click(screen.getByRole('button', { name: 'Work in' }))
  await userEvent.click(
    screen.getByRole('menuitem', { name: /Cloud.*Published environments/ })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Select environment' })
  )
  await userEvent.click(
    await screen.findByRole('menuitem', { name: /Web runtime/ })
  )
}

async function selectEnvironment(name: string) {
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Choose project' })
  )
  await userEvent.click(await screen.findByRole('option', { name }))
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function renderShell(
  options: {
    existing?: boolean
    modelStatus?: CodexStatus
    modelCatalog?: CodexCatalog
    queryRetries?: boolean
    assistantResponse?: string
    desktop?: boolean
    availableProjects?: boolean
    createGate?: Promise<void>
    createFailures?: number
    cloudStartFailures?: number
    turnFailures?: number
    taskPages?: CodexTaskPage[]
    nextPageGate?: Promise<void>
    otherRunning?: boolean
  } = {}
) {
  if (options.desktop) {
    const media = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...media(query),
      matches: query === '(min-width: 768px)',
    }))
  }
  let created = options.existing || options.availableProjects || false
  let createFailures = options.createFailures ?? 0
  let cloudStartFailures = options.cloudStartFailures ?? 0
  let turnFailures = options.turnFailures ?? 0
  const project = {
    ...workspace,
    conversationId,
    conversationName: 'Saved chat',
  }
  const secondProject = { ...project, id: 'project-2', name: 'API project' }
  const projects = [project, secondProject]
  const prepared = new Map<string, CodexDetail>()
  let conversationSequence = 0
  const current: CodexDetail = {
    ...detail(),
    workspace: project,
    conversationId,
    conversations: [
      {
        id: conversationId,
        name: 'Saved chat',
        status: 'idle',
        createdAt: 1,
        updatedAt: 2,
        turnCount: 2,
      },
    ],
    thread: {
      id: 'thread-1',
      turns: options.existing
        ? [
            {
              id: 'old-turn',
              status: 'completed',
              items: [
                {
                  id: 'old-answer',
                  type: 'agentMessage',
                  text: 'Earlier deployment note',
                },
              ],
            },
            {
              id: 'latest-turn',
              status: 'completed',
              items: [
                {
                  id: 'latest-answer',
                  type: 'agentMessage',
                  text: options.assistantResponse ?? 'Latest deployment note',
                },
              ],
            },
          ]
        : [],
    },
  }
  const get = vi.spyOn(api, 'get').mockImplementation(async (url, config) => {
    if (url === `${basePath}/file`) {
      return response({
        path: config?.params?.path,
        content: '# File preview\nlinked section\nlast section',
        hash: 'file-hash',
        binary: false,
        truncated: false,
      })
    }
    if (url === '/api/codex/environments') {
      return response({ environments: [cloudEnvironment] })
    }
    if (url === '/api/user/self/codex-config') {
      return response({ effective: { userId: 25, enabled: true } })
    }
    if (url === '/api/codex/status') {
      return response(options.modelStatus ?? status)
    }
    if (url === '/api/codex/catalog') {
      return response(options.modelCatalog ?? {})
    }
    if (url === '/api/codex/environment') {
      return response({
        environment: options.otherRunning
          ? {
              ...environment,
              status: 'running',
              activeWorkspaceId: 'project-2',
              activeConversationId: 'other-chat',
              activeTasks: [
                {
                  workspaceId: 'project-2',
                  conversationId: 'other-chat',
                  status: 'running',
                },
              ],
            }
          : environment,
      })
    }
    if (url === '/api/codex/workspaces') {
      return response({ workspaces: created ? projects : [] })
    }
    if (url === '/api/codex/tasks') {
      const offset = Number(config?.params?.offset ?? 0)
      if (offset > 0) await options.nextPageGate
      return response(
        options.taskPages?.[offset > 0 ? 1 : 0] ?? {
          tasks: [],
          total: 0,
          hasMore: false,
          nextOffset: null,
        }
      )
    }
    const workspaceId = url.split('/')[4]
    const selectedProject =
      projects.find((entry) => entry.id === workspaceId) ?? project
    const selectedConversation = String(
      config?.params?.conversation || conversationId
    )
    const selectedDetail = prepared.get(
      `${workspaceId}:${selectedConversation}`
    ) ?? {
      ...current,
      conversationId: selectedConversation,
      workspace: {
        ...selectedProject,
        conversationId: selectedConversation,
        conversationArchived: selectedConversation === archivedConversationId,
      },
    }
    if (url.endsWith('/conversations')) {
      return response({ conversations: selectedDetail.conversations })
    }
    if (url.endsWith('/repository')) {
      return response({
        repository: {
          available: true,
          branch: 'main',
          head: 'abcd',
          detached: false,
          dirty: false,
          checkoutSupported: true,
          checkoutReason: null,
          hasSubmodules: false,
          remotes: [],
          branches: [
            {
              name: 'main',
              ref: 'refs/heads/main',
              remote: null,
              current: true,
            },
          ],
          branchesTruncated: false,
        },
      })
    }
    if (url.endsWith('/events')) {
      return response({
        events: [],
        nextCursor: 0,
        workspace: selectedDetail.workspace,
        pendingApprovals: [],
      })
    }
    if (/^\/api\/codex\/workspaces\/[^/]+$/.test(url)) {
      return response(structuredClone(selectedDetail))
    }
    if (url === '/api/codex/search') {
      return response({
        query: 'Earlier',
        hasMore: false,
        results: [
          {
            id: 'match-old',
            workspaceId: project.id,
            workspaceName: project.name,
            conversationId,
            conversationName: 'Saved chat',
            workspaceArchived: false,
            conversationArchived: false,
            matchType: 'message',
            snippet: 'Earlier deployment note',
            turnId: 'old-turn',
            role: 'assistant',
            updatedAt: 1,
          },
        ],
      })
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const post = vi
    .spyOn(api, 'post')
    .mockImplementation(async (url, input, config) => {
      if (url === '/api/codex/environments/env-1/tasks') {
        if (cloudStartFailures > 0) {
          cloudStartFailures -= 1
          throw new Error('Snapshot preparation temporarily failed')
        }
        created = true
        return response({ workspace: project, environment: cloudEnvironment })
      }
      if (url === '/api/codex/workspaces') {
        await options.createGate
        if (createFailures > 0) {
          createFailures -= 1
          throw new Error('Project creation temporarily failed')
        }
        created = true
        return response({ workspace: project })
      }
      const workspaceId = url.split('/')[4]
      const selectedProject =
        projects.find((entry) => entry.id === workspaceId) ?? project
      if (url.endsWith('/conversations')) {
        conversationSequence += 1
        const newId =
          conversationSequence === 1
            ? preparedConversationId
            : '44444444-4444-4444-8444-444444444444'
        const newDetail: CodexDetail = {
          ...detail(),
          workspace: { ...selectedProject, conversationId: newId },
          conversationId: newId,
          thread: { id: `new-thread-${conversationSequence}`, turns: [] },
          conversations: [],
        }
        prepared.set(`${workspaceId}:${newId}`, newDetail)
        return response(newDetail)
      }
      if (url.endsWith('/upload')) {
        return response({
          path: (input as File).name,
          size: (input as File).size,
        })
      }
      if (url.endsWith('/turns')) {
        if (turnFailures > 0) {
          turnFailures -= 1
          throw new Error('Task submission temporarily failed')
        }
        const turn = input as CodexTurnInput
        const selectedConversation = String(
          config?.params?.conversation || conversationId
        )
        const selectedDetail =
          prepared.get(`${workspaceId}:${selectedConversation}`) ?? current
        selectedDetail.thread?.turns.push({
          id: 'submitted-turn',
          status: 'completed',
          items: [
            {
              id: 'submitted-user',
              type: 'userMessage',
              content: [{ type: 'text', text: turn.prompt }],
            },
            {
              id: 'submitted-answer',
              type: 'agentMessage',
              text: 'The requested task is complete.',
            },
          ],
        })
        return response({ workspace: project, turnId: 'submitted-turn' })
      }
      throw new Error(`Unexpected POST ${url}`)
    })
  const rootRoute = createRootRoute({ component: Outlet })
  const authenticated = createRoute({
    getParentRoute: () => rootRoute,
    id: '_authenticated',
    component: AuthenticatedRoute.options.component,
  })
  const codex = createRoute({
    getParentRoute: () => authenticated,
    path: '/codex/',
    component: CodexRoute.options.component,
    validateSearch: CodexRoute.options.validateSearch,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([authenticated.addChildren([codex])]),
    history: createMemoryHistory({
      initialEntries: [
        options.existing
          ? `/codex?workspace=project-1&conversation=${conversationId}`
          : '/codex',
      ],
    }),
    defaultPendingMinMs: 0,
  })
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: options.queryRetries ? 2 : false, retryDelay: 0 },
      mutations: { retry: false },
    },
  })
  clients.push(client)
  await router.load()
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByRole('textbox', { name: 'Describe your coding task' })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Add files and more' })
    ).toBeEnabled()
  )
  return { client, get, post, router, unmount: view.unmount }
}

const originalClientRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getClientRects'
)
const originalBoundingRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect'
)
beforeEach(() => {
  // jsdom has no text layout; only stub the browser geometry boundary used by
  // CodeMirror so the actual editor and its input transactions remain real.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalClientRects) {
    Object.defineProperty(
      Range.prototype,
      'getClientRects',
      originalClientRects
    )
  } else Reflect.deleteProperty(Range.prototype, 'getClientRects')
  if (originalBoundingRect) {
    Object.defineProperty(
      Range.prototype,
      'getBoundingClientRect',
      originalBoundingRect
    )
  } else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
})

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  useAuthStore
    .getState()
    .auth.setUser({ id: 25, username: 'shell-review', role: 100 })
})

test('the home page keeps settings in the sidebar and omits the duplicate header entry', async () => {
  await renderShell({ desktop: true })
  const header = screen
    .getByRole('heading', { name: 'New task' })
    .closest('header')
  expect(header).not.toBeNull()
  if (!header) throw new Error('Home header is missing')
  expect(
    within(header).queryByRole('button', { name: 'Settings' })
  ).not.toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: 'Settings' })[0])
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible()
})
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.cancelQueries()
    client.clear()
  }
  useAuthStore.getState().auth.reset()
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('the Codex route has one main landmark and keeps project navigation in a dismissible drawer', async () => {
  await renderShell()
  expect(screen.getAllByRole('main')).toHaveLength(1)
  const main = screen.getByRole('main')
  expect(
    within(main).getByRole('textbox', { name: 'Describe your coding task' })
  ).toBeVisible()
  expect(screen.queryByRole('tab', { name: 'Archive' })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('navigation', { name: 'Project history' })
  ).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('button', { name: 'Open project list' })
  )
  expect(
    screen.getByRole('navigation', { name: 'Project history' })
  ).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(
      screen.queryByRole('navigation', { name: 'Project history' })
    ).not.toBeInTheDocument()
  )
  expect(
    screen.getByRole('button', { name: 'Open project list' })
  ).toHaveFocus()
})

test('double clicking the first send creates one project and submits one task after creation completes', async () => {
  const creation = deferred()
  const app = await renderShell({ createGate: creation.promise })
  const input = screen.getByRole('textbox', {
    name: 'Describe your coding task',
  })
  await userEvent.type(input, 'Build the dashboard')
  await userEvent.dblClick(screen.getByRole('button', { name: 'Start task' }))
  expect(
    app.post.mock.calls.filter(([url]) => url === '/api/codex/workspaces')
  ).toHaveLength(1)
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  ).toHaveLength(0)
  await act(async () => creation.resolve())
  await screen.findByText('The requested task is complete.')
  expect(
    app.post.mock.calls.filter(([url]) => url === '/api/codex/workspaces')
  ).toHaveLength(1)
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  ).toHaveLength(1)
  expect(app.router.state.location.search).toMatchObject({
    workspace: 'project-1',
    conversation: conversationId,
  })
})

test('a failed first task preserves the home draft and retries its original request in the already created project', async () => {
  const app = await renderShell({ turnFailures: 1 })
  const input = screen.getByRole('textbox', {
    name: 'Describe your coding task',
  })
  await userEvent.type(input, 'Retry this task safely')
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Task submission temporarily failed'
  )
  expect(input).toHaveValue('Retry this task safely')
  expect(app.router.state.location.search).not.toHaveProperty('workspace')
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  const requests = app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  expect(
    app.post.mock.calls.filter(([url]) => url === '/api/codex/workspaces')
  ).toHaveLength(1)
  expect(requests).toHaveLength(2)
  expect(requests[1][1]).toEqual(requests[0][1])
  expect(requests[1][0]).toBe(`${basePath}/turns`)
})

test('a rejected project creation keeps the draft and allows one successful creation before sending', async () => {
  const app = await renderShell({ createFailures: 1 })
  const input = screen.getByRole('textbox', {
    name: 'Describe your coding task',
  })
  await userEvent.type(input, 'Create again')
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Project creation temporarily failed'
  )
  expect(input).toHaveValue('Create again')
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  ).toHaveLength(0)
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  expect(
    app.post.mock.calls.filter(([url]) => url === '/api/codex/workspaces')
  ).toHaveLength(2)
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  ).toHaveLength(1)
})

test('an attachment on the home screen uploads into its prepared project without navigating and the first task uses that project', async () => {
  const app = await renderShell()
  const file = new File(['deployment notes'], 'notes.txt', {
    type: 'text/plain',
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Add files and more' })
  )
  await userEvent.click(
    screen.getByRole('menuitem', { name: 'Add photos & files' })
  )
  await userEvent.upload(screen.getByLabelText('Upload project files'), file)
  await screen.findByRole('button', { name: 'Remove attachment notes.txt' })
  expect(app.router.state.location.search).not.toHaveProperty('workspace')
  expect(
    screen.getByRole('heading', { name: 'What do you want to build?' })
  ).toBeVisible()
  expect(app.post).toHaveBeenCalledWith(
    `${basePath}/upload`,
    file,
    expect.objectContaining({ params: { path: 'notes.txt' } })
  )
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Read the notes'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  expect(
    app.post.mock.calls.filter(([url]) => url === '/api/codex/workspaces')
  ).toHaveLength(1)
  expect(app.post).toHaveBeenCalledWith(
    `${basePath}/turns`,
    expect.objectContaining({
      prompt: 'Read the notes\n\nUploaded project files:\n- "notes.txt"',
    }),
    expect.objectContaining({ params: { conversation: conversationId } })
  )
  expect(
    screen.queryByRole('button', { name: 'Remove attachment notes.txt' })
  ).not.toBeInTheDocument()
})

test('choosing an existing environment creates one new conversation and retries its attached Ask task without touching the old conversation', async () => {
  const app = await renderShell({ availableProjects: true, turnFailures: 1 })
  await selectEnvironment('Website project')
  await waitFor(() =>
    expect(app.get).toHaveBeenCalledWith(
      `${basePath}/repository`,
      expect.anything()
    )
  )
  const file = new File(['deployment notes'], 'notes.txt', {
    type: 'text/plain',
  })
  await userEvent.upload(screen.getByLabelText('Upload project files'), file)
  await screen.findByRole('button', { name: 'Remove attachment notes.txt' })
  expect(app.router.state.location.search).not.toHaveProperty('workspace')
  await userEvent.click(screen.getByRole('combobox', { name: 'Approval mode' }))
  await userEvent.click(screen.getByRole('option', { name: /Read-only/ }))
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Explain these notes'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Task submission temporarily failed'
  )
  expect(
    screen.getByRole('button', { name: 'Remove attachment notes.txt' })
  ).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  expect(
    app.post.mock.calls.filter(([url]) => url === '/api/codex/workspaces')
  ).toHaveLength(0)
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/conversations'))
  ).toHaveLength(1)
  expect(app.post).toHaveBeenCalledWith(
    `${basePath}/conversations`,
    {},
    expect.anything()
  )
  expect(app.post).toHaveBeenCalledWith(
    `${basePath}/turns`,
    expect.objectContaining({
      mode: 'ask',
      prompt: 'Explain these notes\n\nUploaded project files:\n- "notes.txt"',
    }),
    expect.objectContaining({
      params: { conversation: preparedConversationId },
    })
  )
  const requests = app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  expect(requests[1][1]).toEqual(requests[0][1])
  expect(app.router.state.location.search).toMatchObject({
    workspace: 'project-1',
    conversation: preparedConversationId,
  })
})

test('switching away from an environment and back preserves its prepared attachment draft and conversation', async () => {
  const app = await renderShell({ availableProjects: true })
  await selectEnvironment('Website project')
  await userEvent.upload(
    screen.getByLabelText('Upload project files'),
    new File(['notes'], 'notes.txt', { type: 'text/plain' })
  )
  await screen.findByRole('button', { name: 'Remove attachment notes.txt' })
  await selectEnvironment('API project')
  expect(
    screen.queryByRole('button', { name: 'Remove attachment notes.txt' })
  ).not.toBeInTheDocument()
  await selectEnvironment('Website project')
  expect(
    screen.getByRole('button', { name: 'Remove attachment notes.txt' })
  ).toBeVisible()
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Use the original notes'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/conversations'))
  ).toHaveLength(1)
  expect(app.post).toHaveBeenCalledWith(
    `${basePath}/turns`,
    expect.objectContaining({
      prompt:
        'Use the original notes\n\nUploaded project files:\n- "notes.txt"',
    }),
    expect.objectContaining({
      params: { conversation: preparedConversationId },
    })
  )
})

test('loading another task page requests its server cursor once and an archived task opens the exact project and conversation read only', async () => {
  const nextPage = deferred()
  const archivedTask: CodexTask = {
    ...currentTask,
    id: `project-2:${archivedConversationId}`,
    workspaceId: 'project-2',
    workspaceName: 'API project',
    conversationId: archivedConversationId,
    title: 'Archived API review',
    updatedAt: 1,
    archived: true,
    conversationArchived: true,
  }
  const app = await renderShell({
    availableProjects: true,
    nextPageGate: nextPage.promise,
    taskPages: [
      { tasks: [currentTask], total: 2, hasMore: true, nextOffset: 100 },
      { tasks: [archivedTask], total: 2, hasMore: false, nextOffset: null },
    ],
  })
  await userEvent.click(
    screen.getByRole('button', { name: 'Open project list' })
  )
  await screen.findByRole('button', {
    name: 'Open task Review current deployment',
  })
  await userEvent.dblClick(
    screen.getByRole('button', { name: 'Load more tasks' })
  )
  expect(
    app.get.mock.calls.filter(
      ([url, config]) =>
        url === '/api/codex/tasks' && config?.params?.offset === 100
    )
  ).toHaveLength(1)
  await act(async () => nextPage.resolve())
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Loading tasks...' })
    ).not.toBeInTheDocument()
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Show archived tasks' })
  )
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open task Archived API review' })
  )
  await screen.findByText('Restore this conversation to continue.')
  expect(app.router.state.location.search).toMatchObject({
    workspace: 'project-2',
    conversation: archivedConversationId,
  })
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled()
  expect(app.post).not.toHaveBeenCalled()
})

test('opening a matching old message focuses that turn and sending a new task resumes following the latest response', async () => {
  const app = await renderShell({ existing: true })
  const viewport = screen.getByRole('region', { name: 'Task conversation' })
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1500 },
    clientHeight: { configurable: true, value: 300 },
  })
  await userEvent.keyboard('{Control>}k{/Control}')
  await userEvent.type(
    screen.getByRole('combobox', { name: 'Search tasks' }),
    'Earlier'
  )
  await userEvent.click(
    await screen.findByRole('option', { name: /Earlier deployment note/ })
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Search tasks' })
    ).not.toBeInTheDocument()
  )
  const oldTurn = screen
    .getAllByRole('region', { name: 'Task turn' })
    .find((turn) => turn.textContent?.includes('Earlier deployment note'))
  expect(oldTurn).toHaveFocus()
  viewport.scrollTop = 100
  fireEvent.scroll(viewport)
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Continue with the latest changes'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  await waitFor(() => expect(viewport.scrollTop).toBe(1500))
  expect(app.post).toHaveBeenCalledWith(
    `${basePath}/turns`,
    expect.objectContaining({ prompt: 'Continue with the latest changes' }),
    expect.anything()
  )
  expect(
    screen.queryByRole('button', { name: 'Scroll to latest message' })
  ).not.toBeInTheDocument()
})

test('a cloud attachment prepares one isolated workspace and task retry uses its uploaded files and original request', async () => {
  const app = await renderShell({ turnFailures: 1 })
  await selectCloudEnvironment()
  await userEvent.upload(
    screen.getByLabelText('Upload project files'),
    new File(['cloud note'], 'cloud.txt', { type: 'text/plain' })
  )
  await screen.findByRole('button', { name: 'Remove attachment cloud.txt' })
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Inspect the cloud files'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Task submission temporarily failed'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  const starts = app.post.mock.calls.filter(
    ([url]) => url === '/api/codex/environments/env-1/tasks'
  )
  expect(starts).toHaveLength(1)
  expect(starts[0][1]).toEqual({
    name: 'New task',
    requestId: expect.any(String),
  })
  expect(
    app.post.mock.calls.filter(
      ([url]) =>
        url === '/api/codex/workspaces' || url.endsWith('/conversations')
    )
  ).toHaveLength(0)
  const turns = app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  expect(turns).toHaveLength(2)
  expect(turns[1][1]).toEqual(turns[0][1])
  expect(turns[1][1]).toMatchObject({
    prompt: 'Inspect the cloud files\n\nUploaded project files:\n- "cloud.txt"',
  })
})

test('a failed cloud snapshot preparation preserves the draft and retries with the same idempotency key', async () => {
  const app = await renderShell({ cloudStartFailures: 1 })
  await selectCloudEnvironment()
  const composer = screen.getByRole('textbox', {
    name: 'Describe your coding task',
  })
  await userEvent.type(composer, 'Build in a cloud workspace')
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Snapshot preparation temporarily failed'
  )
  expect(composer).toHaveValue('Build in a cloud workspace')
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
  await screen.findByText('The requested task is complete.')
  const starts = app.post.mock.calls.filter(
    ([url]) => url === '/api/codex/environments/env-1/tasks'
  )
  expect(starts).toHaveLength(2)
  expect(starts[1][1]).toEqual(starts[0][1])
  expect(
    app.post.mock.calls.filter(([url]) => url.endsWith('/turns'))
  ).toHaveLength(1)
})

test('desktop keeps projects and recent tasks beside the new-task composer without the legacy task tabs', async () => {
  await renderShell({
    desktop: true,
    availableProjects: true,
    taskPages: [
      { tasks: [currentTask], total: 1, hasMore: false, nextOffset: null },
    ],
  })
  expect(
    screen.getByRole('complementary', { name: 'Codex projects' })
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Website project' })).toBeVisible()
  expect(
    await screen.findByRole('button', {
      name: 'Open task Review current deployment',
    })
  ).toBeVisible()
  expect(
    screen.getByRole('textbox', { name: 'Describe your coding task' })
  ).toBeVisible()
  expect(screen.queryByRole('tab', { name: 'Tasks' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'Archive' })).not.toBeInTheDocument()
})

test('a saved permission preference selects full access for a new task and is updated when another mode is chosen', async () => {
  localStorage.setItem('codex-permission-mode:25', 'full-access')
  await renderShell({ desktop: true, availableProjects: true })
  const approval = screen.getByRole('combobox', { name: 'Approval mode' })
  expect(approval).toHaveTextContent('Full access')
  await userEvent.click(approval)
  await userEvent.click(screen.getByRole('option', { name: /^Auto approve/ }))
  expect(localStorage.getItem('codex-permission-mode:25')).toBe('auto')
})

test('another running project leaves the selected idle conversation able to start a parallel task', async () => {
  const f = await renderShell({ existing: true, otherRunning: true })
  const input = screen.getByRole('textbox', {
    name: 'Describe your coding task',
  })
  await userEvent.type(input, 'Run independently of the other project')
  const start = screen.getByRole('button', { name: 'Start task' })
  expect(start).toBeEnabled()
  expect(
    screen.queryByRole('button', { name: 'Queue message' })
  ).not.toBeInTheDocument()
  await userEvent.click(start)
  await waitFor(() =>
    expect(f.post.mock.calls.some(([path]) => path.includes('/turns'))).toBe(
      true
    )
  )
  const turn = f.post.mock.calls.find(([path]) =>
    path.includes('/turns')
  )?.[1] as CodexTurnInput
  expect(turn.busyAction).toBeUndefined()
})

test('another running project leaves creation of a blank project available', async () => {
  const f = await renderShell({
    existing: true,
    otherRunning: true,
    desktop: true,
  })
  await userEvent.click(screen.getByRole('button', { name: 'New project' }))
  const dialog = await screen.findByRole('dialog', { name: 'New project' })
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Project name' }),
    'Parallel project'
  )
  const create = within(dialog).getByRole('button', { name: 'Create project' })
  expect(create).toBeEnabled()
  await userEvent.click(create)
  await waitFor(() =>
    expect(f.post).toHaveBeenCalledWith(
      '/api/codex/workspaces',
      expect.objectContaining({ name: 'Parallel project' }),
      expect.anything()
    )
  )
})

test('a setup-project deletion error stays visible in its dialog and offers environment management', async () => {
  await renderShell({ existing: true, desktop: true })
  const remove = vi.spyOn(api, 'delete').mockRejectedValue({
    isAxiosError: true,
    response: {
      status: 409,
      data: {
        code: 'environment_workspace_in_use',
        message:
          'Delete the cloud environment before deleting its setup workspace',
      },
    },
  })
  fireEvent.click(screen.getAllByRole('button', { name: 'Project actions' })[0])
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Delete project' })
  )
  const dialog = await screen.findByRole('dialog', { name: 'Delete project?' })
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Delete project' })
  )
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Delete the cloud environment before deleting its setup workspace'
  )
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Manage environments' })
  )
  expect(
    await screen.findByRole('dialog', { name: 'Codex Cloud' })
  ).toBeVisible()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove.mock.calls[0][0]).toBe('/api/codex/workspaces/project-1')
})

test('cloud Markdown file links open the current project file without leaving the conversation', async () => {
  const app = await renderShell({
    existing: true,
    desktop: true,
    assistantResponse:
      '[整理文档](/workspace/projects/project-1/project/整理文档.md:2)',
  })
  await userEvent
    .setup()
    .click(await screen.findByRole('link', { name: '整理文档' }))
  const dialog = await screen.findByRole('dialog', { name: '整理文档.md' })
  expect(await within(dialog).findByText('linked section')).toBeVisible()
  expect(
    within(dialog).queryByText(
      'This task is read only. Restore it to edit files.'
    )
  ).not.toBeInTheDocument()
  expect(app.get).toHaveBeenCalledWith(
    `${basePath}/file`,
    expect.objectContaining({ params: { path: '整理文档.md' } })
  )
  expect(
    within(dialog).getByRole('textbox', { name: 'File contents' })
  ).toHaveAttribute('aria-readonly', 'true')
})

test('project file links can be copied as authenticated website URLs with the target line', async () => {
  await renderShell({
    existing: true,
    desktop: true,
    assistantResponse:
      '[整理文档](/workspace/projects/project-1/project/整理文档.md:2)',
  })
  const link = await screen.findByRole('link', { name: '整理文档' })
  const url = new URL(link.getAttribute('href') || '', 'https://example.com')
  expect(url.pathname).toBe('/codex')
  expect(url.searchParams.get('file')).toBe('整理文档.md')
  expect(url.searchParams.get('line')).toBe('2')
})

test('project file read errors stay in the preview and the conversation remains accessible', async () => {
  const app = await renderShell({
    existing: true,
    desktop: true,
    assistantResponse:
      '[缺失文档](/workspace/projects/project-1/project/missing.md)',
  })
  const get = app.get.getMockImplementation()
  if (!get) throw new Error('HTTP fixture is missing')
  app.get.mockImplementation(async (url, config) => {
    if (url === `${basePath}/file`) {
      throw {
        response: {
          status: 404,
          data: { message: 'File not found', code: 'file_not_found' },
        },
      }
    }
    return get(url, config)
  })
  await userEvent
    .setup()
    .click(await screen.findByRole('link', { name: '缺失文档' }))
  const dialog = await screen.findByRole('dialog', { name: 'missing.md' })
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'File not found'
  )
  await userEvent
    .setup()
    .click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(
    screen.getByRole('textbox', { name: 'Describe your coding task' })
  ).toBeEnabled()
})

test('links to other project files cannot request those files from the selected project', async () => {
  const app = await renderShell({
    existing: true,
    desktop: true,
    assistantResponse:
      '[其他项目](/workspace/projects/project-2/project/private.md)\n\n[危险](javascript:alert%281%29)',
  })
  expect(await screen.findByText('其他项目')).toBeVisible()
  expect(
    screen.queryByRole('link', { name: '其他项目' })
  ).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '危险' })).not.toBeInTheDocument()
  expect(app.get.mock.calls.some(([url]) => url.endsWith('/file'))).toBe(false)
})

test.each([
  'sandbox:/workspace/projects/project-1/project/整理文档.md:2',
  'file:///workspace/projects/project-1/project/整理文档.md:2',
])('validated project file scheme %s opens a preview', async (href) => {
  await renderShell({
    existing: true,
    desktop: true,
    assistantResponse: `[文档](${href})`,
  })
  await userEvent
    .setup()
    .click(await screen.findByRole('link', { name: '文档' }))
  expect(
    await screen.findByRole('dialog', { name: '整理文档.md' })
  ).toBeVisible()
})

test('missing project files show their error without repeated requests under production query retry settings', async () => {
  const app = await renderShell({
    existing: true,
    desktop: true,
    queryRetries: true,
    assistantResponse:
      '[Missing document](/workspace/projects/project-1/project/missing.md)',
  })
  const get = app.get.getMockImplementation()
  if (!get) throw new Error('HTTP fixture is missing')
  app.get.mockImplementation(async (url, config) => {
    if (url === `${basePath}/file`) {
      throw new AxiosError(
        'File not found',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        {
          status: 404,
          statusText: 'Not Found',
          data: { message: 'File not found' },
          headers: {},
          config: { headers: {} },
        } as AxiosResponse
      )
    }
    return get(url, config)
  })
  await userEvent
    .setup()
    .click(await screen.findByRole('link', { name: 'Missing document' }))
  const dialog = await screen.findByRole('dialog', { name: 'missing.md' })
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'File not found'
  )
  expect(
    app.get.mock.calls.filter(([url]) => url === `${basePath}/file`)
  ).toHaveLength(1)
})

test('a temporary server error while opening a project file recovers through the file retry policy', async () => {
  const app = await renderShell({
    existing: true,
    desktop: true,
    queryRetries: true,
    assistantResponse:
      '[Project document](/workspace/projects/project-1/project/整理文档.md:2)',
  })
  const get = app.get.getMockImplementation()
  if (!get) throw new Error('HTTP fixture is missing')
  let unavailable = true
  app.get.mockImplementation(async (url, config) => {
    if (url === `${basePath}/file` && unavailable) {
      unavailable = false
      throw new AxiosError(
        'Temporary server error',
        'ERR_BAD_RESPONSE',
        undefined,
        undefined,
        {
          status: 503,
          statusText: 'Service Unavailable',
          data: { message: 'Temporary server error' },
          headers: {},
          config: { headers: {} },
        } as AxiosResponse
      )
    }
    return get(url, config)
  })
  await userEvent
    .setup()
    .click(await screen.findByRole('link', { name: 'Project document' }))
  const dialog = await screen.findByRole('dialog', { name: '整理文档.md' })
  expect(await within(dialog).findByText('linked section')).toBeVisible()
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
})

const preferenceStatus: CodexStatus = {
  ...status,
  models: [
    { id: 'codex-test', name: 'Codex Test' },
    {
      id: 'codex-fast',
      name: 'Codex Fast',
      efforts: ['low', 'medium'],
      defaultEffort: 'medium',
    },
  ],
}
const preferenceCatalog: CodexCatalog = {
  defaultModel: 'codex-test',
  defaultGroup: 'basic',
  groups: [
    {
      id: 'basic',
      name: 'Basic',
      description: '',
      ratio: 1,
      models: [{ id: 'codex-test', name: 'Codex Test', supported: true }],
    },
    {
      id: 'advanced',
      name: 'Advanced',
      description: '',
      ratio: 2,
      models: [{ id: 'codex-fast', name: 'Codex Fast', supported: true }],
    },
  ],
}
async function chooseFastModel() {
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  await userEvent.click(screen.getByRole('combobox', { name: 'Codex model' }))
  await userEvent.click(
    await screen.findByRole('option', { name: 'Codex Fast' })
  )
}

test('explicit model and effort choices survive project navigation, remount and the next task payload', async () => {
  const options = {
    desktop: true,
    availableProjects: true,
    modelStatus: preferenceStatus,
    modelCatalog: preferenceCatalog,
  }
  const first = await renderShell(options)
  await chooseFastModel()
  fireEvent.change(screen.getByRole('slider', { name: 'Reasoning effort' }), {
    target: { value: '0' },
  })
  await userEvent.keyboard('{Escape}')
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Fast·Low')
  await act(async () =>
    first.router.navigate({
      to: '/codex',
      search: { workspace: 'project-1', conversation: conversationId },
    })
  )
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Fast·Low')
  first.unmount()
  const second = await renderShell({ ...options, desktop: false })
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Fast·Low')
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Describe your coding task' }),
    'Use the chosen defaults'
  )
  await userEvent.click(screen.getByRole('button', { name: /^Start task$/ }))
  await waitFor(() =>
    expect(second.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/turns$/),
      expect.objectContaining({
        model: 'codex-fast',
        group: 'advanced',
        effort: 'low',
      }),
      expect.anything()
    )
  )
})

test('choosing a model with fewer tiers saves its compatible default effort', async () => {
  const first = await renderShell({
    modelStatus: preferenceStatus,
    modelCatalog: preferenceCatalog,
  })
  await chooseFastModel()
  expect(
    screen.getByRole('slider', { name: 'Reasoning effort' })
  ).toHaveAttribute('aria-valuetext', 'Medium')
  await userEvent.keyboard('{Escape}')
  first.unmount()
  await renderShell({
    modelStatus: preferenceStatus,
    modelCatalog: preferenceCatalog,
  })
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Fast·Medium')
})

test('an effort choice alone persists when opening a saved conversation', async () => {
  const shell = await renderShell({
    modelStatus: preferenceStatus,
    modelCatalog: preferenceCatalog,
  })
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  fireEvent.change(screen.getByRole('slider', { name: 'Reasoning effort' }), {
    target: { value: '0' },
  })
  await userEvent.keyboard('{Escape}')
  await act(async () =>
    shell.router.navigate({
      to: '/codex',
      search: { workspace: 'project-1', conversation: conversationId },
    })
  )
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Test·Low')
})

test('saved preferences are isolated from another account', async () => {
  localStorage.setItem(
    'codex-model-preferences:99',
    JSON.stringify({
      version: 1,
      model: 'codex-fast',
      group: 'advanced',
      effort: 'low',
    })
  )
  await renderShell({
    modelStatus: preferenceStatus,
    modelCatalog: preferenceCatalog,
  })
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Test·High')
})

test('unavailable storage keeps explicit model preferences in memory during project navigation', async () => {
  const shell = await renderShell({
    modelStatus: preferenceStatus,
    modelCatalog: preferenceCatalog,
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage unavailable', 'QuotaExceededError')
  })
  await chooseFastModel()
  await userEvent.keyboard('{Escape}')
  await act(async () =>
    shell.router.navigate({
      to: '/codex',
      search: { workspace: 'project-1', conversation: conversationId },
    })
  )
  expect(
    await screen.findByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Codex Fast·Medium')
})
