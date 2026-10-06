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

import { parseThinkTags } from '../message-reasoning-utils'

describe('thinking tags outside Markdown code', () => {
  test.each([
    ['fenced code', '```xml\n<think>literal</think>\n```'],
    ['inline code', 'Use `<think>literal</think>` in the XML document.'],
    ['indented code', 'Example:\n\n    <think>literal</think>'],
    ['unfinished fenced code', '```xml\n<think>literal'],
    ['quoted code', '> ```xml\n> <think>literal</think>\n> ```'],
    ['list code', '- Example:\n\n  ```xml\n  <think>literal</think>\n  ```'],
  ])(
    'keeps %s visible instead of consuming it as reasoning',
    (_label, source) => {
      expect(parseThinkTags(source)).toEqual({
        visibleContent: source,
        reasoning: '',
        hasUnclosedTag: false,
      })
    }
  )
  test('extracts real reasoning while preserving code containing thinking tags', () => {
    const code = '```xml\n<think>literal</think>\n```'
    expect(parseThinkTags(`<think>Check the format.</think>\n${code}`)).toEqual(
      {
        visibleContent: `\n${code}`,
        reasoning: 'Check the format.',
        hasUnclosedTag: false,
      }
    )
  })
  test('does not finish reasoning on a closing tag shown in a code example', () => {
    const thought = 'Discuss the closing tag `</think>` before answering.'
    expect(parseThinkTags(`<think>${thought}</think>Answer`)).toEqual({
      visibleContent: 'Answer',
      reasoning: thought,
      hasUnclosedTag: false,
    })
  })
  test('keeps real unfinished reasoning hidden while code tags stay literal', () => {
    const thought = 'Example `</think>` is only code; still thinking'
    expect(parseThinkTags(`<think>${thought}`)).toEqual({
      visibleContent: '',
      reasoning: thought,
      hasUnclosedTag: true,
    })
  })
  test('keeps original whitespace and CRLF when all thinking tags are code', () => {
    const source = '  Example:\r\n\r\n```xml\r\n<think>x</think>\r\n```\r\n'
    expect(parseThinkTags(source).visibleContent).toBe(source)
  })
  test('keeps a thinking tag inside an unfinished inline code span visible during streaming', () => {
    const source = 'Example `<think>literal'
    expect(parseThinkTags(source)).toEqual({
      visibleContent: source,
      reasoning: '',
      hasUnclosedTag: false,
    })
  })
  test('does not let an unmatched inline backtick consume a later reasoning paragraph', () => {
    const source =
      'A literal ` punctuation.\n\n<think>real reasoning</think>Answer'
    expect(parseThinkTags(source)).toEqual({
      visibleContent: 'A literal ` punctuation.\n\nAnswer',
      reasoning: 'real reasoning',
      hasUnclosedTag: false,
    })
  })
  test('handles multiple real reasoning sections around literal code without losing order', () => {
    const source =
      '<think>First.</think>One `<think>literal</think>`<think>Second.</think>Two'
    expect(parseThinkTags(source)).toEqual({
      visibleContent: 'One `<think>literal</think>`Two',
      reasoning: 'First.\n\nSecond.',
      hasUnclosedTag: false,
    })
  })
  test('does not extract escaped thinking delimiters from visible text', () => {
    const source = String.raw`Write \<think>reasoning\</think> in documentation.`
    expect(parseThinkTags(source)).toEqual({
      visibleContent: source,
      reasoning: '',
      hasUnclosedTag: false,
    })
  })
  test('preserves leading indentation after real reasoning is removed', () => {
    const source =
      '<think>Done.</think>    <message>code remains indented</message>\n'
    expect(parseThinkTags(source).visibleContent).toBe(
      '    <message>code remains indented</message>\n'
    )
  })
  test('ends real reasoning after an unmatched inline backtick so the answer remains visible', () => {
    const thought = 'I considered ` without closing it.'
    expect(parseThinkTags(`<think>${thought}</think>Answer`)).toEqual({
      visibleContent: 'Answer',
      reasoning: thought,
      hasUnclosedTag: false,
    })
  })
})
