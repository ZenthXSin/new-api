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
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { MessageAlignment } from '../../lib'
import type { Message } from '../../types'

type MessageMetadataProps = {
  alignment: MessageAlignment
  message: Message
}

function formatMessageTime(timestamp?: number): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

function formatDuration(
  durationMs: number | undefined,
  t: TFunction
): string | undefined {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return undefined
  }

  if (durationMs < 1000) {
    return t('{{value}}ms', { value: Math.max(1, Math.round(durationMs)) })
  }

  return t('{{value}}s', { value: (durationMs / 1000).toFixed(2) })
}

export function MessageMetadata(props: MessageMetadataProps) {
  const { t } = useTranslation()
  const messageTime = formatMessageTime(props.message.createdAt)
  const duration = formatDuration(props.message.durationMs, t)
  const firstToken = formatDuration(props.message.firstTokenMs, t)
  const usage = props.message.usage
  const metrics: string[] = []
  if (duration) metrics.push(t('Response time: {{duration}}', { duration }))
  if (firstToken) {
    metrics.push(t('First token: {{duration}}', { duration: firstToken }))
  }
  if (usage) {
    metrics.push(
      t('Input tokens: {{count}}', { count: formatNumber(usage.prompt_tokens) })
    )
    metrics.push(
      t('Output tokens: {{count}}', {
        count: formatNumber(usage.completion_tokens),
      })
    )
    metrics.push(
      t('Total tokens: {{count}}', { count: formatNumber(usage.total_tokens) })
    )
    if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
      metrics.push(
        t('Cached input tokens: {{count}}', {
          count: formatNumber(usage.prompt_tokens_details.cached_tokens),
        })
      )
    }
    if (usage.prompt_tokens_details?.cache_creation_tokens !== undefined) {
      metrics.push(
        t('Cache creation tokens: {{count}}', {
          count: formatNumber(
            usage.prompt_tokens_details.cache_creation_tokens
          ),
        })
      )
    }
    if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
      metrics.push(
        t('Reasoning tokens: {{count}}', {
          count: formatNumber(usage.completion_tokens_details.reasoning_tokens),
        })
      )
    }
  }
  if (props.message.finishReason === 'length') {
    metrics.push(t('Output limit reached'))
  }
  if (props.message.finishReason === 'content_filter') {
    metrics.push(t('Response filtered'))
  }
  if (
    props.message.finishReason === 'tool_calls' &&
    !props.message.versions[0]?.content
  ) {
    metrics.push(t('Tool calls returned without text'))
  }

  if (!messageTime && !metrics.length) {
    return null
  }

  return (
    <div
      className={cn(
        'text-muted-foreground mt-1 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed',
        props.alignment === 'right' && 'justify-end'
      )}
    >
      {messageTime && <time>{messageTime}</time>}
      {metrics.map((metric) => (
        <span key={metric}>{metric}</span>
      ))}
    </div>
  )
}
