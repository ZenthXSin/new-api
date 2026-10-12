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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { GitPaneChangeCard } from '../vendor/zcode/inspector/git-pane-change-card'
import { parseUnifiedDiffLines } from '../vendor/zcode/inspector/patch-lines'

describe('ZCode change review adapted to New API patches', () => {
  test('source lines beginning with plus or minus remain visible and retain their hunk line numbers', () => {
    const preview = parseUnifiedDiffLines(
      'diff --git a/query.sql b/query.sql\n--- a/query.sql\n+++ b/query.sql\n@@ -80,2 +90,2 @@\n--- old SQL comment\n+++ new SQL comment\n unchanged\n'
    )
    expect(preview.lines).toEqual([
      '@@ -80,2 +90,2 @@',
      '--- old SQL comment',
      '+++ new SQL comment',
      ' unchanged',
    ])
    expect(preview.lineNumbers).toEqual(['', 80, 90, 91])
    expect(preview.added).toBe(1)
    expect(preview.removed).toBe(1)
    render(
      <GitPaneChangeCard
        path='query.sql'
        patch={'@@ -80 +90 @@\n--- old SQL comment\n+++ new SQL comment\n'}
      />
    )
    expect(screen.getByText('-- old SQL comment')).toBeVisible()
    expect(screen.getByText('++ new SQL comment')).toBeVisible()
  })
  test('a change header collapses and reopens its preview without opening another file', async () => {
    const open = vi.fn()
    const path = 'src/deep/feature/a-long-component-name.ts'
    render(
      <GitPaneChangeCard
        path={path}
        patch={'@@ -1 +1 @@\n-old\n+new\n'}
        onOpenFile={open}
      />
    )
    const toggle = screen.getByRole('button', { name: path })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: path })).toBeVisible()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: path })).not.toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    const region = screen.getByRole('region', { name: path })
    expect(within(region).getByText('new')).toBeVisible()
    expect(region).toHaveClass('overflow-auto', 'min-w-0')
    await userEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(open).toHaveBeenCalledWith(path)
  })
  test('a deleted file exposes its diff without offering an unavailable editor', () => {
    render(
      <GitPaneChangeCard
        path='removed.ts'
        patch={'@@ -1 +0,0 @@\n-deleted source\n'}
        deleted
        onOpenFile={vi.fn()}
      />
    )
    expect(screen.getByText('deleted source')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Open file' })
    ).not.toBeInTheDocument()
  })
  test('a rename-only patch preserves metadata instead of displaying an empty preview', () => {
    render(
      <GitPaneChangeCard
        path='new.ts'
        patch={
          'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
        }
      />
    )
    expect(screen.getByText('rename from old.ts')).toBeVisible()
    expect(screen.getByText('rename to new.ts')).toBeVisible()
  })
})
