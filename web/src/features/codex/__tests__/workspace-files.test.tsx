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
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { CreateWorkspaceDialog } from '../components/create-workspace'
import { WorkspaceInspector } from '../components/workspace-inspector'

function renderFiles(running = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <WorkspaceInspector
        id='project'
        actor='admin'
        tab='files'
        running={running}
        thread={null}
        onTab={vi.fn()}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  )
  return { ...view, client }
}
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
function mockFiles() {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/files')) {
      return response({
        path: '',
        entries: [
          { name: 'index.ts', path: 'index.ts', type: 'file', size: 4 },
        ],
      })
    }
    return response({
      path: 'index.ts',
      content: 'old',
      hash: 'before',
      size: 3,
    })
  })
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
describe('Codex project files', () => {
  test('saving uses the displayed file hash and preserves edits on a conflict', async () => {
    mockFiles()
    const save = vi.spyOn(api, 'put').mockRejectedValue({
      response: { data: { message: 'File changed. Reload before saving.' } },
    })
    renderFiles()
    await userEvent.click(
      await screen.findByRole('button', { name: /index.ts/ })
    )
    await screen.findByText('old')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('my changes')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File changed')
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('my changes')
    expect(save).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/file',
      { path: 'index.ts', content: 'my changes', expectedHash: 'before' },
      expect.any(Object)
    )
  })
  test('a running task allows reading but disables file editing and creation', async () => {
    mockFiles()
    renderFiles(true)
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled()
    await userEvent.click(
      await screen.findByRole('button', { name: /index.ts/ })
    )
    await screen.findByText('old')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveAttribute('aria-readonly', 'true')
  })
  test('canceling the discard confirmation keeps the unsaved editor open', async () => {
    mockFiles()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderFiles()
    await userEvent.click(
      await screen.findByRole('button', { name: /index.ts/ })
    )
    await screen.findByText('old')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('unsaved')
    await userEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('unsaved')
  })
  test('new files send a null expected hash and become saved files after creation', async () => {
    mockFiles()
    const save = vi
      .spyOn(api, 'put')
      .mockResolvedValue(
        response({ path: 'new.ts', content: 'hello', hash: 'after', size: 5 })
      )
    renderFiles()
    await userEvent.click(screen.getByRole('button', { name: 'New file' }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'New file path' }),
      'new.ts'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('hello')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        '/api/codex/workspaces/project/file',
        { path: 'new.ts', content: 'hello', expectedHash: null },
        expect.any(Object)
      )
    )
    expect(await screen.findByText('File saved.')).toBeVisible()
  })
})

describe('Codex file review usability', () => {
  test('an empty folder offers a visible create action and a labeled file filter', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
    renderFiles()
    expect(await screen.findByText('This folder is empty.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Create a file' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Filter files' })).toBeVisible()
  })
  test('a failed file request offers retry without showing an empty editable file', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockRejectedValue(new Error('Network error'))
    renderFiles()
    expect(await screen.findByRole('alert')).toBeVisible()
    get.mockResolvedValue(
      response({
        path: '',
        entries: [
          { name: 'readme.md', path: 'readme.md', type: 'file', size: 2 },
        ],
      })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('button', { name: /readme.md/ })
    ).toBeVisible()
  })
  test('saving a newly created file shows a saved state and disables duplicate saves', async () => {
    mockFiles()
    vi.spyOn(api, 'put').mockResolvedValue(
      response({ path: 'new.ts', content: 'hello', hash: 'new-hash', size: 5 })
    )
    renderFiles()
    await userEvent.click(screen.getByRole('button', { name: 'New file' }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'New file path' }),
      'new.ts'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Unsaved changes')).toBeVisible()
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('hello')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('File saved.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
  test('new file paths cannot escape the displayed folder', async () => {
    mockFiles()
    renderFiles()
    await userEvent.click(screen.getByRole('button', { name: 'New file' }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'New file path' }),
      '../secret.txt'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use a relative file path without empty, dot, or parent segments.'
    )
    expect(
      screen.queryByRole('textbox', { name: 'File contents' })
    ).not.toBeInTheDocument()
  })
})

describe('Codex project creation', () => {
  test('blank projects do not submit a hidden repository and invalid names receive field feedback', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CreateWorkspaceDialog open onClose={vi.fn()} onCreate={create} />
      </QueryClientProvider>
    )
    expect(screen.getByRole('radio', { name: /Blank project/ })).toBeChecked()
    expect(
      screen.queryByRole('textbox', { name: 'Repository URL' })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a project name.'
    )
    expect(create).not.toHaveBeenCalled()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Website'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ name: 'Website' })
    )
  })
  test('repository mode validates HTTPS URLs and retains the entered values after a failed import', async () => {
    const create = vi.fn().mockRejectedValue(new Error('Could not import'))
    vi.spyOn(api, 'get').mockResolvedValue(
      response({
        configured: false,
        connected: false,
        scopes: [],
        capabilities: [],
      })
    )
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <CreateWorkspaceDialog open onClose={vi.fn()} onCreate={create} />
      </QueryClientProvider>
    )
    await userEvent.click(
      screen.getByRole('radio', { name: /Import repository/ })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Website'
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Repository URL' }),
      'http://github.com/owner/project'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a public HTTPS repository URL'
    )
    expect(create).not.toHaveBeenCalled()
    await userEvent.clear(
      screen.getByRole('textbox', { name: 'Repository URL' })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Repository URL' }),
      'https://github.com/owner/project'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    )
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'Website',
        repositoryUrl: 'https://github.com/owner/project',
      })
    )
    expect(await screen.findByRole('alert')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
      'Website'
    )
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toHaveValue(
      'https://github.com/owner/project'
    )
  })
})

function ReviewHarness(props: {
  tab: 'diff' | 'logs'
  thread?: import('../types').CodexThread
}) {
  const [tab, setTab] = useState<'diff' | 'files' | 'logs'>(props.tab)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={client}>
      <WorkspaceInspector
        id='project'
        actor='admin'
        running={false}
        tab={tab}
        onTab={setTab}
        onClose={vi.fn()}
        thread={props.thread || null}
      />
    </QueryClientProvider>
  )
}

describe('Codex change and command review', () => {
  test('opening a change uses its own patch path when the files summary has a different order', async () => {
    const patch =
      'diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/diff')) {
        return response({
          diff: patch,
          files: [
            { path: 'another.ts', status: 'A' },
            { path: 'first.ts', status: 'M' },
          ],
        })
      }
      if (url.endsWith('/files')) return response({ path: '', entries: [] })
      return response({
        path: 'first.ts',
        content: 'actual first file',
        hash: 'first-hash',
        size: 17,
      })
    })
    render(<ReviewHarness tab='diff' />)
    expect(await screen.findByText('first.ts')).toBeVisible()
    await userEvent.click(
      within(
        screen.getByRole('article', { name: 'Changes in first.ts' })
      ).getByRole('button', { name: 'Open file' })
    )
    expect(
      await screen.findByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('actual first file')
    expect(get).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/file',
      expect.objectContaining({ params: { path: 'first.ts' } })
    )
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })
  test('command history shows failure status with the exit code and keeps long output locally scrollable', () => {
    render(
      <ReviewHarness
        tab='logs'
        thread={{
          id: 'thread',
          turns: [
            {
              id: 'turn',
              status: 'completed',
              items: [
                {
                  id: 'command',
                  type: 'commandExecution',
                  status: 'completed',
                  command: 'npm test',
                  exitCode: 1,
                  aggregatedOutput: 'A test failed',
                },
              ],
            },
          ],
        }}
      />
    )
    expect(screen.getByText('Failed')).toBeVisible()
    expect(screen.getByText('Exit 1')).toBeVisible()
    expect(screen.getByText('A test failed')).toBeVisible()
  })
})

describe('Codex review keyboard and long content', () => {
  test('the file editor saves with the keyboard and leaving edit mode keeps the draft intact', async () => {
    mockFiles()
    const save = vi.spyOn(api, 'put').mockResolvedValue(
      response({
        path: 'index.ts',
        content: 'keyboard save',
        hash: 'next',
        size: 13,
      })
    )
    renderFiles()
    await userEvent.click(
      await screen.findByRole('button', { name: /index.ts/ })
    )
    await screen.findByText('old')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('keyboard save')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveAttribute('aria-readonly', 'true')
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('keyboard save')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'File contents' }), {
      key: 's',
      ctrlKey: true,
    })
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(await screen.findByText('File saved.')).toBeVisible()
  })
  test('panel arrow keys select and focus the next review tab', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(response({ diff: '', files: [] }))
    render(<ReviewHarness tab='diff' />)
    screen.getByRole('tab', { name: 'Changes' }).focus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Changes' }), {
      key: 'End',
    })
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Logs' })).toHaveFocus()
    )
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Logs')
  })
  test('a long file path remains identifiable and code scrolls inside its file panel', async () => {
    const path =
      'src/features/account/customer-support/project-history/very-long-project-file-name.ts'
    vi.spyOn(api, 'get').mockImplementation(async (url) =>
      url.endsWith('/files')
        ? response({
            path: '',
            entries: [{ name: path, path, type: 'file', size: 100 }],
          })
        : response({
            path,
            content: `const value = "${'x'.repeat(300)}"`,
            hash: 'hash',
            size: 316,
          })
    )
    renderFiles()
    await userEvent.click(
      await screen.findByRole('button', {
        name: new RegExp('very-long-project-file-name'),
      })
    )
    expect(screen.getByText('very-long-project-file-name.ts')).toBeVisible()
    const contents = await screen.findByRole('textbox', {
      name: 'File contents',
    })
    expect(contents).toHaveAttribute('aria-multiline', 'true')
    expect(contents.closest('.cm-editor')?.parentElement).toHaveClass(
      'min-w-0',
      'overflow-hidden',
      'w-full'
    )
  })
})

test('canceling a panel change keeps keyboard focus on the selected tab', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
  const onTab = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <WorkspaceInspector
        id='project'
        actor='admin'
        running={false}
        tab='files'
        onTab={onTab}
        onClose={vi.fn()}
        thread={null}
      />
    </QueryClientProvider>
  )
  screen.getByRole('tab', { name: 'Files' }).focus()
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Files' }), {
    key: 'ArrowRight',
  })
  expect(onTab).toHaveBeenCalledWith('logs')
  await waitFor(() =>
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveFocus()
  )
  expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('the code editor indents with Tab, saves on Control-S and preserves its cursor when switching read mode', async () => {
  mockFiles()
  const save = vi.spyOn(api, 'put').mockResolvedValue(
    response({
      path: 'index.ts',
      content: '  const count = 1',
      hash: 'after-indent',
      size: 17,
    })
  )
  renderFiles()
  await userEvent.click(await screen.findByRole('button', { name: /index.ts/ }))
  await screen.findByText('old')
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const editor = screen.getByRole('textbox', { name: 'File contents' })
  await userEvent.click(editor)
  await userEvent.keyboard('{Control>}a{/Control}')
  await userEvent.paste('const count = 1')
  fireEvent.keyDown(editor, { key: 'Tab' })
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/file',
      {
        path: 'index.ts',
        content: '  const count = 1',
        expectedHash: 'before',
      },
      expect.any(Object)
    )
  )
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
  expect(screen.getByRole('textbox', { name: 'File contents' })).toBe(editor)
  expect(editor).toHaveAttribute('aria-readonly', 'true')
  expect(editor.querySelector('span')).not.toBeNull()
})

test('code editor supports undo and redo without losing its displayed hash', async () => {
  mockFiles()
  const save = vi.spyOn(api, 'put').mockResolvedValue(
    response({
      path: 'index.ts',
      content: 'const changed = true',
      hash: 'after',
      size: 20,
    })
  )
  renderFiles()
  await userEvent.click(await screen.findByRole('button', { name: /index.ts/ }))
  await screen.findByText('old')
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const editor = screen.getByRole('textbox', { name: 'File contents' })
  await userEvent.click(editor)
  await userEvent.keyboard('{Control>}a{/Control}')
  await userEvent.paste('const changed = true')
  fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })
  expect(editor).toHaveTextContent('old')
  fireEvent.keyDown(editor, { key: 'y', ctrlKey: true })
  expect(editor).toHaveTextContent('const changed = true')
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/file',
      {
        path: 'index.ts',
        content: 'const changed = true',
        expectedHash: 'before',
      },
      expect.any(Object)
    )
  )
})
