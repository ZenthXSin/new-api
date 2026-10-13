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
import type { ChannelIntelligenceCheck } from '../types'

export const CHANNEL_INTELLIGENCE_PROMPT =
  '不搜索互联网，不读取上下文，不调用插件。你能识别X上的Thibault Sottiaux是谁吗?如果能，只回答“不降智”;如果不能，只回答"降智”。'

export function parseChannelIntelligenceCheck(
  value: string | null | undefined
): ChannelIntelligenceCheck | null {
  if (!value) return null
  try {
    const result: unknown = JSON.parse(value)
    if (!result || typeof result !== 'object') return null
    const record = result as Record<string, unknown>
    if (
      !['passed', 'degraded', 'inconclusive', 'error'].includes(
        String(record.status)
      ) ||
      typeof record.response !== 'string' ||
      typeof record.model !== 'string' ||
      typeof record.checked_at !== 'number' ||
      typeof record.auto_disabled !== 'boolean'
    ) {
      return null
    }
    return record as unknown as ChannelIntelligenceCheck
  } catch {
    return null
  }
}
