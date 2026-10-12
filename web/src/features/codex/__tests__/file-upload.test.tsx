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
import { expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { WorkspaceFiles } from '../components/workspace-files'

const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
function setup(running = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <WorkspaceFiles id='project' actor='owner' running={running} />
    </QueryClientProvider>
  )
  return client
}
test('choosing a binary file uploads its original bytes and refreshes the visible file list', async () => {
  let uploaded = false
  vi.spyOn(api, 'get').mockImplementation(async () =>
    response({
      path: '',
      entries: uploaded
        ? [{ name: 'image.png', path: 'image.png', type: 'file', size: 4 }]
        : [],
    })
  )
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    uploaded = true
    return response({ path: 'image.png', size: 4 })
  })
  setup()
  await screen.findByText('This folder is empty.')
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x00, 0xff])],
    'image.png',
    { type: 'image/png' }
  )
  await userEvent.upload(screen.getByLabelText('Choose files to upload'), file)
  expect(await screen.findByRole('button', { name: /image.png/ })).toBeVisible()
  expect(post).toHaveBeenCalledWith(
    '/api/codex/workspaces/project/upload',
    file,
    expect.objectContaining({
      params: { path: 'image.png' },
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  )
  expect(screen.getByText('Files uploaded.')).toBeVisible()
})
test('dropping files in an open directory uploads into that directory', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (_, options) =>
    response({
      path: options?.params?.path || '',
      entries: options?.params?.path
        ? []
        : [{ name: 'assets', path: 'assets', type: 'directory', size: 0 }],
    })
  )
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue(response({ path: 'assets/image.png', size: 3 }))
  setup()
  await userEvent.click(await screen.findByRole('button', { name: /assets/ }))
  const file = new File(['abc'], 'image.png')
  fireEvent.drop(screen.getByRole('group', { name: 'Project files' }), {
    dataTransfer: { files: [file] },
  })
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/codex/workspaces/project/upload',
      file,
      expect.objectContaining({ params: { path: 'assets/image.png' } })
    )
  )
  expect(await screen.findByText('Files uploaded.')).toBeVisible()
})
test('a conflicting file remains rejected while successful files in the batch are reported', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
  vi.spyOn(api, 'post')
    .mockResolvedValueOnce(response({ path: 'new.txt', size: 3 }))
    .mockRejectedValueOnce({
      response: {
        data: {
          message: 'This file already exists. Rename it before uploading.',
        },
      },
    })
  setup()
  await userEvent.upload(screen.getByLabelText('Choose files to upload'), [
    new File(['new'], 'new.txt'),
    new File(['replacement'], 'existing.txt'),
  ])
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'existing.txt: This file already exists. Rename it before uploading.'
  )
  expect(screen.getByText('Files uploaded.')).toBeVisible()
  expect(screen.getByText('new.txt')).toBeVisible()
})
test('busy projects disable file selection and reject file drops', () => {
  vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
  const post = vi.spyOn(api, 'post')
  setup(true)
  expect(screen.getByRole('button', { name: 'Upload files' })).toBeDisabled()
  expect(screen.getByLabelText('Choose files to upload')).toBeDisabled()
  fireEvent.drop(screen.getByRole('group', { name: 'Project files' }), {
    dataTransfer: { files: [new File(['a'], 'a.txt')] },
  })
  expect(post).not.toHaveBeenCalled()
})
test('files beyond the upload limit show a useful error before making a request', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
  const post = vi.spyOn(api, 'post')
  const file = new File(['a'], 'large.bin')
  Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 })
  setup()
  await userEvent.upload(screen.getByLabelText('Choose files to upload'), file)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The file exceeds the upload limit.'
  )
  expect(post).not.toHaveBeenCalled()
})

test('uploading a project file invalidates the cached change review', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
  vi.spyOn(api, 'post').mockResolvedValue(
    response({ path: 'new.txt', size: 3 })
  )
  const client = setup()
  client.setQueryData(['codex', 'owner', 'project', 'diff'], {
    diff: '',
    files: [],
  })
  await userEvent.upload(
    screen.getByLabelText('Choose files to upload'),
    new File(['new'], 'new.txt')
  )
  await screen.findByText('Files uploaded.')
  expect(
    client.getQueryState(['codex', 'owner', 'project', 'diff'])?.isInvalidated
  ).toBe(true)
})

test('uploading announces a busy file operation until the upload and folder refresh finish', async () => {
  let finish: (value: AxiosResponse) => void = () => undefined
  vi.spyOn(api, 'post').mockImplementation(
    () =>
      new Promise<AxiosResponse>((resolve) => {
        finish = resolve
      })
  )
  vi.spyOn(api, 'get').mockResolvedValue(response({ path: '', entries: [] }))
  const busy = vi.fn()
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <WorkspaceFiles
        id='project'
        actor='owner'
        running={false}
        onBusy={busy}
      />
    </QueryClientProvider>
  )
  await userEvent.upload(
    screen.getByLabelText('Choose files to upload'),
    new File(['new'], 'new.txt')
  )
  expect(busy).toHaveBeenLastCalledWith(true)
  expect(screen.getByRole('button', { name: 'Upload files' })).toBeDisabled()
  await act(async () => finish(response({ path: 'new.txt', size: 3 })))
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false))
  expect(screen.getByRole('button', { name: 'Upload files' })).toBeEnabled()
})
