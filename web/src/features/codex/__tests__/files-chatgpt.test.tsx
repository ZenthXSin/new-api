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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { WorkspaceCodeEditor } from '../components/workspace-code-editor'
import { WorkspaceFileEditor } from '../components/workspace-file-editor'
import { WorkspaceFiles } from '../components/workspace-files'

const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse

const originalClientRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getClientRects'
)
const originalBoundingRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect'
)

beforeEach(() => {
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

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  })
}

describe('Canvas file navigation', () => {
  test('canceling a requested file change keeps the current draft and consumes the request', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url, options) => {
      if (url.endsWith('/files')) return response({ path: '', entries: [] })
      return response({
        path: options?.params?.path,
        content: 'original',
        hash: 'before',
      })
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const consumed = vi.fn()
    const client = createClient()
    const view = render(
      <QueryClientProvider client={client}>
        <WorkspaceFiles
          id='project'
          actor='owner'
          running={false}
          initialPath='first.ts'
          onPathConsumed={consumed}
        />
      </QueryClientProvider>
    )
    await screen.findByText('original')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('my unsaved draft')
    view.rerender(
      <QueryClientProvider client={client}>
        <WorkspaceFiles
          id='project'
          actor='owner'
          running={false}
          initialPath='second.ts'
          onPathConsumed={consumed}
        />
      </QueryClientProvider>
    )
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('my unsaved draft')
    expect(screen.getByText('first.ts')).toBeVisible()
    expect(consumed).toHaveBeenCalledTimes(2)
  })

  test('folder breadcrumbs return to the selected ancestor and clear the local filter', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (_, options) => {
      const directory = options?.params?.path || ''
      let entries = [{ name: 'src', path: 'src', type: 'directory', size: 0 }]
      if (directory === 'src') {
        entries = [
          {
            name: 'components',
            path: 'src/components',
            type: 'directory',
            size: 0,
          },
        ]
      }
      if (directory === 'src/components') {
        entries = [
          {
            name: 'main.ts',
            path: 'src/components/main.ts',
            type: 'file',
            size: 10,
          },
        ]
      }
      return response({ path: directory, entries })
    })
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFiles id='project' actor='owner' running={false} />
      </QueryClientProvider>
    )
    await userEvent.click(await screen.findByRole('button', { name: /^src/ }))
    await userEvent.click(
      await screen.findByRole('button', { name: /^components/ })
    )
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Filter files' }),
      'missing'
    )
    expect(screen.getByText('No matching files.')).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'Open folder src' })
    )
    expect(
      await screen.findByRole('button', { name: /^components/ })
    ).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Filter files' })).toHaveValue(
      ''
    )
  })
})

describe('Canvas file preservation', () => {
  test.each([
    {
      binary: true,
      truncated: false,
      message: 'Binary files cannot be edited as text.',
    },
    {
      binary: false,
      truncated: true,
      message: 'This file is too large to preview. Download the original file.',
    },
  ])(
    'a $binary binary and $truncated truncated response prevents editing and offers the original download',
    async (flags) => {
      vi.spyOn(api, 'get').mockResolvedValue(
        response({
          path: 'file.dat',
          content: 'partial',
          hash: 'hash',
          ...flags,
        })
      )
      const save = vi.spyOn(api, 'put')
      render(
        <QueryClientProvider client={createClient()}>
          <WorkspaceFileEditor
            id='project'
            actor='owner'
            path='file.dat'
            creating={false}
            running={false}
            onBack={vi.fn()}
          />
        </QueryClientProvider>
      )
      expect(await screen.findByText(flags.message)).toBeVisible()
      expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(
        screen.getByRole('button', { name: 'Download file' })
      ).toBeEnabled()
      expect(save).not.toHaveBeenCalled()
    }
  )

  test('closing a changed file asks before discarding and returns only after approval', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const back = vi.fn()
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='draft.ts'
          creating
          running={false}
          onBack={back}
        />
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close file' }))
    expect(back).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Close file' }))
    expect(back).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})

describe('Canvas file refresh', () => {
  test('a background refresh updates clean contents and preserves a dirty draft for hash conflict detection', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      response({ path: 'main.ts', content: 'original', hash: 'one' })
    )
    const save = vi
      .spyOn(api, 'put')
      .mockRejectedValue(new Error('File changed. Reload before saving.'))
    const client = createClient()
    render(
      <QueryClientProvider client={client}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='main.ts'
          creating={false}
          running={false}
          onBack={vi.fn()}
        />
      </QueryClientProvider>
    )
    await screen.findByText('original')
    act(() =>
      client.setQueryData(['codex', 'owner', 'project', 'file', 'main.ts'], {
        path: 'main.ts',
        content: 'fresh version',
        hash: 'two',
      })
    )
    expect(await screen.findByText('fresh version')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('my changes')
    act(() =>
      client.setQueryData(['codex', 'owner', 'project', 'file', 'main.ts'], {
        path: 'main.ts',
        content: 'changed elsewhere',
        hash: 'three',
      })
    )
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('my changes')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    expect(save).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/file',
      { path: 'main.ts', content: 'my changes', expectedHash: 'two' },
      expect.any(Object)
    )
  })

  test('reloading a conflicted file locks editing until the requested contents arrive', async () => {
    let finishReload: (value: AxiosResponse) => void = () => undefined
    const reload = new Promise<AxiosResponse>((resolve) => {
      finishReload = resolve
    })
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(
        response({ path: 'main.ts', content: 'original', hash: 'one' })
      )
      .mockImplementationOnce(() => reload)
    vi.spyOn(api, 'put').mockRejectedValue(
      new Error('File changed. Reload before saving.')
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='main.ts'
          creating={false}
          running={false}
          onBack={vi.fn()}
        />
      </QueryClientProvider>
    )
    await screen.findByText('original')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('my changes')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reload file' })
    )
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveAttribute('aria-readonly', 'true')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close file' })).toBeDisabled()
    await act(async () =>
      finishReload(
        response({ path: 'main.ts', content: 'updated contents', hash: 'two' })
      )
    )
    expect(await screen.findByText('updated contents')).toBeVisible()
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveAttribute('aria-readonly', 'false')
    expect(screen.getByRole('button', { name: 'Close file' })).toBeEnabled()
  })

  test('a failed reload leaves the dirty contents visible and downloadable', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValueOnce(
        response({ path: 'main.ts', content: 'original', hash: 'one' })
      )
    vi.spyOn(api, 'put').mockRejectedValue(
      new Error('File changed. Reload before saving.')
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='main.ts'
          creating={false}
          running={false}
          onBack={vi.fn()}
        />
      </QueryClientProvider>
    )
    await screen.findByText('original')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'File contents' })
    )
    await userEvent.keyboard('{Control>}a{/Control}')
    await userEvent.paste('keep these changes')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    get.mockRejectedValue(new Error('Network unavailable'))
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reload file' })
    )
    expect(await screen.findByText('Network unavailable')).toBeVisible()
    expect(
      screen.getByRole('textbox', { name: 'File contents' })
    ).toHaveTextContent('keep these changes')
    expect(screen.getByRole('button', { name: 'Download file' })).toBeEnabled()
  })
})

test('creating a cached existing filename keeps an empty draft and a null expected hash', async () => {
  const client = createClient()
  client.setQueryData(['codex', 'owner', 'project', 'file', 'existing.ts'], {
    path: 'existing.ts',
    content: 'existing file',
    hash: 'existing-hash',
  })
  const save = vi
    .spyOn(api, 'put')
    .mockRejectedValue(new Error('File already exists'))
  render(
    <QueryClientProvider client={client}>
      <WorkspaceFileEditor
        id='project'
        actor='owner'
        path='existing.ts'
        creating
        running={false}
        onBack={vi.fn()}
      />
    </QueryClientProvider>
  )
  expect(
    screen.getByRole('textbox', { name: 'File contents' })
  ).not.toHaveTextContent('existing file')
  expect(screen.getByText('Unsaved changes')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByRole('alert')
  expect(save).toHaveBeenCalledWith(
    '/api/codex/workspaces/project/file',
    { path: 'existing.ts', content: '', expectedHash: null },
    expect.any(Object)
  )
})

test('a read-only file can receive keyboard focus with a visible inset outline', async () => {
  render(
    <WorkspaceCodeEditor
      path='readme.md'
      value='Read this file'
      readOnly
      onChange={vi.fn()}
      onSave={vi.fn()}
    />
  )
  const contents = screen.getByRole('textbox', { name: 'File contents' })
  await userEvent.tab()
  expect(contents).toHaveFocus()
  const editor = contents.closest('.cm-editor')
  await waitFor(() => expect(editor).toHaveClass('cm-focused'))
  expect(editor).toHaveStyle({
    outline: '2px solid var(--ring)',
    outlineOffset: '-2px',
  })
  expect(contents).toHaveAttribute(
    'aria-description',
    'Press Escape, then Tab to leave the editor.'
  )
})

describe('File navigation and refresh regressions', () => {
  test('returning from an externally opened nested file shows its folder and restores focus to the file', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockImplementation(async (url, options) => {
        if (url.endsWith('/files')) {
          const path = options?.params?.path || ''
          return response({
            path,
            entries:
              path === 'src/components'
                ? [
                    {
                      name: 'main.ts',
                      path: 'src/components/main.ts',
                      type: 'file',
                      size: 8,
                    },
                  ]
                : [{ name: 'src', path: 'src', type: 'directory', size: 0 }],
          })
        }
        return response({
          path: 'src/components/main.ts',
          content: 'contents',
          hash: 'one',
        })
      })
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFiles
          id='project'
          actor='owner'
          running={false}
          initialPath='src/components/main.ts'
        />
      </QueryClientProvider>
    )
    await screen.findByText('contents')
    await userEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    const file = await screen.findByRole('button', { name: /^main.ts/ })
    expect(file).toHaveFocus()
    expect(
      screen.getByRole('button', { name: 'Open folder src/components' })
    ).toHaveAttribute('aria-current', 'location')
    expect(get).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/files',
      expect.objectContaining({ params: { path: 'src/components' } })
    )
  })

  test('a saved new file follows subsequent project refreshes', async () => {
    const client = createClient()
    vi.spyOn(api, 'get').mockResolvedValue(
      response({ path: 'new.ts', content: 'saved', hash: 'two' })
    )
    vi.spyOn(api, 'put').mockResolvedValue(
      response({ path: 'new.ts', content: 'saved', hash: 'two' })
    )
    render(
      <QueryClientProvider client={client}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='new.ts'
          creating
          running={false}
          onBack={vi.fn()}
        />
      </QueryClientProvider>
    )
    const editor = screen.getByRole('textbox', { name: 'File contents' })
    await userEvent.click(editor)
    await userEvent.paste('saved')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('File saved.')
    vi.spyOn(api, 'get').mockResolvedValue(
      response({ path: 'new.ts', content: 'changed by task', hash: 'three' })
    )
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['codex', 'owner', 'project', 'file', 'new.ts'],
      })
    })
    expect(await screen.findByText('changed by task')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('a new file path is checked together with the current folder before opening the editor', async () => {
    const directory = Array(10).fill('a'.repeat(100)).join('/')
    vi.spyOn(api, 'get').mockImplementation(async (_, options) =>
      response({
        path: options?.params?.path || '',
        entries: options?.params?.path
          ? []
          : [{ name: directory, path: directory, type: 'directory', size: 0 }],
      })
    )
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFiles id='project' actor='owner' running={false} />
      </QueryClientProvider>
    )
    await userEvent.click(
      await screen.findByRole('button', { name: directory })
    )
    await userEvent.click(screen.getByRole('button', { name: 'New file' }))
    await userEvent.click(
      screen.getByRole('textbox', { name: 'New file path' })
    )
    await userEvent.paste('long-file-name-over-limit.ts')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use a relative file path'
    )
    expect(
      screen.queryByRole('textbox', { name: 'File contents' })
    ).not.toBeInTheDocument()
  })

  test('opening the edit toggle places keyboard focus in the editor', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      response({ path: 'main.ts', content: 'original', hash: 'one' })
    )
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='main.ts'
          creating={false}
          running={false}
          onBack={vi.fn()}
        />
      </QueryClientProvider>
    )
    await screen.findByText('original')
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'File contents' })).toHaveFocus()
  })

  test('a file larger than the text editing limit keeps its draft and disables both save actions', async () => {
    const save = vi.spyOn(api, 'put')
    render(
      <QueryClientProvider client={createClient()}>
        <WorkspaceFileEditor
          id='project'
          actor='owner'
          path='large.txt'
          creating
          running={false}
          onBack={vi.fn()}
        />
      </QueryClientProvider>
    )
    const editor = screen.getByRole('textbox', { name: 'File contents' })
    await userEvent.click(editor)
    await userEvent.paste('界'.repeat(350000))
    expect(
      await screen.findByText('File exceeds the 1 MiB editing limit')
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true })
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Download file' })).toBeEnabled()
  })
})

test('archived projects retain readable files while disabling editing and upload actions', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) =>
    url.endsWith('/files')
      ? response({
          path: '',
          entries: [
            { name: 'main.ts', path: 'main.ts', type: 'file', size: 8 },
          ],
        })
      : response({ path: 'main.ts', content: 'original', hash: 'one' })
  )
  render(
    <QueryClientProvider client={createClient()}>
      <WorkspaceFiles id='project' actor='owner' running={false} readOnly />
    </QueryClientProvider>
  )
  expect(screen.getByRole('button', { name: 'Upload files' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled()
  await userEvent.click(await screen.findByRole('button', { name: /^main.ts/ }))
  await screen.findByText('original')
  expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Download file' })).toBeEnabled()
})

test('saving announces a busy file operation until the server confirms the saved content', async () => {
  let finish: (value: AxiosResponse) => void = () => undefined
  vi.spyOn(api, 'put').mockImplementation(
    () =>
      new Promise<AxiosResponse>((resolve) => {
        finish = resolve
      })
  )
  vi.spyOn(api, 'get').mockResolvedValue(
    response({ path: 'new.ts', content: '', hash: 'one' })
  )
  const busy = vi.fn()
  render(
    <QueryClientProvider client={createClient()}>
      <WorkspaceFileEditor
        id='project'
        actor='owner'
        path='new.ts'
        creating
        running={false}
        onBack={vi.fn()}
        onBusy={busy}
      />
    </QueryClientProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(busy).toHaveBeenLastCalledWith(true)
  expect(screen.getByRole('button', { name: 'Close file' })).toBeDisabled()
  await act(async () =>
    finish(response({ path: 'new.ts', content: '', hash: 'one' }))
  )
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false))
  expect(await screen.findByText('File saved.')).toBeVisible()
})
