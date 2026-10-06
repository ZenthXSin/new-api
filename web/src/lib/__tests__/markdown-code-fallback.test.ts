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
import { describe, expect, test, vi } from 'vitest'

import { getMarkdownContent } from '@/components/ai-elements/response-content'
import { parseThinkTags } from '@/features/playground/lib/message/message-reasoning-utils'

vi.mock('stream-markdown-parser', () => ({
  getMarkdown: () => ({
    parse: () => {
      throw new Error('Parser unavailable')
    },
  }),
}))

describe('Markdown preprocessing parser failure', () => {
  test('preserves the entire response rather than deleting tags or hiding content when parsing fails', () => {
    const source =
      '<think>maybe reasoning</think>\n```xml\n<message>literal</message>\n```'
    expect(getMarkdownContent(source)).toBe(source)
    expect(parseThinkTags(source)).toEqual({
      visibleContent: source,
      reasoning: '',
      hasUnclosedTag: false,
    })
  })
})
