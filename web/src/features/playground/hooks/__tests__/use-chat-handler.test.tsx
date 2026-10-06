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
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import {
  createLoadingAssistantMessage,
  createUserMessage,
} from '../../lib/message/message-utils'
import type { Message } from '../../types'
import { useChatHandler } from '../use-chat-handler'

// Exercise the real SSE parser; replace only its browser transport boundary.
class LocalXMLHttpRequest extends EventTarget {
  static HEADERS_RECEIVED = 2
  static instances: LocalXMLHttpRequest[] = []
  readyState = 0
  status = 200
  responseText = ''
  withCredentials = false
  aborted = false
  get response() {
    return this.responseText
  }
  constructor() {
    super()
    LocalXMLHttpRequest.instances.push(this)
  }
  open() {}
  setRequestHeader() {}
  getAllResponseHeaders() {
    return 'content-type: text/event-stream'
  }
  send() {
    this.readyState = 2
    this.dispatchEvent(new Event('readystatechange'))
  }
  abort() {
    this.aborted = true
    this.dispatchEvent(new Event('abort'))
  }
  frame(data: unknown) {
    this.responseText += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
    this.dispatchEvent(new Event('progress'))
  }
}

function harness(stream = true) {
  return renderHook(() => {
    const [messages, setMessages] = useState<Message[]>([
      createUserMessage('hello', 1000),
      createLoadingAssistantMessage(1000),
    ])
    const handler = useChatHandler({
      config: { ...DEFAULT_CONFIG, stream },
      parameterEnabled: DEFAULT_PARAMETER_ENABLED,
      onMessageUpdate: setMessages,
    })
    return { ...handler, messages }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1200)
  LocalXMLHttpRequest.instances = []
  vi.stubGlobal('XMLHttpRequest', LocalXMLHttpRequest)
  useAuthStore.setState((state) => ({
    auth: {
      ...state.auth,
      accessToken: 'test-only',
      accessExpiresAt: 9999999999,
    },
  }))
})

afterEach(() => {
  useAuthStore.getState().auth.reset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('chat response integration', () => {
  test('renders the first token immediately and keeps batched tail content when stopped', async () => {
    const { result } = harness()
    await act(async () => result.current.sendChat(result.current.messages))
    const transport = LocalXMLHttpRequest.instances[0]
    expect(LocalXMLHttpRequest.instances).toHaveLength(1)
    act(() => transport.frame({ choices: [{ delta: { content: 'a' } }] }))
    expect(result.current.messages.at(-1)?.versions[0].content).toBe('a')
    expect(result.current.messages.at(-1)?.firstTokenMs).toBe(200)
    act(() => {
      transport.frame({ choices: [{ delta: { content: 'a' } }] })
      transport.frame({ choices: [{ delta: { content: 'ab' } }] })
      result.current.stopGeneration()
    })
    const message = result.current.messages.at(-1)
    expect(message?.versions[0].content).toBe('aaab')
    expect(message?.status).toBe('complete')
    expect(result.current.isGenerating).toBe(false)
    expect(transport.aborted).toBe(true)
  })

  test('retains final usage and citations with no extra text frame', async () => {
    const { result } = harness()
    await act(async () => result.current.sendChat(result.current.messages))
    const transport = LocalXMLHttpRequest.instances[0]
    act(() => {
      transport.frame({
        model: 'test-model',
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
      })
      transport.frame({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        citations: ['https://source.test'],
      })
      transport.frame('[DONE]')
    })
    expect(result.current.messages.at(-1)).toMatchObject({
      status: 'complete',
      usage: { total_tokens: 12, prompt_tokens_details: { cached_tokens: 0 } },
      sources: [{ href: 'https://source.test/' }],
      finishReason: 'stop',
    })
    expect(result.current.isGenerating).toBe(false)
  })

  test('keeps both rendered and buffered content when a streaming error arrives', async () => {
    const { result } = harness()
    await act(async () => result.current.sendChat(result.current.messages))
    const transport = LocalXMLHttpRequest.instances[0]
    act(() => {
      transport.frame({ choices: [{ delta: { content: 'answer' } }] })
      transport.frame({ choices: [{ delta: { content: ' tail' } }] })
      transport.frame({
        error: { message: 'Upstream unavailable', code: 'upstream' },
      })
    })
    expect(result.current.messages.at(-1)).toMatchObject({
      status: 'error',
      errorCode: 'upstream',
      errorMessage: 'Request error occurred: Upstream unavailable',
    })
    expect(result.current.messages.at(-1)?.versions[0].content).toBe(
      'answer tail'
    )
    expect(result.current.isGenerating).toBe(false)
  })

  test('handles non-stream metadata and HTTP-200 error envelopes', async () => {
    const previousAdapter = api.defaults.adapter
    try {
      api.defaults.adapter = async (config) => ({
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          model: 'test-model',
          choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      })
      const first = harness(false)
      await act(async () => {
        first.result.current.sendChat(first.result.current.messages)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(first.result.current.messages.at(-1)).toMatchObject({
        status: 'complete',
        usage: { total_tokens: 12 },
      })
      expect(first.result.current.messages.at(-1)?.firstTokenMs).toBeUndefined()
      first.unmount()
      api.defaults.adapter = async (config) => ({
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { error: { message: 'Unknown model' } },
      })
      const second = harness(false)
      await act(async () => {
        second.result.current.sendChat(second.result.current.messages)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(second.result.current.messages.at(-1)).toMatchObject({
        status: 'error',
        errorMessage: 'Request error occurred: Unknown model',
      })
    } finally {
      api.defaults.adapter = previousAdapter
    }
  })
})
