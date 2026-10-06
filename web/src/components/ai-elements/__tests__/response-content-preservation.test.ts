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

import { getMarkdownContent, stripCustomTags } from '../response-content'

describe('response Markdown source preservation', () => {
  test('keeps numbered headings inside a fenced Markdown example', () => {
    const source = [
      'Example:',
      '',
      '```md',
      '## 1. Install',
      '',
      'Run **setup**.',
      '## 2. Configure',
      '```',
      '',
      'Continue here.',
    ].join('\n')
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('keeps four-backtick examples containing shorter language fences unchanged', () => {
    const source = [
      '````markdown',
      '# Example',
      '```typescript',
      'const message = "hello"',
      '```',
      '## 2. Next',
      '````',
    ].join('\n')
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('does not close an outer Markdown fence on a different marker', () => {
    const source = ['```md', '~~~', 'inside the example', '~~~', '```'].join(
      '\n'
    )
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('preserves unfinished streamed code without adding a closing fence', () => {
    const source = '```md\n## 1. In progress\n**example'
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('preserves custom tags inside fenced, inline, and indented code', () => {
    const source = [
      '```xml',
      '<message><think>literal</think></message>',
      '```',
      '',
      'Use `<message>text</message>` or ``<think>`code`</think>``.',
      '',
      '    <sources>literal</sources>',
    ].join('\n')
    expect(stripCustomTags(source)).toBe(source)
  })
  test('strips presentation wrappers outside code and preserves their code example', () => {
    const source = '<message>Explanation: `<message>hello</message>`</message>'
    expect(getMarkdownContent(source)).toBe(
      'Explanation: `<message>hello</message>`'
    )
  })
  test('preserves blockquote and list code with CRLF source offsets', () => {
    const source = [
      '> ```xml',
      '> <message>quote</message>',
      '> ```',
      '',
      '- Example:',
      '',
      '  ```xml',
      '  <think>list</think>',
      '  ```',
      '',
      '<message>Answer</message>',
    ].join('\r\n')
    expect(getMarkdownContent(source)).toBe(
      source.replace('<message>Answer</message>', 'Answer')
    )
  })
  test('preserves escaped custom tags that are visible Markdown text', () => {
    const source = String.raw`Write \<think> and \</think> literally.`
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('keeps CRLF indented code and strips only the following real wrapper', () => {
    const source =
      '    <message>example</message>\r\n\r\n<message>Answer</message>'
    expect(getMarkdownContent(source)).toBe(
      '    <message>example</message>\r\n\r\nAnswer'
    )
  })
  test('leaves code in table cells and multi-line inline code spans unchanged', () => {
    const source =
      '| Example |\n| --- |\n| `<message>hello</message>` |\n\nA ``code\n<think>literal</think>`` example.'
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('keeps code following an escaped backtick delimiter unchanged', () => {
    const source = 'Write \\` normally; then use `<think>literal</think>`. '
    expect(getMarkdownContent(source)).toBe(source)
  })
  test('does not consume code following an unfinished presentation wrapper', () => {
    const source =
      '<message attribute="unfinished\n\n```xml\n<item>Keep this example</item>\n```'
    expect(getMarkdownContent(source)).toBe(source)
  })
})
