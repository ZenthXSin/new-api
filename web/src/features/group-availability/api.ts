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
import { api } from '@/lib/api'

export type AvailabilityRange = '90m' | '24h' | '7d' | '30d'
export type AvailabilityStatus = 'unknown' | 'healthy' | 'warning' | 'critical'
export type AvailabilitySampleState = 'none' | 'insufficient' | 'sufficient'

export interface AvailabilityMetrics {
  status: AvailabilityStatus
  sample_state: AvailabilitySampleState
  request_count: number | null
  success_count: number | null
  error_count: number | null
  success_rate: number | null
  cache_hit_rate: number | null
  avg_ttft_ms: number | null
  avg_duration_ms: number | null
}

export interface AvailabilityBucket extends AvailabilityMetrics {
  start_time: number
}

export interface AvailabilityGroup extends AvailabilityMetrics {
  group: string
  display_name: string
  description?: string
  last_request_at: number | null
  buckets: AvailabilityBucket[]
}

export interface GroupAvailabilityData {
  range: AvailabilityRange
  source: 'passive_requests'
  bucket_seconds: number
  generated_at: number
  refresh_interval_seconds: number
  data_through: number | null
  start_time: number
  end_time: number
  collection_started_at: number
  coverage_complete: boolean
  min_samples: number
  warning_error_rate: number
  critical_error_rate: number
  groups: AvailabilityGroup[]
}

export async function getGroupAvailability(
  range: AvailabilityRange,
  signal?: AbortSignal,
  sort: 'auto' | 'name' = 'name'
): Promise<GroupAvailabilityData> {
  try {
    const response = await api.get<{
      success: boolean
      message?: string
      data: GroupAvailabilityData
    }>('/api/group-availability', {
      params: { range, sort },
      skipRequestDedup: true,
      headers: { 'Cache-Control': 'no-cache, no-store' },
      signal,
      skipBusinessError: true,
      skipErrorHandler: true,
    })
    if (!response.data.success) {
      throw new Error('Unable to load group availability', {
        cause: response.data,
      })
    }
    return response.data.data
  } catch (error) {
    throw new Error('Unable to load group availability', { cause: error })
  }
}
