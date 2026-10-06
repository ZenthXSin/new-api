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
import { getMarkdown, type MathOptions } from 'stream-markdown-parser'

const mathOptions = {
  strictDelimiters: true,
  escapeExclamation: false,
} satisfies MathOptions

type SingleLineMathState = {
  src: string
  bMarks: number[]
  eMarks: number[]
  tShift: number[]
  line: number
  push: (
    type: string,
    tag: string,
    nesting: number
  ) => {
    content: string
    markup: string
    raw?: string
    map: [number, number] | null
    block: boolean
  }
}

function singleLineExplicitMath(
  state: SingleLineMathState,
  startLine: number,
  _endLine: number,
  silent: boolean
): boolean {
  const line = state.src
    .slice(
      state.bMarks[startLine] + state.tShift[startLine],
      state.eMarks[startLine]
    )
    .trim()
  const match = /^\\\[(.+)\\\]$/.exec(line)
  if (!match) return false
  if (silent) return true
  const token = state.push('math_block', 'math', 0)
  token.content = match[1]
  token.markup = '\\[\\]'
  token.raw = line
  token.map = [startLine, startLine + 1]
  token.block = true
  state.line = startLine + 1
  return true
}

/** The parser contains mutable incremental state; each response owns one. */
export function createResponseParser(id: string) {
  const markdown = getMarkdown(id, { mathOptions })
  // Parser 1.1.3 strict mode handles multiline \[...\] but misses its valid
  // single-line form. Add only that explicit form; fences still win earlier.
  markdown.block.ruler.before(
    'math_block',
    'single_line_explicit_math',
    singleLineExplicitMath,
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] }
  )
  return markdown
}
