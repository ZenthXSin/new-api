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
import { getMarkdown } from 'stream-markdown-parser'

type SourceRange = { start: number; end: number; incompleteInline?: boolean }
let markdown: ReturnType<typeof getMarkdown> | undefined

export function isMarkdownEscaped(source: string, offset: number): boolean {
  let backslashes = 0
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

/** Source offsets only: never reconstruct Markdown from normalized token text. */
export function getMarkdownCodeRanges(source: string): SourceRange[] {
  if (!markdown) {
    markdown = getMarkdown('new-api-code-ranges', {
      markdownItOptions: {
        html: false,
        linkify: false,
        typographer: false,
        stream: false,
      },
      enableMath: false,
      enableContainers: false,
      enableFixIndentedCodeBlock: false,
    })
  }
  const lineStarts = [0]
  for (const newline of source.matchAll(/\r\n?|\n/g)) {
    lineStarts.push(newline.index + newline[0].length)
  }
  const codeRanges: SourceRange[] = []
  const inlineRanges = new Map<string, SourceRange>()
  let tableRow: [number, number] | null = null
  for (const token of markdown.parse(source)) {
    if (token.type === 'tr_open') tableRow = token.map
    if (token.type === 'tr_close') tableRow = null
    const lines = token.map ?? (token.type === 'inline' ? tableRow : null)
    if (!lines) continue
    const range = {
      start: lineStarts[lines[0]] ?? source.length,
      end: lineStarts[lines[1]] ?? source.length,
    }
    if (token.type === 'fence' || token.type === 'code_block') {
      codeRanges.push(range)
    } else if (token.type === 'inline') {
      inlineRanges.set(`${range.start}:${range.end}`, range)
    }
  }
  // Inline code closes only with an equally long run. Escapes apply to the
  // opener, but a backslash inside code cannot escape its closing delimiter.
  for (const range of inlineRanges.values()) {
    let position = range.start
    while (position < range.end) {
      const start = source.indexOf('`', position)
      if (start < 0 || start >= range.end) break
      let markerEnd = start + 1
      while (markerEnd < range.end && source[markerEnd] === '`') markerEnd++
      position = markerEnd
      if (isMarkdownEscaped(source, start)) continue
      const length = markerEnd - start
      let end = markerEnd
      let closed = false
      while (end < range.end) {
        const next = source.indexOf('`', end)
        if (next < 0 || next >= range.end) break
        end = next + 1
        while (end < range.end && source[end] === '`') end++
        if (end - next === length) {
          closed = true
          break
        }
      }
      // During streaming, an unfinished code span must not turn a literal
      // <think> into hidden reasoning while its closing backtick is arriving.
      codeRanges.push({
        start,
        end: closed ? end : range.end,
        incompleteInline: !closed,
      })
      position = closed ? end : range.end
    }
  }
  return codeRanges.sort((left, right) => left.start - right.start)
}

export function getMarkdownTagMatches(
  source: string,
  pattern: RegExp,
  acceptIncompleteInline?: (tag: RegExpExecArray) => boolean
): RegExpExecArray[] {
  const matches = [...source.matchAll(pattern)]
  if (!matches.length) return []
  let ranges: SourceRange[]
  try {
    ranges = getMarkdownCodeRanges(source)
  } catch {
    // A parser failure must never hide or delete any part of the response.
    return []
  }
  let rangeIndex = 0
  return matches.filter((match) => {
    while (
      rangeIndex < ranges.length &&
      ranges[rangeIndex].end <= match.index
    ) {
      rangeIndex++
    }
    const range = ranges[rangeIndex]
    if (isMarkdownEscaped(source, match.index)) return false
    if (!range || match.index < range.start) return true
    return Boolean(range.incompleteInline && acceptIncompleteInline?.(match))
  })
}
