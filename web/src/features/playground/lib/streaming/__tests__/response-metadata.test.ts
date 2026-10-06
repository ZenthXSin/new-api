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

import type { ChatCompletionResponse } from '../../../types'
import { applyChatCompletionResponse } from '../../message/message-streaming-utils'
import { createLoadingAssistantMessage } from '../../message/message-utils'
import { parseRequestErrorDetails } from '../request-error-utils'
import {
  normalizeSources,
  readResponseMetadata,
  readUsage,
  mergeResponseMetadata,
} from '../response-metadata'
import { parseStreamMessage } from '../stream-utils'

describe('response metadata', () => {
  test('deduplicates only structured citations and filters unsafe URLs', () => {
    const result = readResponseMetadata({
      choices: [
        {
          delta: {
            content: 'https://not-a-citation.test',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://example.test/article',
                  title: 'Reference',
                },
              },
              {
                type: 'url_citation',
                url_citation: { url: 'javascript:alert(1)', title: 'Unsafe' },
              },
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://user:password@example.test/secret',
                },
              },
            ],
          },
        },
      ],
      citations: ['https://example.test/article', 'https://second.test'],
    })
    expect(result.sources?.map((source) => source.href)).toEqual([
      'https://example.test/article',
      'https://second.test/',
    ])
    expect(
      normalizeSources([
        { href: 'data:text/html,hello' },
        { href: '/relative' },
        { href: 'https://valid.test', title: '<script>plain text</script>' },
      ])
    ).toEqual([
      { href: 'https://valid.test/', title: '<script>plain text</script>' },
    ])
  })

  test('preserves zero cache counts and ignores malformed/absent usage', () => {
    expect(readUsage(undefined)).toBeUndefined()
    expect(
      readUsage({ prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 })
    ).toBeUndefined()
    const usage = readUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 1 },
    })
    expect(usage?.prompt_tokens_details?.cached_tokens).toBe(0)
    expect(usage?.completion_tokens_details?.reasoning_tokens).toBe(1)
  })

  test('merges usage snapshots without adding them or erasing detail fields', () => {
    const result = mergeResponseMetadata(
      {
        usage: {
          prompt_tokens: 5,
          completion_tokens: 0,
          total_tokens: 5,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      { usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }
    )
    expect(result.usage).toMatchObject({
      total_tokens: 9,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })

  test('captures usage-only stream frames and sources after finish', () => {
    const result = parseStreamMessage(
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        citations: ['https://source.test'],
      })
    )
    expect(result.updates).toEqual([])
    expect(result.metadata.usage?.total_tokens).toBe(8)
    expect(result.metadata.sources).toHaveLength(1)
  })

  test('applies non-stream content, reasoning, sources, model and usage without fabricating TTFT', () => {
    const response = {
      model: 'test-model',
      choices: [
        {
          message: {
            content: 'answer',
            reasoning_content: 'reason',
            annotations: [
              {
                type: 'url_citation',
                url_citation: { url: 'https://source.test', title: 'Source' },
              },
            ],
          },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    } as ChatCompletionResponse
    const message = applyChatCompletionResponse(
      createLoadingAssistantMessage(),
      response
    )
    expect(message).toMatchObject({
      status: 'complete',
      model: 'test-model',
      finishReason: 'length',
      usage: { total_tokens: 8 },
      reasoning: { content: 'reason' },
    })
    expect(message?.versions[0].content).toBe('answer')
    expect(message?.sources).toEqual([
      { href: 'https://source.test/', title: 'Source' },
    ])
    expect(message?.firstTokenMs).toBeUndefined()
  })

  test('extracts OpenAI error messages without returning non-string payloads', () => {
    expect(
      parseRequestErrorDetails({
        message: 'HTTP 400',
        response: {
          data: { error: { message: 'Bad model', code: 'invalid_model' } },
        },
      })
    ).toEqual({ errorMessage: 'Bad model', errorCode: 'invalid_model' })
    expect(
      parseRequestErrorDetails({
        response: { data: { error: { message: { bad: 'value' } } } },
      }).errorMessage
    ).toBe('Request error occurred')
  })
})
