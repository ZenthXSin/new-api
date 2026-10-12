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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CloudSetupSession } from '../components/cloud-setup-session'
import type {
  CodexCatalog,
  CodexDetail,
  CodexStatus,
  CodexTurnInput,
} from '../types'
import { status, workspace } from './fixtures'

const clients: QueryClient[] = []

function response(data: unknown): AxiosResponse {
  return { data: { success: true, data } } as AxiosResponse
}

function setup(
  options: {
    initial?: Partial<CodexDetail>
    configuredStatus?: CodexStatus
    catalog?: CodexCatalog
    disabled?: boolean
    workspaceId?: string
  } = {}
) {
  const server = {
    detail: {
      workspace: { ...workspace, id: 'setup-workspace' },
      conversationId: 'setup-conversation',
      thread: null,
      pendingApprovals: [],
      nextCursor: 0,
      events: [],
      ...options.initial,
    } as CodexDetail,
    status: options.configuredStatus ?? status,
    catalog: options.catalog ?? {
      defaultGroup: 'default',
      defaultModel: 'codex-test',
      groups: [
        {
          id: 'default',
          name: 'Default',
          description: '',
          ratio: 1,
          models: [{ id: 'codex-test', name: 'Codex Test', supported: true }],
        },
      ],
    },
  }
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/codex/status') return response(server.status)
    if (url === '/api/codex/catalog') return response(server.catalog)
    if (url.endsWith('/events')) {
      return response({
        workspace: server.detail.workspace,
        conversationId: server.detail.conversationId,
        pendingApprovals: server.detail.pendingApprovals,
        nextCursor: server.detail.nextCursor,
        events: [],
      })
    }
    return response(server.detail)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url, input) => {
    if (url.endsWith('/turns')) {
      const turn = input as CodexTurnInput
      server.detail = {
        ...server.detail,
        workspace: { ...server.detail.workspace, status: 'running' },
        nextCursor: server.detail.nextCursor + 1,
        thread: {
          id: 'setup-thread',
          turns: [
            ...(server.detail.thread?.turns ?? []),
            {
              id: 'setup-turn',
              status: 'inProgress',
              items: [
                {
                  id: 'setup-message',
                  type: 'userMessage',
                  content: [{ type: 'text', text: turn.prompt }],
                },
              ],
            },
          ],
        },
      }
      return response({
        workspace: server.detail.workspace,
        turnId: 'setup-turn',
      })
    }
    if (url.endsWith('/interrupt')) {
      server.detail = {
        ...server.detail,
        workspace: { ...server.detail.workspace, status: 'interrupted' },
        nextCursor: server.detail.nextCursor + 1,
      }
      return response({ workspace: server.detail.workspace })
    }
    if (url.includes('/approvals/')) {
      server.detail = {
        ...server.detail,
        workspace: { ...server.detail.workspace, status: 'running' },
        pendingApprovals: [],
        nextCursor: server.detail.nextCursor + 1,
      }
      return response({})
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, gcTime: Infinity },
    },
  })
  clients.push(client)
  const onActivity = vi.fn()
  const view = render(
    <QueryClientProvider client={client}>
      <CloudSetupSession
        workspaceId={options.workspaceId ?? 'setup-workspace'}
        actor='setup-user'
        disabled={options.disabled}
        onActivity={onActivity}
      />
    </QueryClientProvider>
  )
  return { ...view, client, server, get, post, onActivity }
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

describe('Cloud setup session', () => {
  test('an empty session offers an editable repository check and sends it to the setup conversation with configured model defaults', async () => {
    const user = userEvent.setup()
    const view = setup()
    const prompt = await screen.findByRole('textbox', {
      name: 'Message Codex about this environment',
    })
    await waitFor(() => expect(prompt).toBeEnabled())
    expect(
      screen.getByRole('heading', {
        name: 'Prepare your environment with Codex',
      })
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Check repositories' }))
    expect(prompt).toHaveFocus()
    expect(prompt).toHaveValue(
      'Inspect the repositories and summarize what this environment needs to run and test them.'
    )
    expect(view.post).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(view.post).toHaveBeenCalledWith(
        '/api/codex/workspaces/setup-workspace/turns',
        expect.objectContaining({
          prompt:
            'Inspect the repositories and summarize what this environment needs to run and test them.',
          model: 'codex-test',
          effort: 'high',
          group: 'default',
          mode: 'code',
          requestId: expect.any(String),
        }),
        expect.objectContaining({
          params: { conversation: 'setup-conversation' },
        })
      )
    )
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Task conversation' })
      ).toHaveTextContent('Inspect the repositories')
    )
    await waitFor(() => expect(prompt).toHaveValue(''))
    expect(view.onActivity).toHaveBeenCalled()
  })

  test('a running setup can be stopped through the same conversation and becomes ready after the server confirms', async () => {
    const user = userEvent.setup()
    const view = setup({
      initial: {
        workspace: { ...workspace, id: 'setup-workspace', status: 'running' },
      },
    })
    const stop = await screen.findByRole('button', { name: 'Stop task' })
    await user.click(stop)
    await waitFor(() =>
      expect(view.post).toHaveBeenCalledWith(
        '/api/codex/workspaces/setup-workspace/interrupt',
        {},
        expect.objectContaining({
          params: { conversation: 'setup-conversation' },
        })
      )
    )
    expect(
      await screen.findByRole('button', { name: 'Send message' })
    ).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Stop task' })
    ).not.toBeInTheDocument()
    expect(view.onActivity).toHaveBeenCalled()
  })

  test('a command approval posts the users explicit allow-once decision and removes the resolved approval', async () => {
    const view = setup({
      initial: {
        workspace: {
          ...workspace,
          id: 'setup-workspace',
          status: 'waiting_approval',
        },
        pendingApprovals: [
          {
            id: 'dependency-install',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'bun install', cwd: '/workspace/app' },
          },
        ],
      },
    })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Allow once' })
    )
    await waitFor(() =>
      expect(view.post).toHaveBeenCalledWith(
        '/api/codex/workspaces/setup-workspace/approvals/dependency-install',
        { decision: 'accept' },
        expect.objectContaining({
          params: { conversation: 'setup-conversation' },
        })
      )
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Approval required' })
      ).not.toBeInTheDocument()
    )
  })

  test('a failed message retains its draft and request id so retry cannot create a duplicate setup turn', async () => {
    const user = userEvent.setup()
    const view = setup()
    view.post.mockRejectedValue(new Error('The setup request failed'))
    const prompt = screen.getByRole('textbox', {
      name: 'Message Codex about this environment',
    })
    await waitFor(() => expect(prompt).toBeEnabled())
    await user.type(prompt, 'Check build dependencies')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The setup request failed'
    )
    expect(prompt).toHaveValue('Check build dependencies')
    const request = view.post.mock.calls[0]?.[1] as CodexTurnInput
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(view.post).toHaveBeenCalledTimes(2))
    expect(view.post.mock.calls[1]?.[1]).toEqual(request)
  })

  test('an in-flight message prevents another send until the first request resolves', async () => {
    const user = userEvent.setup()
    const view = setup()
    let resolve!: (value: AxiosResponse) => void
    view.post.mockReturnValue(
      new Promise<AxiosResponse>((complete) => {
        resolve = complete
      })
    )
    const prompt = screen.getByRole('textbox', {
      name: 'Message Codex about this environment',
    })
    await waitFor(() => expect(prompt).toBeEnabled())
    await user.type(prompt, 'Install dependencies')
    await user.keyboard('{Enter}{Enter}')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Send message' })
      ).toBeDisabled()
    )
    expect(
      screen.getByRole('region', { name: 'Setup session' })
    ).toHaveAttribute('aria-busy', 'true')
    expect(prompt).toHaveAttribute('readonly')
    expect(view.post).toHaveBeenCalledTimes(1)
    await act(async () =>
      resolve(
        response({
          workspace: view.server.detail.workspace,
          turnId: 'setup-turn',
        })
      )
    )
    await waitFor(() => expect(prompt).toHaveValue(''))
  })

  test('Shift+Enter and input-method composition do not send incomplete messages', async () => {
    const user = userEvent.setup()
    const view = setup()
    const prompt = screen.getByRole('textbox', {
      name: 'Message Codex about this environment',
    })
    await waitFor(() => expect(prompt).toBeEnabled())
    await user.type(prompt, 'Check scripts')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(prompt).toHaveValue('Check scripts\n')
    fireEvent.keyDown(prompt, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(prompt, { key: 'Enter', keyCode: 229 })
    expect(view.post).not.toHaveBeenCalled()
  })

  test('a disabled setup keeps visible approvals and conversation readable while preventing all writes', async () => {
    const view = setup({
      disabled: true,
      initial: {
        workspace: {
          ...workspace,
          id: 'setup-workspace',
          status: 'waiting_approval',
        },
        pendingApprovals: [
          {
            id: 'dependency-install',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'bun install' },
          },
        ],
      },
    })
    const allow = await screen.findByRole('button', { name: 'Allow once' })
    expect(allow).toBeDisabled()
    expect(
      screen.getByRole('textbox', {
        name: 'Message Codex about this environment',
      })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop task' })).toBeDisabled()
    await userEvent.click(allow)
    expect(view.post).not.toHaveBeenCalled()
  })

  test('a workspace without a setup id explains preparation and never requests an empty workspace URL', () => {
    const view = setup({ workspaceId: '' })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Prepare this environment to start a setup session.'
    )
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(view.get).not.toHaveBeenCalled()
  })

  test('loading failure offers retry and enables the input only after a current snapshot succeeds', async () => {
    const view = setup()
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    view.get.mockRejectedValue(new Error('Unable to load setup session'))
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['codex', 'setup-user'] })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load setup session'
    )
    expect(screen.getByRole('textbox')).toBeDisabled()
    view.get.mockImplementation(async (url) => {
      if (url.endsWith('/status')) return response(status)
      if (url.endsWith('/catalog')) return response(view.server.catalog)
      return response(view.server.detail)
    })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('loss of the event connection preserves the visible transcript and reconnects when the browser returns online', async () => {
    const view = setup({
      initial: {
        thread: {
          id: 'setup-thread',
          turns: [
            {
              id: 'inspected',
              status: 'completed',
              items: [
                {
                  id: 'response',
                  type: 'agentMessage',
                  text: 'Dependencies are installed.',
                },
              ],
            },
          ],
        },
      },
    })
    await screen.findByText('Dependencies are installed.')
    const online = vi
      .spyOn(window.navigator, 'onLine', 'get')
      .mockReturnValue(false)
    await act(async () => window.dispatchEvent(new Event('offline')))
    expect(
      screen.getByText(
        'Connection interrupted. Reconnecting; your task continues on the server.'
      )
    ).toBeVisible()
    expect(screen.getByText('Dependencies are installed.')).toBeVisible()
    online.mockReturnValue(true)
    await act(async () => window.dispatchEvent(new Event('online')))
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Connection interrupted. Reconnecting; your task continues on the server.'
        )
      ).not.toBeInTheDocument()
    )
    expect(view.post).not.toHaveBeenCalled()
  })

  test('switching to another setup workspace discards the old draft and isolates the new conversation', async () => {
    const user = userEvent.setup()
    const view = setup()
    const prompt = screen.getByRole('textbox', {
      name: 'Message Codex about this environment',
    })
    await waitFor(() => expect(prompt).toBeEnabled())
    await user.type(prompt, 'Only for the original environment')
    view.server.detail = {
      ...view.server.detail,
      workspace: { ...workspace, id: 'other-workspace' },
      conversationId: 'other-conversation',
    }
    view.rerender(
      <QueryClientProvider client={view.client}>
        <CloudSetupSession workspaceId='other-workspace' actor='setup-user' />
      </QueryClientProvider>
    )
    const nextPrompt = screen.getByRole('textbox', {
      name: 'Message Codex about this environment',
    })
    await waitFor(() => expect(nextPrompt).toBeEnabled())
    expect(nextPrompt).toHaveValue('')
    await user.type(nextPrompt, 'Check this environment{Enter}')
    await waitFor(() =>
      expect(view.post).toHaveBeenCalledWith(
        '/api/codex/workspaces/other-workspace/turns',
        expect.objectContaining({ prompt: 'Check this environment' }),
        expect.objectContaining({
          params: { conversation: 'other-conversation' },
        })
      )
    )
  })

  test('an unavailable Codex status displays the service reason and prevents starting work', async () => {
    const view = setup({
      configuredStatus: {
        ...status,
        available: false,
        reason: 'No models are configured',
      },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No models are configured'
    )
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(view.post).not.toHaveBeenCalled()
  })

  test('an unsupported configured model falls back to a supported model in the account default group', async () => {
    const user = userEvent.setup()
    const view = setup({
      catalog: {
        defaultGroup: 'personal',
        defaultModel: 'personal-codex',
        groups: [
          {
            id: 'other',
            name: 'Other',
            description: '',
            ratio: 1,
            models: [
              { id: 'other-codex', name: 'Other Codex', supported: true },
            ],
          },
          {
            id: 'personal',
            name: 'Personal',
            description: '',
            ratio: 1,
            models: [
              { id: 'codex-test', name: 'Unavailable Codex', supported: false },
              { id: 'personal-codex', name: 'Personal Codex', supported: true },
            ],
          },
        ],
      },
    })
    const prompt = screen.getByRole('textbox')
    await waitFor(() => expect(prompt).toBeEnabled())
    await user.type(prompt, 'Inspect dependencies{Enter}')
    await waitFor(() =>
      expect(view.post).toHaveBeenCalledWith(
        '/api/codex/workspaces/setup-workspace/turns',
        expect.objectContaining({
          model: 'personal-codex',
          group: 'personal',
          effort: 'high',
        }),
        expect.anything()
      )
    )
  })

  test('an empty account model catalog cannot send a setup task using an inaccessible static default', async () => {
    const view = setup({
      catalog: { groups: [], defaultGroup: '', defaultModel: '' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Codex is unavailable'
    )
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(view.post).not.toHaveBeenCalled()
  })

  test('a validation error describes an oversized message without sending it', async () => {
    const view = setup()
    const prompt = screen.getByRole('textbox')
    await waitFor(() => expect(prompt).toBeEnabled())
    fireEvent.change(prompt, { target: { value: 'x'.repeat(100_001) } })
    fireEvent.submit(prompt.closest('form') as HTMLFormElement)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a message of up to 100,000 characters.'
    )
    expect(prompt).toHaveAttribute('aria-invalid', 'true')
    expect(prompt).toHaveAccessibleDescription(
      expect.stringContaining('Enter a message of up to 100,000 characters.')
    )
    expect(view.post).not.toHaveBeenCalled()
  })
})
