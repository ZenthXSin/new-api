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
import type { TelemetryTimeSeriesRow } from './api'

export function buildTelemetryDashboardData(
  data: TelemetryTimeSeriesRow[],
  hours = 24
) {
  const totalEvents = data.reduce((sum, row) => sum + row.event_count, 0)
  const totalSuccesses = data.reduce(
    (sum, row) => sum + row.success_count,
    0
  )
  const totalDurationMs = data.reduce(
    (sum, row) => sum + row.total_duration_ms,
    0
  )
  const totalValue = data.reduce((sum, row) => sum + row.total_value, 0)
  const trend = new Map<string, number>()
  const statuses = new Map<string, number>()
  const eventTypes = new Map<string, number>()
  let bucketSeconds = 3600
  if (hours > 168) {
    bucketSeconds = 86400
  } else if (hours > 24) {
    bucketSeconds = 21600
  }

  for (const row of data) {
    const bucketTs = Math.floor(row.bucket_ts / bucketSeconds) * bucketSeconds
    const trendKey = `${bucketTs}:${row.status}`
    trend.set(trendKey, (trend.get(trendKey) ?? 0) + row.event_count)
    statuses.set(
      row.status,
      (statuses.get(row.status) ?? 0) + row.event_count
    )
    eventTypes.set(
      row.event_type,
      (eventTypes.get(row.event_type) ?? 0) + row.event_count
    )
  }

  return {
    totalEvents,
    successRate: totalEvents > 0 ? (totalSuccesses / totalEvents) * 100 : 0,
    averageDurationMs: totalEvents > 0 ? totalDurationMs / totalEvents : 0,
    totalValue,
    trendData: Array.from(trend, ([key, value]) => {
      const separatorIndex = key.lastIndexOf(':')
      const bucketTs = key.slice(0, separatorIndex)
      const status = key.slice(separatorIndex + 1)
      return {
        time: Number(bucketTs) * 1000,
        status,
        value,
      }
    }).sort((a, b) => a.time - b.time),
    statusData: Array.from(statuses, ([status, value]) => ({
      category: status,
      value,
    })),
    eventTypeData: Array.from(eventTypes, ([eventType, value]) => ({
      category: eventType,
      value,
    })).sort((a, b) => b.value - a.value),
  }
}
