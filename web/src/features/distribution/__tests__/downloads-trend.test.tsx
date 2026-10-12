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
import { expect, test, vi } from 'vitest'

import type { DownloadBucket } from '../api'
import type { DownloadsSummary } from '../telemetry-data'

// 避免对真实 canvas 的依赖,用 mock 组件替换 VChart 渲染
vi.mock('@visactor/react-vchart', () => ({
  VChart: ({ spec }: { spec?: unknown }) => (
    <div
      data-testid='vchart'
      data-spec={spec ? JSON.stringify(spec) : undefined}
    />
  ),
}))
vi.mock('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: () => {} },
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

const { DownloadsTrendChart } = await import('../telemetry-charts')
const { summarizeDownloads } = await import('../telemetry-data')

async function waitForThemeReady() {
  // useChartTheme 通过动态 import 异步加载主题，等待其状态更新落盘
  for (let i = 0; i < 5; i++) {
    await act(async () => {})
  }
}

test('aggregates download buckets per version and sorts by total', () => {
  const rows: DownloadBucket[] = [
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '1.0.0',
      platform: 'windows',
      architecture: 'amd64',
      count: 2,
    },
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '1.0.0',
      platform: 'linux',
      architecture: 'amd64',
      count: 3,
    },
    {
      app_id: 1,
      bucket_ts: 9000,
      version: '1.0.0',
      platform: 'windows',
      architecture: 'arm64',
      count: 1,
    },
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '2.0.0',
      platform: 'windows',
      architecture: 'amd64',
      count: 10,
    },
  ]

  const result = summarizeDownloads(rows)

  expect(result.total).toBe(16)
  expect(result.series).toEqual([
    {
      version: '2.0.0',
      points: [{ bucket_ts: 3600, count: 10 }],
    },
    {
      version: '1.0.0',
      points: [
        { bucket_ts: 3600, count: 5 },
        { bucket_ts: 9000, count: 1 },
      ],
    },
  ])
})

test('fills every hourly bucket of the window with zeros per version', () => {
  const rows: DownloadBucket[] = [
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '1.0.0',
      platform: 'windows',
      architecture: 'amd64',
      count: 4,
    },
    {
      app_id: 1,
      bucket_ts: 82800,
      version: '1.0.0',
      platform: 'windows',
      architecture: 'arm64',
      count: 9,
    },
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '2.0.0',
      platform: 'windows',
      architecture: 'amd64',
      count: 7,
    },
    {
      app_id: 1,
      bucket_ts: 7200,
      version: '2.0.0',
      platform: 'macos',
      architecture: 'arm64',
      count: 3,
    },
  ]

  // referenceTimestamp=86400 → end=86400，窗口为 [3600, 86400] 共 24 个点
  const result = summarizeDownloads(rows, 24, 86400)

  expect(result.total).toBe(23)
  expect(result.series.map((series) => series.version)).toEqual([
    '1.0.0',
    '2.0.0',
  ])
  const first = result.series[0]
  const second = result.series[1]
  expect(first).toBeDefined()
  if (first === undefined) return
  expect(second).toBeDefined()
  if (second === undefined) return
  expect(first.points.length).toBe(24)
  expect(second.points.length).toBe(24)
  expect(first.points[0]).toEqual({ bucket_ts: 3600, count: 4 })
  expect(first.points[22]).toEqual({ bucket_ts: 82800, count: 9 })
  expect(first.points[1]?.count).toBe(0)
  expect(first.points[23]?.count).toBe(0)
  expect(second.points.slice(0, 2)).toEqual([
    { bucket_ts: 3600, count: 7 },
    { bucket_ts: 7200, count: 3 },
  ])
  expect(second.points[23]?.count).toBe(0)
})

test('returns an empty summary when there are no download rows', () => {
  expect(summarizeDownloads([])).toEqual({ total: 0, series: [] })
  expect(summarizeDownloads([], 24, 86400)).toEqual({ total: 0, series: [] })
})

test('renders the downloads trend chart with versions as series data', async () => {
  const summary: DownloadsSummary = {
    total: 16,
    series: [
      {
        version: '2.0.0',
        points: [
          { bucket_ts: 3600, count: 10 },
          { bucket_ts: 7200, count: 0 },
        ],
      },
      {
        version: '1.0.0',
        points: [{ bucket_ts: 3600, count: 5 }],
      },
    ],
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<DownloadsTrendChart data={summary} />)
  })
  await waitForThemeReady()

  expect(container.textContent?.includes('下载量趋势')).toBe(true)
  const chart = container.querySelector('[data-testid="vchart"]')
  expect(chart).not.toBeNull()
  if (chart === null) return
  const spec = chart?.getAttribute('data-spec') ?? ''
  expect(spec).toMatch(/2\.0\.0/)
  expect(spec).toMatch(/1\.0\.0/)

  await act(async () => root.unmount())
  container.remove()
})

test('shows the empty state without rendering a chart when no data exists', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<DownloadsTrendChart data={{ total: 0, series: [] }} />)
  })
  await waitForThemeReady()

  expect(container.textContent?.includes('下载量趋势')).toBe(true)
  expect(container.textContent?.includes('暂无下载数据')).toBe(true)
  expect(container.querySelector('[data-testid="vchart"]')).toBeNull()

  await act(async () => root.unmount())
  container.remove()
})
