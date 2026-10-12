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
import { Dialog } from '@base-ui/react/dialog'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { WorkspaceDiff } from '../components/workspace-diff'
import { WorkspaceInspector } from '../components/workspace-inspector'
import { WorkspaceLogs } from '../components/workspace-logs'
import type { CodexThread } from '../types'

const patch =
  'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old source\n+new source\n'
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
const clients: QueryClient[] = []

function renderPanel(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function InspectorHarness() {
  const [tab, setTab] = useState<'files' | 'diff' | 'logs'>('logs')
  return (
    <WorkspaceInspector
      id='project'
      actor='user'
      running={false}
      thread={null}
      tab={tab}
      onTab={setTab}
      onClose={vi.fn()}
    />
  )
}

const thread: CodexThread = {
  id: 'thread',
  turns: [
    {
      id: 'turn',
      status: 'completed',
      items: [
        { id: 'message', type: 'agentMessage', text: 'Checking the project' },
        {
          id: 'first',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/workspace',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: '/workspace',
        },
        {
          id: 'second',
          type: 'commandExecution',
          command: 'bun test',
          cwd: '/workspace',
          status: 'completed',
          exitCode: 1,
          aggregatedOutput: 'One test failed\nExpected: 2\nReceived: 1',
        },
      ],
    },
  ],
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe('ChatGPT workspace panel navigation', () => {
  test('flat review tabs follow Changes Files Logs order and keyboard navigation selects their real panels', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) =>
      response(
        url.endsWith('/diff')
          ? { diff: '', files: [] }
          : { path: '', entries: [] }
      )
    )
    renderPanel(<InspectorHarness />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Changes',
      'Files',
      'Logs',
    ])
    expect(
      screen.queryByRole('tab', { name: 'Preview' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('tablist', { name: 'Project panels' }).parentElement
    ).toHaveClass('h-10', 'shrink-0')
    const selected = screen.getByRole('tab', { name: 'Logs' })
    expect(selected).toHaveClass('border-foreground')
    selected.focus()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Changes' })).toHaveFocus()
    )
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Changes')
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByText('No changes yet.')).toBeVisible()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Files' })).toHaveFocus()
    )
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Files')
    expect(screen.getByRole('group', { name: 'Project files' })).toBeVisible()
    await userEvent.keyboard('{End}')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Logs' })).toHaveFocus()
    )
    expect(screen.getByText('No commands yet.')).toBeVisible()
    await userEvent.keyboard('{Home}')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Changes' })).toHaveFocus()
    )
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Logs' })).toHaveFocus()
    )
  })

  test('rejected tab navigation preserves the selected tab and close uses its parent callback', async () => {
    const onTab = vi.fn()
    const onClose = vi.fn()
    renderPanel(
      <WorkspaceInspector
        id='project'
        actor='user'
        running={false}
        thread={null}
        tab='logs'
        onTab={onTab}
        onClose={onClose}
      />
    )
    const selected = screen.getByRole('tab', { name: 'Logs' })
    selected.focus()
    fireEvent.keyDown(selected, { key: 'ArrowLeft' })
    expect(onTab).toHaveBeenCalledWith('files')
    await waitFor(() => expect(selected).toHaveFocus())
    expect(selected).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(
      screen.getByRole('button', { name: 'Close project inspector' })
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('an unavailable environment explains why changes cannot load and does not request a diff', () => {
    const get = vi.spyOn(api, 'get')
    renderPanel(
      <WorkspaceInspector
        id='project'
        actor='user'
        running={false}
        diffBlocked
        thread={null}
        tab='diff'
        onTab={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Changes will be available when your environment is ready'
    )
    expect(
      screen.queryByRole('button', { name: 'Refresh changes' })
    ).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('ChatGPT workspace change review', () => {
  test('loading and empty changes expose status text and prevent downloading an empty patch', async () => {
    let resolveRequest: (value: AxiosResponse) => void = () => undefined
    vi.spyOn(api, 'get').mockReturnValue(
      new Promise<AxiosResponse>((resolve) => {
        resolveRequest = resolve
      })
    )
    renderPanel(
      <WorkspaceDiff
        id='project'
        actor='user'
        running={false}
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading changes...')
    expect(
      screen.getByRole('button', { name: 'Refresh changes' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Download patch' })
    ).toBeDisabled()
    resolveRequest(response({ diff: '', files: [] }))
    expect(await screen.findByText('No changes yet.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Refresh changes' })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Download patch' })
    ).toBeDisabled()
  })

  test('a failed request provides a retry that reveals the actual change preview', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockRejectedValueOnce({
        response: { data: { message: 'Environment unavailable' } },
      })
      .mockResolvedValue(
        response({ diff: patch, files: [{ path: 'src/app.ts', status: 'M' }] })
      )
    renderPanel(
      <WorkspaceDiff
        id='project'
        actor='user'
        running={false}
        onOpenFile={vi.fn()}
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Environment unavailable'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('new source')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(get).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/diff',
      expect.any(Object)
    )
  })

  test('change cards collapse with the keyboard while file actions preserve the path and omit deleted files', async () => {
    const openFile = vi.fn()
    const deleted =
      'diff --git a/removed.ts b/removed.ts\n--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted source\n'
    vi.spyOn(api, 'get').mockResolvedValue(
      response({
        diff: patch + deleted,
        files: [
          { path: 'removed.ts', status: 'D' },
          { path: 'src/app.ts', status: 'M' },
        ],
        truncated: true,
      })
    )
    renderPanel(
      <WorkspaceDiff
        id='project'
        actor='user'
        running={false}
        onOpenFile={openFile}
      />
    )
    const header = await screen.findByRole('button', { name: 'src/app.ts' })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'src/app.ts' })).toHaveClass(
      'overflow-auto',
      'min-w-0'
    )
    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'src/app.ts' })
    ).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByText('new source')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Open file' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(openFile).toHaveBeenCalledWith('src/app.ts')
    expect(
      screen.getByRole('region', { name: 'removed.ts' })
    ).toHaveTextContent('deleted source')
    expect(screen.getByRole('status')).toHaveTextContent(
      'This diff is truncated'
    )
  })

  test('refresh retrieves the current patch and download exports those exact bytes', async () => {
    const latestPatch = patch.replace('new source', 'updated source')
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(
        response({ diff: patch, files: [{ path: 'src/app.ts', status: 'M' }] })
      )
      .mockResolvedValue(
        response({
          diff: latestPatch,
          files: [{ path: 'src/app.ts', status: 'M' }],
        })
      )
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:workspace-patch')
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL
        static revokeObjectURL = vi.fn()
      }
    )
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    renderPanel(
      <WorkspaceDiff
        id='project'
        actor='user'
        running={false}
        onOpenFile={vi.fn()}
      />
    )
    await screen.findByText('new source')
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh changes' })
    )
    expect(await screen.findByText('updated source')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Download patch' })
    )
    expect(click.mock.instances[0]).toHaveAttribute(
      'download',
      'workspace.patch'
    )
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
    expect(blob).toBeInstanceOf(Blob)
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(String(reader.result)), {
        once: true,
      })
      if (blob) reader.readAsText(blob)
    })
    expect(contents).toBe(latestPatch)
  })
})

describe('ChatGPT command history', () => {
  test('empty command history shows a useful status and disables export', () => {
    render(<WorkspaceLogs thread={null} />)
    expect(screen.getByRole('status')).toHaveTextContent('No commands yet.')
    expect(screen.getByRole('button', { name: 'Download logs' })).toBeDisabled()
  })

  test('failed commands retain their output and exit code while copying sends the exact output', async () => {
    const user = userEvent.setup()
    const copy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    render(<WorkspaceLogs thread={thread} />)
    const first = screen.getByRole('button', { name: 'pwd' })
    const failed = screen.getByRole('button', { name: 'bun test' })
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(failed).toHaveAttribute('aria-expanded', 'true')
    expect(within(failed).getByText('Failed')).toBeVisible()
    expect(within(failed).getByText('Exit 1')).toBeVisible()
    expect(screen.getByRole('region', { name: 'bun test' })).toHaveClass(
      'overflow-auto',
      'min-w-0',
      'whitespace-pre-wrap'
    )
    await user.click(screen.getByRole('button', { name: 'Copy output' }))
    expect(copy).toHaveBeenCalledWith(
      'One test failed\nExpected: 2\nReceived: 1'
    )
    expect(screen.getByText('Copied')).toBeVisible()
    await user.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'pwd' })).toHaveTextContent(
      '/workspace'
    )
  })

  test('opening a modal after copying output hides background log controls from assistive technology', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    render(
      <>
        <WorkspaceLogs thread={thread} />
        <Dialog.Root>
          <Dialog.Trigger>Open project settings</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Popup>
              <Dialog.Title>Project settings</Dialog.Title>
              <Dialog.Description>Choose project options</Dialog.Description>
              <Dialog.Close>Close settings</Dialog.Close>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </>
    )
    await user.click(screen.getByRole('button', { name: 'Copy output' }))
    expect(screen.getByText('Copied')).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Open project settings' })
    )
    expect(
      await screen.findByRole('dialog', { name: 'Project settings' })
    ).toBeVisible()
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Copy output' })
      ).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeVisible()
  })

  test('export includes every command, its directory and exit result in chronological order', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:command-history')
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = createObjectURL
        static revokeObjectURL = vi.fn()
      }
    )
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined)
    render(<WorkspaceLogs thread={thread} />)
    await userEvent.click(screen.getByRole('button', { name: 'Download logs' }))
    expect(click.mock.instances[0]).toHaveAttribute(
      'download',
      'codex-command-history.txt'
    )
    const blob = createObjectURL.mock.calls[0]?.[0]
    expect(blob).toBeInstanceOf(Blob)
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.addEventListener('load', () => resolve(String(reader.result)), {
        once: true,
      })
      if (blob) reader.readAsText(blob)
    })
    expect(contents).toBe(
      'Working directory: /workspace\n$ pwd\n/workspace\nExit 0\n\nWorking directory: /workspace\n$ bun test\nOne test failed\nExpected: 2\nReceived: 1\nExit 1'
    )
  })

  test('a running log updates its output without reopening a user-collapsed command', async () => {
    const running: CodexThread = {
      id: 'thread',
      turns: [
        {
          id: 'turn',
          status: 'inProgress',
          items: [
            {
              id: 'command',
              type: 'commandExecution',
              command: 'bun build',
              status: 'inProgress',
              aggregatedOutput: 'Building',
            },
          ],
        },
      ],
    }
    const view = render(<WorkspaceLogs thread={running} />)
    const toggle = screen.getByRole('button', { name: 'bun build' })
    expect(screen.getByRole('status')).toHaveTextContent('Running')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    view.rerender(
      <WorkspaceLogs
        thread={{
          ...running,
          turns: [
            {
              ...running.turns[0],
              items: [
                {
                  ...running.turns[0].items[0],
                  aggregatedOutput: 'Building\nBuild complete',
                  status: 'completed',
                  exitCode: 0,
                },
              ],
            },
          ],
        }}
      />
    )
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: 'bun build' })).toHaveTextContent(
      'Build complete'
    )
    expect(within(toggle).getByText('Completed')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
