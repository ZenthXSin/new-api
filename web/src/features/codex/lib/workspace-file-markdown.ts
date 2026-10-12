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
import type { Nodes, Root } from 'mdast'

import { resolveWorkspaceFileLink } from './workspace-file-link'

// Rewrite validated file references while they are Markdown links, before the
// HTML sanitizer rejects worker-only schemes. Images, HTML and unsafe schemes
// continue through Streamdown's existing sanitizer unchanged.
export function workspaceFileMarkdown(options: {
  workspaceId: string
  remoteRoot?: string
}) {
  return (tree: Root) => {
    function visit(node: Nodes) {
      if (node.type === 'link') {
        const file = resolveWorkspaceFileLink(
          node.url,
          options.workspaceId,
          options.remoteRoot
        )
        if (file?.type === 'file') {
          node.url = `${(options.remoteRoot || `/workspace/projects/${options.workspaceId}/project`).replace(/\/+$/, '')}/${file.path.split('/').map(encodeURIComponent).join('/')}${file.line ? `:${file.line}` : ''}`
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}
