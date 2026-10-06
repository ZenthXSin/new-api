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
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { createUserMessage } from '../../message/message-utils'
import { buildChatCompletionPayload } from '../payload-builder'

describe('playground request configuration', () => {
  it('sends enabled zero values and omits disabled parameters', () => {
    const payload = buildChatCompletionPayload(
      [createUserMessage('Hello')],
      {
        ...DEFAULT_CONFIG,
        temperature: 0,
        top_p: 0,
        seed: 0,
      },
      { ...DEFAULT_PARAMETER_ENABLED, seed: true, frequency_penalty: false }
    )
    expect(payload).toMatchObject({ temperature: 0, top_p: 0, seed: 0 })
    expect(payload).not.toHaveProperty('frequency_penalty')
  })

  it('applies system instructions, JSON format and stop sequences', () => {
    const payload = buildChatCompletionPayload(
      [createUserMessage('Hello')],
      {
        ...DEFAULT_CONFIG,
        system_prompt: 'Be concise.',
        response_format: 'json_object',
        reasoning_effort: 'high',
        stop: ['END'],
      },
      DEFAULT_PARAMETER_ENABLED
    )
    expect(payload.messages[0]).toMatchObject({ role: 'system' })
    expect(payload.messages[0].content).toContain('Be concise.')
    expect(payload.messages[0].content).toContain('JSON')
    expect(payload.response_format).toEqual({ type: 'json_object' })
    expect(payload.reasoning_effort).toBe('high')
    expect(payload.stop).toEqual(['END'])
  })

  it('requests actual search and streamed usage only when selected', () => {
    const payload = buildChatCompletionPayload(
      [createUserMessage('News?')],
      {
        ...DEFAULT_CONFIG,
        web_search: true,
        search_context_size: 'high',
      },
      DEFAULT_PARAMETER_ENABLED
    )
    expect(payload.web_search_options).toEqual({ search_context_size: 'high' })
    expect(payload.stream_options).toEqual({ include_usage: true })
    const plain = buildChatCompletionPayload(
      [],
      { ...DEFAULT_CONFIG, stream: false },
      DEFAULT_PARAMETER_ENABLED
    )
    expect(plain).not.toHaveProperty('web_search_options')
    expect(plain).not.toHaveProperty('stream_options')
    expect(plain).not.toHaveProperty('reasoning_effort')
  })
})
