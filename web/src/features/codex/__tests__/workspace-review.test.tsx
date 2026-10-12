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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AxiosResponse } from 'axios'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { WorkspaceDiff } from '../components/workspace-diff'
import { decodeGitPath, parseWorkspaceChanges } from '../lib/workspace-review'

const clients: QueryClient[] = []
const response = (data: unknown) =>
  ({ data: { success: true, data } }) as AxiosResponse
const patch =
  'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-before\n+after\n'

function renderReview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceDiff
        id='project'
        actor='user'
        running={false}
        onOpenFile={vi.fn()}
      />
    </QueryClientProvider>
  )
}

afterEach(() => clients.splice(0).forEach((client) => client.clear()))

describe('Workspace diff paths', () => {
  test('Git C quoted UTF-8, escaped tabs, and literal Unicode decode to the exact file path', () => {
    expect(decodeGitPath('"b/\\344\\270\\255\\346\\226\\207\\t文件.ts"')).toBe(
      'b/中文\t文件.ts'
    )
  })
  test('rename metadata preserves a real a/ directory and missing binary patches stay in the review', () => {
    const changes = parseWorkspaceChanges({
      diff: 'diff --git a/old.txt b/a/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to a/new.txt\n',
      files: [
        { path: 'a/new.txt', status: 'R' },
        { path: 'image.png', status: 'M' },
      ],
    })
    expect(changes.map((change) => change.path)).toEqual([
      'a/new.txt',
      'image.png',
    ])
    expect(changes[1].patch).toBe('')
  })
})

describe('Workspace changes review controls', () => {
  test('a file without a text patch is visible and never renders the no-changes state', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      response({ diff: '', files: [{ path: 'image.png', status: 'M' }] })
    )
    renderReview()
    expect(
      await screen.findByRole('button', { name: 'image.png' })
    ).toBeVisible()
    expect(screen.getByText(/No text preview is available/)).toBeVisible()
    expect(screen.queryByText('No changes yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open file' })).toBeEnabled()
  })
  test('filtering the file index preserves the complete diff and selecting a file focuses its review card', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue(
      response({
        diff: patch,
        files: [
          { path: 'src/app.ts', status: 'M' },
          { path: 'image.png', status: 'M' },
        ],
      })
    )
    renderReview()
    await screen.findByText('after')
    const toggle = screen.getByRole('button', { name: 'Show changed files' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.type(
      screen.getByRole('searchbox', { name: 'Filter changed files' }),
      'image'
    )
    const list = screen.getByRole('navigation', { name: 'Changed file list' })
    expect(
      within(list).queryByRole('button', { name: 'Go to src/app.ts' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('after')).toBeVisible()
    await user.click(
      within(list).getByRole('button', { name: 'Go to image.png' })
    )
    expect(
      screen.getByRole('article', { name: 'Changes in image.png' })
    ).toHaveFocus()
  })
  test('marking a patch viewed resets after new content arrives and wrapping changes the code overflow behavior', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(
        response({ diff: patch, files: [{ path: 'src/app.ts', status: 'M' }] })
      )
      .mockResolvedValue(
        response({
          diff: patch.replace('after', 'latest'),
          files: [{ path: 'src/app.ts', status: 'M' }],
        })
      )
    renderReview()
    const viewed = await screen.findByRole('checkbox', {
      name: 'Mark src/app.ts as viewed',
    })
    await user.click(viewed)
    expect(screen.getByText('1 of 1 viewed')).toBeVisible()
    const wrap = screen.getByRole('button', { name: 'Wrap diff lines' })
    await user.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('after')).toHaveClass('whitespace-pre-wrap')
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText('latest')
    expect(viewed).not.toBeChecked()
    expect(screen.getByText('0 of 1 viewed')).toBeVisible()
  })
})
