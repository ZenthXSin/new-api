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
import { after, test } from 'node:test'

import { Window } from 'happy-dom'

import type { DownloadBucket } from '../api'
import type { DownloadsSummary } from '../telemetry-data'

// 测试运行器（bun test）提供模块级 mock；静态引入类型解析不到
// `bun:test`，这里运行时获取以避免对真实 canvas 的依赖。
const bunTestSpecifier = 'bun:test'
const { mock } = (await import(bunTestSpecifier)) as unknown as {
  mock: { module: (path: string, factory: () => unknown) => void }
}
mock.module('@visactor/react-vchart', () => ({
  VChart: ({ spec }: { spec?: unknown }) => (
    <div
      data-testid='vchart'
      data-spec={spec ? JSON.stringify(spec) : undefined}
    />
  ),
}))
mock.module('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: () => {} },
}))

const domWindow = new Window()
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'SVGElement',
  'Node',
  'Element',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: domWindow[key],
  })
}

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

  assert.equal(result.total, 16)
  assert.deepEqual(result.series, [
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

  assert.equal(result.total, 23)
  assert.deepEqual(
    result.series.map((series) => series.version),
    ['1.0.0', '2.0.0']
  )
  const first = result.series[0]
  const second = result.series[1]
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.points.length, 24)
  assert.equal(second.points.length, 24)
  assert.deepEqual(first.points[0], { bucket_ts: 3600, count: 4 })
  assert.deepEqual(first.points[22], { bucket_ts: 82800, count: 9 })
  assert.equal(first.points[1]?.count, 0)
  assert.equal(first.points[23]?.count, 0)
  assert.deepEqual(second.points.slice(0, 2), [
    { bucket_ts: 3600, count: 7 },
    { bucket_ts: 7200, count: 3 },
  ])
  assert.equal(second.points[23]?.count, 0)
})

test('returns an empty summary when there are no download rows', () => {
  assert.deepEqual(summarizeDownloads([]), { total: 0, series: [] })
  assert.deepEqual(summarizeDownloads([], 24, 86400), { total: 0, series: [] })
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

  assert.ok(container.textContent?.includes('下载量趋势'))
  const chart = container.querySelector('[data-testid="vchart"]')
  assert.ok(chart, 'chart should render when data exists')
  const spec = chart?.getAttribute('data-spec') ?? ''
  assert.match(spec, /2\.0\.0/)
  assert.match(spec, /1\.0\.0/)

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

  assert.ok(container.textContent?.includes('下载量趋势'))
  assert.ok(container.textContent?.includes('暂无下载数据'))
  assert.equal(container.querySelector('[data-testid="vchart"]'), null)

  await act(async () => root.unmount())
  container.remove()
})

after(() => domWindow.close())
