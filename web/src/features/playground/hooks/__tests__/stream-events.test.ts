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

import { createStreamRequestController } from '../use-stream-request'

class StreamSource {
  readyState = 0
  listeners = new Map<
    string,
    Array<(event: Event & { data?: string; readyState?: number }) => void>
  >()
  addEventListener(
    type: string,
    listener: (event: Event & { data?: string; readyState?: number }) => void
  ) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  stream() {}
  close() {}
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({
        data: typeof data === 'string' ? data : JSON.stringify(data),
        readyState: this.readyState,
      } as Event & { data?: string; readyState?: number })
    }
  }
}

const payload = { model: 'test', stream: true, messages: [] }
const callbacks = () => ({
  onUpdate: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
})

describe('stream terminal events', () => {
  test('reports API errors sent inside successful SSE responses', async () => {
    const source = new StreamSource()
    const cb = callbacks()
    const controller = createStreamRequestController({
      getHeaders: async () => ({}),
      createSource: () => source,
      setStreaming: vi.fn(),
    })
    await controller.send(payload, cb)
    source.emit('message', {
      error: { message: 'Quota exceeded', code: 'quota' },
    })
    expect(cb.onError).toHaveBeenCalledWith('Quota exceeded', 'quota')
  })

  test('reports truncated EOF instead of leaving the request pending', async () => {
    const source = new StreamSource()
    const cb = callbacks()
    const controller = createStreamRequestController({
      getHeaders: async () => ({}),
      createSource: () => source,
      setStreaming: vi.fn(),
    })
    await controller.send(payload, cb)
    source.emit('message', { choices: [{ delta: { content: 'partial' } }] })
    source.readyState = 2
    source.emit('readystatechange')
    expect(cb.onError).toHaveBeenCalledWith('Connection closed', undefined)
  })

  test('finishes on clean EOF after finish_reason even without DONE', async () => {
    const source = new StreamSource()
    const cb = callbacks()
    const controller = createStreamRequestController({
      getHeaders: async () => ({}),
      createSource: () => source,
      setStreaming: vi.fn(),
    })
    await controller.send(payload, cb)
    source.emit('message', { choices: [{ delta: {}, finish_reason: 'stop' }] })
    source.readyState = 2
    source.emit('readystatechange')
    expect(cb.onComplete).toHaveBeenCalledOnce()
    expect(cb.onError).not.toHaveBeenCalled()
  })

  test('turns source construction errors into a terminal failure', async () => {
    const cb = callbacks()
    const controller = createStreamRequestController({
      getHeaders: async () => ({}),
      createSource: () => {
        throw new Error('unavailable')
      },
      setStreaming: vi.fn(),
    })
    await expect(controller.send(payload, cb)).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledOnce()
  })
})
