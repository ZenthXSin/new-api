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
import type { Message, PlaygroundUsage } from '../../types'

export type ResponseMetadata = Pick<
  Message,
  'sources' | 'usage' | 'model' | 'finishReason' | 'firstTokenAt'
>

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

export function normalizeSources(
  value: unknown
): NonNullable<Message['sources']> {
  if (!Array.isArray(value)) return []
  const sources = new Map<string, { href: string; title: string }>()
  for (const source of value) {
    const record = asRecord(source)
    const href = safeSourceUrl(
      typeof source === 'string' ? source : (record?.href ?? record?.url)
    )
    if (!href || sources.has(href)) continue
    const title =
      typeof record?.title === 'string' && record.title.trim()
        ? record.title.trim().slice(0, 512)
        : new URL(href).hostname
    sources.set(href, { href, title })
    if (sources.size === 100) break
  }
  return [...sources.values()]
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

export function readUsage(value: unknown): PlaygroundUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const prompt = tokenCount(usage.prompt_tokens)
  const completion = tokenCount(usage.completion_tokens)
  const total = tokenCount(usage.total_tokens)
  if (prompt === undefined || completion === undefined || total === undefined) {
    return undefined
  }
  const promptDetails = asRecord(usage.prompt_tokens_details)
  const completionDetails = asRecord(usage.completion_tokens_details)
  const cached = tokenCount(promptDetails?.cached_tokens)
  const created = tokenCount(promptDetails?.cache_creation_tokens)
  const reasoning = tokenCount(completionDetails?.reasoning_tokens)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(cached !== undefined || created !== undefined
      ? {
          prompt_tokens_details: {
            ...(cached !== undefined ? { cached_tokens: cached } : {}),
            ...(created !== undefined
              ? { cache_creation_tokens: created }
              : {}),
          },
        }
      : {}),
    ...(reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  }
}

export function readResponseMetadata(value: unknown): ResponseMetadata {
  const response = asRecord(value)
  if (!response) return {}
  const choice = asRecord(
    Array.isArray(response.choices) ? response.choices[0] : undefined
  )
  const content = asRecord(choice?.delta) ?? asRecord(choice?.message)
  const candidates: unknown[] = []
  for (const container of [response, content]) {
    if (!container) continue
    if (Array.isArray(container.annotations)) {
      for (const annotation of container.annotations) {
        const item = asRecord(annotation)
        if (item?.type === 'url_citation' || item?.url_citation) {
          candidates.push(item.url_citation ?? item)
        }
      }
    }
    for (const key of ['citations', 'sources']) {
      if (Array.isArray(container[key])) candidates.push(...container[key])
    }
  }
  const sources = normalizeSources(candidates)
  const usage = readUsage(response.usage)
  return {
    ...(sources.length ? { sources } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof response.model === 'string' && response.model
      ? { model: response.model }
      : {}),
    ...(typeof choice?.finish_reason === 'string' && choice.finish_reason
      ? { finishReason: choice.finish_reason }
      : {}),
  }
}

export function mergeResponseMetadata(
  current: ResponseMetadata,
  incoming: ResponseMetadata
): ResponseMetadata {
  const result = { ...current, ...incoming }
  if (incoming.sources) {
    result.sources = normalizeSources([
      ...(current.sources ?? []),
      ...incoming.sources,
    ])
  }
  if (incoming.usage && current.usage) {
    result.usage = {
      ...current.usage,
      ...incoming.usage,
      prompt_tokens_details: {
        ...current.usage.prompt_tokens_details,
        ...incoming.usage.prompt_tokens_details,
      },
      completion_tokens_details: {
        ...current.usage.completion_tokens_details,
        ...incoming.usage.completion_tokens_details,
      },
    }
  }
  result.firstTokenAt = current.firstTokenAt ?? incoming.firstTokenAt
  return result
}

export function applyResponseMetadata(
  message: Message,
  metadata: ResponseMetadata
): Message {
  const merged = mergeResponseMetadata(message, metadata)
  const firstTokenAt = merged.firstTokenAt
  const startedAt = message.startedAt ?? message.createdAt
  return {
    ...message,
    ...merged,
    ...(firstTokenAt !== undefined && startedAt !== undefined
      ? { firstTokenMs: Math.max(0, firstTokenAt - startedAt) }
      : {}),
  }
}

export function readResponseText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      const item = asRecord(part)
      return typeof item?.text === 'string' ? item.text : ''
    })
    .join('')
}
