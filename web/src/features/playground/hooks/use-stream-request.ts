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
import { useCallback, useEffect, useRef, useState } from 'react'
import { SSE } from 'sse.js'

import { getFreshAuthHeaders } from '@/lib/api'

import { API_ENDPOINTS, ERROR_MESSAGES } from '../constants'
import {
  isStreamClosedReadyState,
  isStreamDoneMessage,
  parseStreamErrorDetails,
} from '../lib'
import type { ResponseMetadata } from '../lib/streaming/response-metadata'
import { parseStreamMessage } from '../lib/streaming/stream-utils'
import type { ChatCompletionRequest } from '../types'

interface StreamEventSource {
  readyState?: number
  addEventListener: (
    type: string,
    listener: (
      event: Event & {
        data?: string
        readyState?: number
        responseCode?: number
      }
    ) => void
  ) => void
  close: () => void
  stream: () => void
}

interface StreamRequestCallbacks {
  onUpdate: (type: 'reasoning' | 'content', chunk: string) => void
  onComplete: () => void
  onError: (error: string, errorCode?: string) => void
  onMetadata?: (metadata: ResponseMetadata) => void
}

interface StreamRequestControllerRuntime {
  getHeaders: () => Promise<Record<string, string>>
  createSource: (
    payload: ChatCompletionRequest,
    headers: Record<string, string>
  ) => StreamEventSource
  setStreaming: (streaming: boolean) => void
}

export function createStreamRequestController(
  runtime: StreamRequestControllerRuntime
) {
  let source: StreamEventSource | null = null
  let generation = 0

  const closeActiveSource = (target: StreamEventSource) => {
    target.close()
    if (source === target) {
      source = null
      runtime.setStreaming(false)
    }
  }

  const send = async (
    payload: ChatCompletionRequest,
    callbacks: StreamRequestCallbacks
  ) => {
    const requestGeneration = generation + 1
    generation = requestGeneration
    const previousSource = source
    source = null
    previousSource?.close()
    runtime.setStreaming(false)

    let headers: Record<string, string>
    try {
      headers = await runtime.getHeaders()
    } catch (error: unknown) {
      if (generation !== requestGeneration) return
      callbacks.onError(
        error instanceof Error
          ? error.message
          : ERROR_MESSAGES.STREAM_START_ERROR
      )
      return
    }
    if (generation !== requestGeneration) return

    let nextSource: StreamEventSource
    try {
      nextSource = runtime.createSource(payload, headers)
    } catch {
      callbacks.onError(ERROR_MESSAGES.STREAM_START_ERROR)
      return
    }
    source = nextSource
    runtime.setStreaming(true)
    let completed = false
    let hasFinishReason = false
    let firstTokenReceived = false
    let responseCode: number | undefined

    const isCurrent = () =>
      generation === requestGeneration && source === nextSource

    const handleError = (errorMessage: string, errorCode?: string) => {
      if (!isCurrent() || completed) return
      completed = true
      callbacks.onError(errorMessage, errorCode)
      closeActiveSource(nextSource)
    }

    const handleComplete = () => {
      if (!isCurrent() || completed) return
      completed = true
      closeActiveSource(nextSource)
      callbacks.onComplete()
    }

    nextSource.addEventListener('open', (event) => {
      if (isCurrent()) responseCode = event.responseCode
    })

    nextSource.addEventListener('message', (event) => {
      if (!isCurrent() || completed) return
      const data = event.data ?? ''
      if (isStreamDoneMessage(data)) {
        handleComplete()
        return
      }
      if (!data.trim()) return

      try {
        const { updates, metadata, error } = parseStreamMessage(data)
        if (error) {
          handleError(error.errorMessage, error.errorCode)
          return
        }
        hasFinishReason ||= Boolean(metadata.finishReason)
        if (updates.length && !firstTokenReceived) {
          metadata.firstTokenAt = Date.now()
          firstTokenReceived = true
        }
        if (Object.keys(metadata).length) callbacks.onMetadata?.(metadata)

        for (const update of updates) {
          callbacks.onUpdate(update.type, update.chunk)
        }
      } catch {
        handleError(ERROR_MESSAGES.PARSE_ERROR)
      }
    })

    nextSource.addEventListener('error', (event) => {
      if (!isCurrent() || completed) return
      const { errorCode, errorMessage } = parseStreamErrorDetails(event.data)
      handleError(errorMessage, errorCode)
    })

    nextSource.addEventListener('readystatechange', (event) => {
      if (!isCurrent() || completed) return
      if (!isStreamClosedReadyState(event.readyState)) return
      if (
        responseCode !== undefined &&
        (responseCode < 200 || responseCode >= 300)
      ) {
        handleError(`HTTP ${responseCode}: ${ERROR_MESSAGES.CONNECTION_CLOSED}`)
        return
      }
      if (hasFinishReason) handleComplete()
      else handleError(ERROR_MESSAGES.CONNECTION_CLOSED)
    })

    try {
      if (!isCurrent()) return
      nextSource.stream()
    } catch {
      if (!isCurrent() || completed) return
      handleError(ERROR_MESSAGES.STREAM_START_ERROR)
    }
  }

  const cancel = (notify: boolean) => {
    generation += 1
    const activeSource = source
    source = null
    activeSource?.close()
    if (notify) runtime.setStreaming(false)
  }

  const stop = () => cancel(true)
  const dispose = () => cancel(false)

  return { send, stop, dispose }
}

/**
 * Hook for handling streaming chat completion requests
 */
export function useStreamRequest() {
  const [isStreaming, setIsStreaming] = useState(false)
  const controllerRef = useRef<ReturnType<
    typeof createStreamRequestController
  > | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = createStreamRequestController({
      getHeaders: getFreshAuthHeaders,
      createSource: (payload, headers) =>
        new SSE(API_ENDPOINTS.CHAT_COMPLETIONS, {
          headers,
          method: 'POST',
          payload: JSON.stringify(payload),
          start: false,
        }) as StreamEventSource,
      setStreaming: setIsStreaming,
    })
  }

  const sendStreamRequest = useCallback(
    (
      payload: ChatCompletionRequest,
      onUpdate: (type: 'reasoning' | 'content', chunk: string) => void,
      onComplete: () => void,
      onError: (error: string, errorCode?: string) => void,
      onMetadata?: (metadata: ResponseMetadata) => void
    ) =>
      controllerRef.current?.send(payload, {
        onUpdate,
        onComplete,
        onError,
        onMetadata,
      }),
    []
  )

  const stopStream = useCallback(() => {
    controllerRef.current?.stop()
  }, [])

  useEffect(
    () => () => {
      controllerRef.current?.dispose()
    },
    []
  )

  return {
    sendStreamRequest,
    stopStream,
    isStreaming,
  }
}
