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
import type { CodexDiff } from '../types'

export interface WorkspaceChange {
  path: string
  patch: string
  status: string
  deleted: boolean
}

/** Decode Git's C-quoted path without confusing UTF-8 octal bytes with Unicode. */
export function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes: number[] = []
  const encoder = new TextEncoder()
  const source = value.slice(1, -1)
  for (let index = 0; index < source.length; ) {
    if (source[index] !== '\\') {
      const character = String.fromCodePoint(source.codePointAt(index) ?? 0)
      bytes.push(...encoder.encode(character))
      index += character.length
      continue
    }
    const escape = source.slice(index + 1).match(/^([0-7]{1,3}|.)/s)?.[1]
    if (!escape) break
    const characters: Record<string, string> = {
      t: '\t',
      n: '\n',
      r: '\r',
      b: '\b',
      f: '\f',
      v: '\v',
      a: '\x07',
    }
    if (/^[0-7]+$/.test(escape)) bytes.push(Number.parseInt(escape, 8))
    else bytes.push(...encoder.encode(characters[escape] ?? escape))
    index += escape.length + 1
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/** Preserve every status entry even if binary data or size limits omit its patch. */
export function parseWorkspaceChanges(
  data: CodexDiff | undefined
): WorkspaceChange[] {
  if (!data) return []
  const changes: WorkspaceChange[] = []
  for (const patch of data.diff
    .split(/(?=^diff --git )/m)
    .filter((value) => value.trim())) {
    const lines = patch.split('\n')
    const newPath = lines
      .find((line) => line.startsWith('+++ '))
      ?.slice(4)
      .split('\t')[0]
    const oldPath = lines
      .find((line) => line.startsWith('--- '))
      ?.slice(4)
      .split('\t')[0]
    let path = newPath === '/dev/null' ? oldPath : newPath
    let stripPrefix = true
    if (!path) {
      path = lines.find((line) => line.startsWith('rename to '))?.slice(10)
      stripPrefix = !path
      if (!path) {
        path = lines[0]?.match(
          /^diff --git (?:"(?:[^"\\]|\\.)*"|.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/
        )?.[1]
      }
    }
    if (!path) continue
    path = decodeGitPath(path)
    if (stripPrefix && /^(a|b)\//.test(path)) path = path.slice(2)
    const status =
      data.files.find((file) => file.path === path)?.status ??
      (newPath === '/dev/null' ? 'D' : 'M')
    changes.push({
      path,
      patch,
      status,
      deleted: newPath === '/dev/null' || status === 'D',
    })
  }
  for (const file of data.files) {
    if (!changes.some((change) => change.path === file.path)) {
      changes.push({
        path: file.path,
        status: file.status,
        patch: '',
        deleted: file.status === 'D',
      })
    }
  }
  return changes
}
