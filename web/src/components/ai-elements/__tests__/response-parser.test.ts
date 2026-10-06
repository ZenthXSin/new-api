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
import { parseMarkdownToStructure } from 'stream-markdown-parser'
import { describe, expect, test } from 'vitest'

import { createResponseParser } from '../response-parser'

describe('response parser state', () => {
  test('keeps incremental state when another message finishes with the same label', () => {
    const first = createResponseParser('same-label')
    const second = createResponseParser('same-label')
    expect(first).not.toBe(second)
    const start = '# First\n\nInitial paragraph\n\n'
    parseMarkdownToStructure(start, first, { final: false })
    parseMarkdownToStructure('# Other\n\nUnrelated paragraph', second, {
      final: true,
    })
    const nodes = parseMarkdownToStructure(
      `${start}Appended paragraph`,
      first,
      { final: false }
    )
    expect(first.stream?.stats?.()).toMatchObject({
      fullParses: 1,
      resets: 0,
      lastMode: 'tail',
    })
    expect(JSON.stringify(nodes)).toContain('Appended paragraph')
    expect(JSON.stringify(nodes)).not.toContain('Unrelated')
  })

  test('treats bare bracket notation as text and keeps explicit math delimiters', () => {
    const parser = createResponseParser('delimiters')
    const plain = parseMarkdownToStructure('[x^2]', parser, { final: true })
    expect(plain[0].type).toBe('paragraph')
    const math = parseMarkdownToStructure('$$x^2$$', parser, { final: true })
    expect(math[0].type).toBe('math_block')
    const brackets = parseMarkdownToStructure('\\[x^2\\]', parser, {
      final: true,
    })
    expect(brackets[0]).toMatchObject({
      type: 'math_block',
      content: 'x^2',
      raw: '\\[x^2\\]',
    })
  })
})
