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
import { getMarkdownTagMatches } from '@/lib/markdown-code-ranges'

interface ParsedThinkTags {
  visibleContent: string
  reasoning: string
  hasUnclosedTag: boolean
}

/**
 * Parse content to separate thinking from visible text.
 * Handles both complete and incomplete <think> tags.
 */
export function parseThinkTags(content: string): ParsedThinkTags {
  if (!content.includes('<think>')) {
    return { visibleContent: content, reasoning: '', hasUnclosedTag: false }
  }

  // An unfinished code span protects a literal opening tag while streaming,
  // but cannot swallow the real end of an already open reasoning section.
  const tags = getMarkdownTagMatches(
    content,
    /<\/?think>/g,
    (tag) => tag[0] === '</think>'
  )
  const visibleParts: string[] = []
  const reasoningParts: string[] = []
  let currentPos = 0
  let reasoningStart: number | null = null
  for (const tag of tags) {
    if (reasoningStart === null && tag[0] === '<think>') {
      visibleParts.push(content.slice(currentPos, tag.index))
      reasoningStart = tag.index + tag[0].length
    } else if (reasoningStart !== null && tag[0] === '</think>') {
      reasoningParts.push(content.slice(reasoningStart, tag.index))
      currentPos = tag.index + tag[0].length
      reasoningStart = null
    }
  }
  const hasUnclosedTag = reasoningStart !== null
  if (reasoningStart !== null) {
    reasoningParts.push(content.slice(reasoningStart))
  } else visibleParts.push(content.slice(currentPos))
  if (!reasoningParts.length) {
    return { visibleContent: content, reasoning: '', hasUnclosedTag: false }
  }

  return {
    visibleContent: visibleParts.join(''),
    reasoning: reasoningParts.join('\n\n').trim(),
    hasUnclosedTag,
  }
}
