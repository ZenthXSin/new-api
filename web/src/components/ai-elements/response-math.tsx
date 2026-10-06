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
import DOMPurify from 'dompurify'
import * as katex from 'katex'
import { useMemo } from 'react'
import type { MathBlockNode, MathInlineNode } from 'stream-markdown-parser'

import 'katex/dist/katex.min.css'

interface ResponseMathProps {
  node: MathBlockNode | MathInlineNode
  displayMode: boolean
}

const EXPLICIT_MATH_MARKUP = new Set([
  '$',
  '$$',
  String.raw`\(\)`,
  String.raw`\[\]`,
])
const MAX_MATH_SOURCE_CHARS = 20_000

export function ResponseMath(props: ResponseMathProps) {
  const { content, raw, markup, loading } = props.node
  const displayMode = props.displayMode
  const html = useMemo(() => {
    // The parser also guesses math from ordinary brackets and currency. Render
    // only explicit delimiters and leave ambiguous dollar prose unchanged.
    if (
      loading ||
      !markup ||
      !EXPLICIT_MATH_MARKUP.has(markup) ||
      content.length > MAX_MATH_SOURCE_CHARS ||
      (markup === '$' &&
        (!content.trim() ||
          content.trim() !== content ||
          /^\d[\d.,]*[,–—]$/.test(content)))
    ) {
      return null
    }
    try {
      const rendered = katex.renderToString(content, {
        displayMode,
        output: 'htmlAndMathml',
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        maxExpand: 1000,
        maxSize: 20,
        // KaTeX can mutate this object with \gdef; never share between nodes.
        macros: {},
      })
      return DOMPurify.sanitize(rendered, {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        ADD_TAGS: ['semantics', 'annotation'],
        ADD_ATTR: ['encoding'],
      })
    } catch {
      // Invalid/incomplete TeX must never hide the surrounding response.
      return null
    }
  }, [content, markup, loading, displayMode])

  let fallback = raw || content
  if (loading && markup && EXPLICIT_MATH_MARKUP.has(markup)) {
    let opener = markup
    if (markup === String.raw`\(\)`) opener = String.raw`\(`
    if (markup === String.raw`\[\]`) opener = String.raw`\[`
    // Streaming parser versions may synthesize a closing delimiter in raw.
    fallback = `${opener}${content}`
  }

  if (displayMode) {
    if (html === null) {
      return (
        <pre className='my-4 max-w-full overflow-x-auto font-mono text-sm break-words whitespace-pre-wrap'>
          {fallback}
        </pre>
      )
    }
    return (
      <div
        className='my-4 max-w-full min-w-0 overflow-x-auto overflow-y-hidden py-1 [&_.katex-display]:my-0'
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  if (html === null) {
    return <span className='break-words whitespace-pre-wrap'>{fallback}</span>
  }
  return (
    <span
      className='inline-block max-w-full overflow-x-auto overflow-y-hidden align-middle'
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
