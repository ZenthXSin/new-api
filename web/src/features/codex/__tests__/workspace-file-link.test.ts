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
import { describe, expect, test } from 'vitest'

import { resolveWorkspaceFileLink } from '../lib/workspace-file-link'

describe('project file links', () => {
  test.each([
    [
      '/workspace/projects/project-1/project/整理文档.md:236',
      { type: 'file', path: '整理文档.md', line: 236 },
    ],
    [
      '/workspace/projects/project-1/project/docs/%E6%95%B4%E7%90%86.md#L12',
      { type: 'file', path: 'docs/整理.md', line: 12 },
    ],
    ['./src/../README.md:3:5', { type: 'file', path: 'README.md', line: 3 }],
    [
      'sandbox:/workspace/projects/project-1/project/docs/guide.md',
      { type: 'file', path: 'docs/guide.md' },
    ],
    [
      'file:///workspace/projects/project-1/project/docs/guide.md',
      { type: 'file', path: 'docs/guide.md' },
    ],
  ])('resolves %s within the selected project', (href, expected) => {
    expect(resolveWorkspaceFileLink(href, 'project-1')).toEqual(expected)
  })
  test.each([
    '/workspace/projects/project-2/project/private.md',
    '/workspace/projects/project-1/project-other/private.md',
    '/workspace/projects/project-1/project/../private.md',
    '../private.md',
    '%2e%2e/private.md',
    '/etc/passwd',
    'docs/%00private.md',
    'docs/guide.md:0',
    'docs/%invalid.md',
  ])('refuses an invalid or out-of-project path %s', (href) => {
    expect(resolveWorkspaceFileLink(href, 'project-1')).toEqual({
      type: 'unavailable',
    })
  })
  test.each([
    'https://example.com/a.md',
    '//example.com/a.md',
    'mailto:hello@example.com',
    '#section',
    'javascript:alert(1)',
    'data:text/html,unsafe',
  ])(
    'leaves normal URLs and scheme filtering to the Markdown renderer for %s',
    (href) => {
      expect(resolveWorkspaceFileLink(href, 'project-1')).toBeNull()
    }
  )
  test('decodes a URL-encoded line separator without including it in the file path', () => {
    expect(resolveWorkspaceFileLink('docs/guide.md%3A12', 'project-1')).toEqual(
      { type: 'file', path: 'docs/guide.md', line: 12 }
    )
  })
  test('uses the configured remote directory rather than a Docker path', () => {
    expect(
      resolveWorkspaceFileLink(
        '/root/project/docs/setup.md:4',
        'remote-project',
        '/root/project'
      )
    ).toEqual({ type: 'file', path: 'docs/setup.md', line: 4 })
    expect(
      resolveWorkspaceFileLink(
        '/root/other/secret.md',
        'remote-project',
        '/root/project'
      )
    ).toEqual({ type: 'unavailable' })
  })
})
