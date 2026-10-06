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
import { z } from 'zod'

import type { Message, ParameterEnabled, PlaygroundConfig } from '../../types'
import {
  currentPlaygroundUserID,
  PlaygroundStorageError,
  restoreConversationMessages,
  validateConversationMessages,
} from './storage'
import {
  MAX_STORED_MESSAGES_BYTES,
  messagesSchema,
  playgroundConfigSchema,
  parameterEnabledSchema,
} from './storage-schema'

// The envelope adds metadata beyond the 20 MiB exact message budget.
export const MAX_CONVERSATION_FILE_BYTES =
  MAX_STORED_MESSAGES_BYTES + 128 * 1024
const transferSchema = z
  .object({
    format: z.literal('new-api-playground'),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    messages: z.unknown(),
    config: playgroundConfigSchema.optional(),
    parameterEnabled: parameterEnabledSchema.optional(),
  })
  .strict()
export type ImportedConversation = {
  messages: Message[]
  config?: Partial<PlaygroundConfig>
  parameterEnabled?: Partial<ParameterEnabled>
}
export function parseConversationImport(raw: string): ImportedConversation {
  if (new TextEncoder().encode(raw).byteLength > MAX_CONVERSATION_FILE_BYTES) {
    throw new PlaygroundStorageError('limit')
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new PlaygroundStorageError('invalid')
  }
  const result = transferSchema.safeParse(value)
  if (!result.success) {
    throw new PlaygroundStorageError('invalid')
  }
  return {
    messages: restoreConversationMessages(
      validateConversationMessages(result.data.messages)
    ),
    config: result.data.config,
    parameterEnabled: result.data.parameterEnabled,
  }
}
export function exportConversationJSON(
  messages: Message[],
  config: PlaygroundConfig,
  parameterEnabled: ParameterEnabled,
  userID: number
): string {
  if (currentPlaygroundUserID() !== userID) {
    throw new PlaygroundStorageError('account')
  }
  const parsedConfig = playgroundConfigSchema.safeParse(config)
  const parsedParameters = parameterEnabledSchema.safeParse(parameterEnabled)
  const data = {
    format: 'new-api-playground',
    version: 1,
    exportedAt: new Date().toISOString(),
    messages: messagesSchema.parse(messages),
    ...(parsedConfig.success ? { config: parsedConfig.data } : {}),
    ...(parsedParameters.success
      ? { parameterEnabled: parsedParameters.data }
      : {}),
  }
  return JSON.stringify(data)
}
function markdownFilename(name: string): string {
  return name.replaceAll(/[[\]<>\r\n]/g, '_')
}
export function exportConversationMarkdown(
  messages: Message[],
  userID: number
): string {
  if (currentPlaygroundUserID() !== userID) {
    throw new PlaygroundStorageError('account')
  }
  const validated = messagesSchema.parse(messages)
  const sections = ['# New API Playground', '']
  for (const message of validated) {
    const version = message.versions[0]
    sections.push(`## ${message.from}`, '', version.content, '')
    for (const attachment of version.attachments ?? []) {
      const name = markdownFilename(attachment.name)
      if (attachment.kind === 'text') {
        sections.push(`### ${name}`, '', attachment.text ?? '', '')
      } else if (attachment.kind === 'image') {
        sections.push(`![${name}](${attachment.dataUrl})`, '')
      } else {
        sections.push(`[${name}](${attachment.dataUrl})`, '')
      }
    }
    if (message.reasoning?.content) {
      sections.push('### Reasoning', '', message.reasoning.content, '')
    }
  }
  return sections.join('\n')
}
export function downloadConversation(
  contents: string,
  format: 'json' | 'md'
): void {
  const blob = new Blob([contents], {
    type:
      format === 'json'
        ? 'application/json;charset=utf-8'
        : 'text/markdown;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `new-api-playground-${new Date().toISOString().slice(0, 10)}.${format}`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
