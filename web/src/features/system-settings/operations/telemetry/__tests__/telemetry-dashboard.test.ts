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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { TelemetryTimeSeriesRow } from '../api'
import { buildTelemetryDashboardData } from '../telemetry-dashboard-data'

const rows: TelemetryTimeSeriesRow[] = [
  {
    app_id: 1,
    bucket_ts: 1_785_681_600,
    app_version: 'v1.0.0',
    event_type: 'startup',
    dimension: 'summary',
    status: 'success',
    event_count: 3,
    success_count: 3,
    total_duration_ms: 300,
    total_value: 6,
  },
  {
    app_id: 1,
    bucket_ts: 1_785_681_600,
    app_version: 'v1.0.0',
    event_type: 'request_summary',
    dimension: 'chat',
    status: 'failure',
    event_count: 2,
    success_count: 0,
    total_duration_ms: 700,
    total_value: 4,
  },
  {
    app_id: 1,
    bucket_ts: 1_785_685_200,
    app_version: 'v1.0.1',
    event_type: 'startup',
    dimension: 'summary',
    status: 'success',
    event_count: 5,
    success_count: 4,
    total_duration_ms: 1_000,
    total_value: 10,
  },
]

describe('telemetry dashboard data', () => {
  test('returns safe zero metrics for empty data', () => {
    const result = buildTelemetryDashboardData([])

    assert.equal(result.totalEvents, 0)
    assert.equal(result.successRate, 0)
    assert.equal(result.averageDurationMs, 0)
    assert.equal(result.totalValue, 0)
    assert.deepEqual(result.trendData, [])
    assert.deepEqual(result.statusData, [])
    assert.deepEqual(result.eventTypeData, [])
  })

  test('builds KPIs and chart series from hourly aggregate rows', () => {
    const result = buildTelemetryDashboardData(rows)

    assert.equal(result.totalEvents, 10)
    assert.equal(result.successRate, 70)
    assert.equal(result.averageDurationMs, 200)
    assert.equal(result.totalValue, 20)
    assert.deepEqual(
      result.trendData.map((item) => [
        item.time,
        item.status,
        item.value,
      ]),
      [
        [1_785_679_200_000, 'success', 3],
        [1_785_679_200_000, 'failure', 2],
        [1_785_682_800_000, 'success', 5],
      ]
    )
    assert.deepEqual(result.statusData, [
      { category: 'success', value: 8 },
      { category: 'failure', value: 2 },
    ])
    assert.deepEqual(result.eventTypeData, [
      { category: 'startup', value: 8 },
      { category: 'request_summary', value: 2 },
    ])
  })

  test('groups trend points according to the selected time range', () => {
    const result = buildTelemetryDashboardData(
      [
        { ...rows[0], bucket_ts: 1_785_681_600, event_count: 3 },
        { ...rows[0], bucket_ts: 1_785_685_200, event_count: 5 },
        { ...rows[0], bucket_ts: 1_785_706_800, event_count: 7 },
      ],
      168
    )

    assert.deepEqual(
      result.trendData.map((item) => [item.time, item.value]),
      [
        [1_785_672_000_000, 8],
        [1_785_693_600_000, 7],
      ]
    )
  })
})
