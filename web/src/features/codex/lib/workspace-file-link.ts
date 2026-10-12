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
export type WorkspaceFileLink =
  | { type: 'file'; path: string; line?: number }
  | { type: 'unavailable' }

// Model output uses paths from the worker filesystem, not website routes.
// Resolve only inside the selected project; the file API enforces ownership
// and its own filesystem boundary again before reading.
export function resolveWorkspaceFileLink(
  href: string | undefined,
  workspaceId: string,
  remoteRoot?: string
): WorkspaceFileLink | null {
  if (!href?.trim()) return null
  let path = href.trim()
  if (/^(?:https?:)?\/\//i.test(path) || /^[#?]/.test(path)) return null
  if (/^file:\/\/\//i.test(path)) path = path.slice(7)
  else if (/^sandbox:\//i.test(path)) path = path.slice(8)
  else if (/^[a-z][a-z\d+.-]*:/i.test(path)) return null
  if (path.includes('?')) return null
  const hashIndex = path.indexOf('#')
  const fragment = hashIndex < 0 ? '' : path.slice(hashIndex + 1)
  path = hashIndex < 0 ? path : path.slice(0, hashIndex)
  try {
    path = decodeURIComponent(path)
  } catch {
    return { type: 'unavailable' }
  }
  let line: number | undefined
  const lineSuffix = path.match(/:(\d+)(?::\d+)?$/)
  if (lineSuffix) {
    line = Number(lineSuffix[1])
    path = path.slice(0, lineSuffix.index)
  } else {
    const lineFragment = fragment.match(/^L(\d+)(?:[-:]L?\d+)?$/i)
    if (lineFragment) line = Number(lineFragment[1])
  }
  if (
    [...path].some(
      (character) =>
        character === '\\' ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127
    ) ||
    (line !== undefined &&
      (!Number.isSafeInteger(line) || line < 1 || line > 10000000))
  ) {
    return { type: 'unavailable' }
  }
  if (path.startsWith('/')) {
    const root = (
      remoteRoot || `/workspace/projects/${workspaceId}/project`
    ).replace(/\/+$/, '')
    if (!path.startsWith(`${root}/`)) return { type: 'unavailable' }
    path = path.slice(root.length + 1)
  }
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return { type: 'unavailable' }
      segments.pop()
    } else segments.push(segment)
  }
  if (!segments.length || path.endsWith('/')) return { type: 'unavailable' }
  return { type: 'file', path: segments.join('/'), ...(line ? { line } : {}) }
}
