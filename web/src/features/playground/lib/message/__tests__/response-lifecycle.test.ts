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

import { applyStreamingChunk } from '../message-streaming-utils'
import { updateAssistantMessageWithError } from '../message-update-utils'
import { createLoadingAssistantMessage } from '../message-utils'

describe('response lifecycle', () => {
  test('keeps repeated content and reasoning deltas verbatim', () => {
    let message = createLoadingAssistantMessage()
    for (const token of ['a', 'a', 'ab']) {
      message = applyStreamingChunk(message, 'content', token)
    }
    expect(message.versions[0].content).toBe('aaab')
    for (const token of ['why', 'why']) {
      message = applyStreamingChunk(message, 'reasoning', token)
    }
    expect(message.reasoning?.content).toBe('whywhy')
  })

  test('keeps partial response and reasoning when the connection fails', () => {
    let message = applyStreamingChunk(
      createLoadingAssistantMessage(),
      'reasoning',
      'analysis'
    )
    message = applyStreamingChunk(message, 'content', 'A partial answer')
    const [failed] = updateAssistantMessageWithError(
      [message],
      'Disconnected',
      'network'
    )
    expect(failed.versions[0].content).toBe('A partial answer')
    expect(failed.reasoning?.content).toBe('analysis')
    expect(failed.status).toBe('error')
    expect(failed.errorMessage).toContain('Disconnected')
  })
})
