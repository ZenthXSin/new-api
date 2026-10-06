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
import { nanoid } from 'nanoid'

import { MESSAGE_ROLES, MESSAGE_STATUS } from '../../constants'
import type {
  Message,
  MessageVersion,
  ChatCompletionMessage,
  ContentPart,
  PlaygroundAttachment,
} from '../../types'

/**
 * Create a new message version
 */
export function createMessageVersion(
  content: string,
  attachments?: PlaygroundAttachment[]
): MessageVersion {
  return {
    id: nanoid(),
    content,
    ...(attachments?.length
      ? { attachments: attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  }
}

/**
 * Get current version from message (always returns the first version)
 */
export function getCurrentVersion(message: Message): MessageVersion {
  return message.versions[0] || { id: 'default', content: '' }
}

/**
 * Get displayable content from the current message version.
 */
export function getMessageContent(message: Message): string {
  return getCurrentVersion(message).content
}

/**
 * Check whether a message has non-empty content in its current version.
 */
export function hasMessageContent(message: Message): boolean {
  return (
    getMessageContent(message).trim() !== '' ||
    Boolean(getCurrentVersion(message).attachments?.length)
  )
}

/**
 * Update current version content in message
 */
export function updateCurrentVersionContent(
  message: Message,
  content: string,
  attachments?: PlaygroundAttachment[]
): Message {
  const currentVersion = getCurrentVersion(message)
  return {
    ...message,
    versions: [
      {
        ...currentVersion,
        content,
        ...(attachments !== undefined
          ? {
              attachments: attachments.map((attachment) => ({ ...attachment })),
            }
          : {}),
      },
      ...message.versions.slice(1),
    ],
  }
}

/**
 * Create a user message
 */
export function createUserMessage(
  content: string,
  createdAt: number = Date.now(),
  attachments?: PlaygroundAttachment[]
): Message {
  return {
    key: nanoid(),
    from: MESSAGE_ROLES.USER,
    versions: [createMessageVersion(content, attachments)],
    createdAt,
  }
}

/**
 * Create a loading assistant message
 */
export function createLoadingAssistantMessage(
  startedAt: number = Date.now()
): Message {
  return {
    key: nanoid(),
    from: MESSAGE_ROLES.ASSISTANT,
    versions: [createMessageVersion('')],
    createdAt: startedAt,
    startedAt,
    reasoning: undefined,
    isReasoningComplete: false,
    isContentComplete: false,
    isReasoningStreaming: false,
    status: MESSAGE_STATUS.LOADING,
  }
}

/**
 * Build message content with optional images
 */
export function buildMessageContent(
  text: string,
  imageUrls: string[] = []
): string | ContentPart[] {
  const validImages = imageUrls.filter((url) => url.trim() !== '')

  if (validImages.length === 0) {
    return text
  }

  const parts: ContentPart[] = [
    {
      type: 'text',
      text: text || '',
    },
    ...validImages.map((url) => ({
      type: 'image_url' as const,
      image_url: { url: url.trim() },
    })),
  ]

  return parts
}

/**
 * Extract text content from message content
 */
export function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textPart = content.find((part) => part.type === 'text')
    return textPart?.text || ''
  }

  return ''
}

/**
 * Format message for API request
 */
export function formatMessageForAPI(message: Message): ChatCompletionMessage {
  const currentVersion = getCurrentVersion(message)
  const attachments = currentVersion.attachments ?? []
  if (attachments.length === 0) {
    return { role: message.from, content: currentVersion.content }
  }
  const parts: ContentPart[] = []
  if (currentVersion.content) {
    parts.push({ type: 'text', text: currentVersion.content })
  }
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      if (attachment.text === undefined) {
        throw new Error('Attachment content is unavailable')
      }
      parts.push({
        type: 'text',
        text: `--- ${attachment.name} ---\n${attachment.text}`,
      })
    } else if (attachment.kind === 'image') {
      if (!attachment.dataUrl) {
        throw new Error('Attachment content is unavailable')
      }
      parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } })
    } else {
      if (!attachment.dataUrl) {
        throw new Error('Attachment content is unavailable')
      }
      parts.push({
        type: 'file',
        file: { filename: attachment.name, file_data: attachment.dataUrl },
      })
    }
  }
  return { role: message.from, content: parts }
}

/**
 * Check if message is valid for API request
 * Excludes loading/streaming assistant messages and empty content
 */
export function isValidMessage(message: Message): boolean {
  if (!message || !message.from || !message.versions.length) return false

  // Exclude empty assistant messages (loading/streaming placeholders)
  if (message.from === MESSAGE_ROLES.ASSISTANT && !hasMessageContent(message)) {
    return false
  }

  return true
}
