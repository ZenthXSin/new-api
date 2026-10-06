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

export const STORAGE_VERSION = 2
export const MAX_STORED_MESSAGES = 2000
export const MAX_STORED_MESSAGES_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_ATTACHMENTS_BYTES = 12 * 1024 * 1024
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024
export const MAX_ATTACHMENTS = 6
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength
const finiteTime = z.number().finite().nonnegative()
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(256)

export const playgroundConfigSchema = z
  .object({
    model: z.string().max(512).optional(),
    group: z.string().max(128).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    top_p: z.number().finite().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(200000).optional(),
    frequency_penalty: z.number().finite().min(-2).max(2).optional(),
    presence_penalty: z.number().finite().min(-2).max(2).optional(),
    seed: z.number().int().min(0).max(2147483647).nullable().optional(),
    stream: z.boolean().optional(),
    system_prompt: z.string().max(16000).optional(),
    web_search: z.boolean().optional(),
    search_context_size: z.enum(['low', 'medium', 'high']).optional(),
    reasoning_effort: z.enum(['default', 'low', 'medium', 'high']).optional(),
    response_format: z.enum(['text', 'json_object']).optional(),
    stop: z.array(z.string().max(128)).max(4).optional(),
  })
  .strict()
export const parameterEnabledSchema = z
  .object({
    temperature: z.boolean().optional(),
    top_p: z.boolean().optional(),
    max_tokens: z.boolean().optional(),
    frequency_penalty: z.boolean().optional(),
    presence_penalty: z.boolean().optional(),
    seed: z.boolean().optional(),
  })
  .strict()

export const attachmentSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
    kind: z.enum(['image', 'text', 'pdf']),
    dataUrl: z
      .string()
      .max(MAX_ATTACHMENT_BYTES * 1.4 + 256)
      .optional(),
    text: z.string().max(MAX_TEXT_ATTACHMENT_BYTES).optional(),
  })
  .strict()
  .superRefine((attachment, ctx) => {
    const invalid = () =>
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid or unavailable attachment',
      })
    if (attachment.kind === 'text') {
      if (
        attachment.text === undefined ||
        attachment.dataUrl !== undefined ||
        byteLength(attachment.text) > MAX_TEXT_ATTACHMENT_BYTES ||
        attachment.size > MAX_TEXT_ATTACHMENT_BYTES ||
        byteLength(attachment.text) > attachment.size
      ) {
        invalid()
      }
      return
    }
    if (attachment.text !== undefined || !attachment.dataUrl) {
      invalid()
      return
    }
    const mime =
      attachment.kind === 'pdf' ? 'application/pdf' : attachment.mimeType
    if (
      attachment.kind === 'image' &&
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)
    ) {
      invalid()
      return
    }
    if (attachment.mimeType !== mime) {
      invalid()
      return
    }
    const prefix = `data:${mime};base64,`
    if (!attachment.dataUrl.startsWith(prefix)) {
      invalid()
      return
    }
    const data = attachment.dataUrl.slice(prefix.length)
    if (
      !data ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
      invalid()
      return
    }
    const bytes =
      (data.length / 4) * 3 -
      (data.endsWith('==') ? 2 : Number(data.endsWith('=')))
    if (bytes !== attachment.size || bytes > MAX_ATTACHMENT_BYTES) {
      invalid()
    }
  })
export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(MAX_ATTACHMENTS)
  .superRefine((items, ctx) => {
    if (
      items.reduce((sum, item) => sum + item.size, 0) > MAX_ATTACHMENTS_BYTES ||
      new Set(items.map((item) => item.id)).size !== items.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Attachments exceed the conversation limit',
      })
    }
  })
const versionSchema = z
  .object({
    id: identifier,
    content: z.string(),
    attachments: attachmentsSchema.optional(),
  })
  .strict()
const sourceSchema = z
  .object({
    href: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value)),
    title: z.string().max(4096),
  })
  .strict()
const reasoningSchema = z
  .object({
    content: z.string(),
    duration: finiteTime,
    startedAt: finiteTime.optional(),
    completedAt: finiteTime.optional(),
    durationMs: finiteTime.optional(),
  })
  .strict()
const usageSchema = z
  .object({
    prompt_tokens: nonnegativeInteger,
    completion_tokens: nonnegativeInteger,
    total_tokens: nonnegativeInteger,
    prompt_tokens_details: z
      .object({
        cached_tokens: nonnegativeInteger.optional(),
        cache_creation_tokens: nonnegativeInteger.optional(),
      })
      .strict()
      .optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: nonnegativeInteger.optional() })
      .strict()
      .optional(),
  })
  .strict()
const messageSchema = z
  .object({
    key: identifier,
    from: z.enum(['user', 'assistant', 'system']),
    versions: z.array(versionSchema).min(1).max(100),
    createdAt: finiteTime.optional(),
    startedAt: finiteTime.optional(),
    completedAt: finiteTime.optional(),
    durationMs: finiteTime.optional(),
    firstTokenAt: finiteTime.optional(),
    firstTokenMs: finiteTime.optional(),
    usage: usageSchema.optional(),
    model: z.string().max(512).optional(),
    finishReason: z.string().max(256).optional(),
    sources: z.array(sourceSchema).max(100).optional(),
    reasoning: reasoningSchema.optional(),
    isReasoningStreaming: z.boolean().optional(),
    isReasoningComplete: z.boolean().optional(),
    isContentComplete: z.boolean().optional(),
    status: z.enum(['loading', 'streaming', 'complete', 'error']).optional(),
    errorCode: z.string().max(256).nullable().optional(),
    errorMessage: z.string().optional(),
  })
  .strict()
export const messagesSchema = z
  .array(messageSchema)
  .max(MAX_STORED_MESSAGES)
  .superRefine((messages, ctx) => {
    if (
      new Set(messages.map((message) => message.key)).size !== messages.length
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate conversation message IDs',
      })
    }
  })
