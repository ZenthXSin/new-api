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
import { Blob as NodeBlob } from 'node:buffer'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { WorkspaceFileEditor } from '../components/workspace-file-editor'

// jsdom's Blob lacks text(); use the platform Blob at this browser API boundary.
beforeEach(() => vi.stubGlobal('Blob', NodeBlob))
afterEach(() => vi.unstubAllGlobals())

function renderArtifact() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <WorkspaceFileEditor
        id='project'
        actor='owner'
        path='dist/Phira.ipa'
        creating={false}
        running={false}
        onBack={vi.fn()}
      />
    </QueryClientProvider>
  )
}

test('a binary artifact downloads its original bytes when text preview is unavailable', async () => {
  const bytes = new Blob([new Uint8Array([0x50, 0x4b, 0, 0xff])], {
    type: 'application/octet-stream',
  })
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/download')) return { data: bytes } as AxiosResponse
    return {
      data: {
        success: true,
        data: {
          path: 'dist/Phira.ipa',
          content: '',
          hash: null,
          size: 15_055_262,
          binary: true,
          truncated: true,
        },
      },
    } as AxiosResponse
  })
  const objectUrl = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValue('blob:artifact')
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  renderArtifact()
  await screen.findByText('Binary files cannot be edited as text.')
  expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
  expect(screen.queryByText('UTF-8')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Download file' }))
  await waitFor(() => expect(objectUrl).toHaveBeenCalledWith(bytes))
  expect(get).toHaveBeenCalledWith(
    '/api/codex/workspaces/project/download',
    expect.objectContaining({
      params: { path: 'dist/Phira.ipa' },
      responseType: 'blob',
    })
  )
})

test('a failed download shows the server error and can be retried without losing the artifact', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/download'))
      throw {
        response: {
          data: new Blob(
            [JSON.stringify({ message: 'File changed; retry download.' })],
            { type: 'application/json' }
          ),
        },
      }
    return {
      data: {
        success: true,
        data: {
          path: 'dist/Phira.ipa',
          content: '',
          hash: null,
          size: 2_000_000,
          truncated: true,
        },
      },
    } as AxiosResponse
  })
  renderArtifact()
  await screen.findByText(
    'This file is too large to preview. Download the original file.'
  )
  await userEvent.click(screen.getByRole('button', { name: 'Download file' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'File changed; retry download.'
  )
  expect(screen.getByRole('button', { name: 'Download file' })).toBeEnabled()
  expect(
    get.mock.calls.filter(([url]) => url.endsWith('/download'))
  ).toHaveLength(1)
})
