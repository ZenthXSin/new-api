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
import { ERROR_MESSAGES } from '../../constants'
import {
  asRecord,
  readResponseMetadata,
  readResponseText,
  type ResponseMetadata,
} from './response-metadata'

const STREAM_DONE_MESSAGE = '[DONE]'
const STREAM_CLOSED_READY_STATE = 2

export type StreamUpdateType = 'reasoning' | 'content'

export type StreamMessageUpdate = {
  type: StreamUpdateType
  chunk: string
}

export type StreamErrorDetails = {
  errorCode?: string
  errorMessage: string
}

export function parseStreamErrorDetails(data?: string): StreamErrorDetails {
  const fallbackMessage = ERROR_MESSAGES.API_REQUEST_ERROR

  if (!data) {
    return { errorMessage: fallbackMessage }
  }

  try {
    const parsed = asRecord(JSON.parse(data))
    const error = asRecord(parsed?.error)
    if (!error) {
      return {
        errorMessage:
          typeof parsed?.message === 'string' && parsed.message
            ? parsed.message
            : fallbackMessage,
      }
    }

    return {
      errorCode: typeof error.code === 'string' ? error.code : undefined,
      errorMessage:
        typeof error.message === 'string' && error.message
          ? error.message
          : fallbackMessage,
    }
  } catch {
    return { errorMessage: fallbackMessage }
  }
}

export function parseStreamMessageUpdates(data: string): StreamMessageUpdate[] {
  return parseStreamMessage(data).updates
}

export function parseStreamMessage(data: string): {
  updates: StreamMessageUpdate[]
  metadata: ResponseMetadata
  error?: StreamErrorDetails
} {
  const chunk = asRecord(JSON.parse(data))
  if (!chunk) throw new Error(ERROR_MESSAGES.PARSE_ERROR)
  if (chunk.error) {
    return { updates: [], metadata: {}, error: parseStreamErrorDetails(data) }
  }
  const choice = asRecord(
    Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
  )
  const delta = asRecord(choice?.delta)
  const updates: StreamMessageUpdate[] = []
  const reasoning = readResponseText(delta?.reasoning_content)
  const content =
    readResponseText(delta?.content) || readResponseText(delta?.refusal)
  if (reasoning) updates.push({ type: 'reasoning', chunk: reasoning })
  if (content) updates.push({ type: 'content', chunk: content })
  return { updates, metadata: readResponseMetadata(chunk) }
}

export function isStreamDoneMessage(data: string): boolean {
  return data.trim() === STREAM_DONE_MESSAGE
}

export function isStreamClosedReadyState(readyState?: number): boolean {
  return readyState === STREAM_CLOSED_READY_STATE
}

export function getStreamReadyStateError(
  eventReadyState: number | undefined,
  source: unknown
): string | null {
  const status = (source as { status?: number }).status

  if (
    eventReadyState !== undefined &&
    eventReadyState >= STREAM_CLOSED_READY_STATE &&
    status !== undefined &&
    status !== 200
  ) {
    return `HTTP ${status}: ${ERROR_MESSAGES.CONNECTION_CLOSED}`
  }

  return null
}
