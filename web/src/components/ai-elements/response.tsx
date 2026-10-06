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
'use client'

import { memo, useId, useLayoutEffect, useMemo, useRef } from 'react'
import { parseMarkdownToStructure } from 'stream-markdown-parser'

import { cn } from '@/lib/utils'

import { getMarkdownContent, parseResponseContent } from './response-content'
import { ResponseErrorBoundary } from './response-error-boundary'
import {
  beginRun,
  commitRun,
  createFadeState,
  FADE_HYDRATION_THRESHOLD,
  stageRun,
  type FadeRun,
  type FadeState,
} from './response-fade'
import { createResponseParser } from './response-parser'
import { renderChildren, renderFootnotes } from './response-renderer'
import type { ResponseProps } from './response-types'

// Long answers keep their Markdown; only optional per-word animation is skipped.
const MAX_ANIMATED_MARKDOWN_CHARS = 20_000

const ParsedResponse = memo(
  (props: { content: string; final: boolean; parserId?: string }) => {
    const { final: isFinal } = props
    const content = useMemo(
      () => getMarkdownContent(props.content),
      [props.content]
    )
    const shouldAnimate =
      !isFinal && content.length <= MAX_ANIMATED_MARKDOWN_CHARS
    const instanceId = useId()
    const markdown = useMemo(
      () =>
        createResponseParser(
          `${props.parserId ?? 'new-api-response'}-${instanceId}`
        ),
      [props.parserId, instanceId]
    )
    const fadeStateRef = useRef<FadeState | null>(null)
    if (fadeStateRef.current == null) {
      fadeStateRef.current = createFadeState()
    }

    const nodes = useMemo(() => {
      return parseMarkdownToStructure(content, markdown, {
        final: isFinal,
        validateLink: markdown.options.validateLink,
      })
    }, [content, isFinal, markdown])
    const parsedContent = useMemo(() => parseResponseContent(nodes), [nodes])

    let fadeRun: FadeRun | undefined
    let renderedContent
    let footnotes

    if (parsedContent.bodyNodes.length > 0) {
      if (shouldAnimate) {
        const fadeState = fadeStateRef.current
        const suppress =
          fadeState.firstRun && content.length > FADE_HYDRATION_THRESHOLD
        fadeRun = beginRun(fadeState, suppress)
        renderedContent = renderChildren(parsedContent.bodyNodes, fadeRun)
        footnotes = renderFootnotes(parsedContent.footnotes, fadeRun)
        stageRun(fadeRun)
      } else {
        renderedContent = renderChildren(parsedContent.bodyNodes)
        footnotes = renderFootnotes(parsedContent.footnotes)
      }
    } else {
      renderedContent = (
        <span className='break-words whitespace-pre-wrap'>{content}</span>
      )
      footnotes = renderFootnotes(parsedContent.footnotes)
    }

    useLayoutEffect(() => {
      if (!shouldAnimate) {
        return
      }
      const fadeState = fadeStateRef.current
      if (fadeState == null) {
        return
      }
      commitRun(fadeState)
    })

    return (
      <>
        {renderedContent}
        {footnotes}
      </>
    )
  }
)

ParsedResponse.displayName = 'ParsedResponse'

export const Response = memo((props: ResponseProps) => {
  const content = Array.isArray(props.children)
    ? props.children.join('')
    : String(props.children ?? '')
  const isFinal = props.final ?? true

  return (
    <div
      className={cn(
        'size-full min-w-0 text-pretty [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        props.className
      )}
    >
      <ResponseErrorBoundary content={content} final={isFinal}>
        <ParsedResponse
          content={content}
          final={isFinal}
          parserId={props.parserId}
        />
      </ResponseErrorBoundary>
    </div>
  )
})

Response.displayName = 'Response'
