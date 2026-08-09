/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { VChart } from '@visactor/react-vchart'
import { BarChart3, LineChart } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useChartTheme } from '@/lib/use-chart-theme'
import { cn } from '@/lib/utils'
import { VCHART_OPTION } from '@/lib/vchart'

import type { EventRegion, EventTrend, UsageSummary } from './api'
import { formatOnlineDuration, formatTelemetryBucket } from './telemetry-data'

const CHART_COLORS = [
  '#0f766e',
  '#2563eb',
  '#d97706',
  '#db2777',
  '#7c3aed',
  '#0891b2',
  '#65a30d',
  '#dc2626',
]

function chartTokens(resolvedTheme: string) {
  return {
    text:
      resolvedTheme === 'dark'
        ? 'rgba(255, 255, 255, 0.68)'
        : 'rgba(15, 23, 42, 0.58)',
    grid:
      resolvedTheme === 'dark'
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(15, 23, 42, 0.12)',
  }
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className='text-muted-foreground flex h-64 items-center justify-center text-sm'>
      {message}
    </div>
  )
}

function ChartFrame({
  title,
  icon,
  children,
  className,
}: {
  title: string
  icon: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('overflow-hidden rounded-lg border', className)}>
      <header className='flex items-center gap-2 border-b px-4 py-3'>
        <span className='text-primary'>{icon}</span>
        <h3 className='text-sm font-semibold'>{title}</h3>
      </header>
      <div className='px-3 py-2'>{children}</div>
    </section>
  )
}

export type UsageMetric = 'starts' | 'online_seconds'

export function TelemetryUsageTrendChart({
  data,
  metric,
}: {
  data: UsageSummary['trend']
  metric: UsageMetric
}) {
  const { resolvedTheme, themeReady } = useChartTheme()
  const tokens = chartTokens(resolvedTheme)
  const points = useMemo(() => data ?? [], [data])
  const spec = useMemo(() => {
    if (points.length === 0) return null
    const values = points.map((point) => ({
      bucket_ts: point.bucket_ts,
      value: metric === 'online_seconds' ? point.online_seconds : point.starts,
    }))
    return {
      type: 'line' as const,
      data: [{ id: 'usage-trend', values }],
      xField: 'bucket_ts',
      yField: 'value',
      line: { style: { stroke: '#0f766e', lineWidth: 2.5 } },
      point: {
        visible: values.length <= 48,
        style: { fill: '#0f766e', stroke: '#ffffff', lineWidth: 1.5, size: 5 },
      },
      tooltip: {
        mark: {
          title: {
            value: (datum: { bucket_ts: number }) =>
              formatTelemetryBucket(datum.bucket_ts),
          },
          content: [
            {
              key: metric === 'online_seconds' ? '在线时长' : '启动次数',
              value: (datum: { value: number }) =>
                metric === 'online_seconds'
                  ? formatOnlineDuration(datum.value)
                  : String(datum.value),
            },
          ],
        },
      },
      axes: [
        {
          orient: 'bottom',
          label: {
            formatMethod: (value: number | string) =>
              formatTelemetryBucket(Number(value)),
            style: { fill: tokens.text, fontSize: 10 },
            autoLimit: true,
          },
          tick: { visible: false },
        },
        {
          orient: 'left',
          label: {
            formatMethod: (value: number | string) =>
              metric === 'online_seconds'
                ? formatOnlineDuration(Number(value))
                : String(value),
            style: { fill: tokens.text, fontSize: 10 },
          },
          grid: {
            visible: true,
            style: { lineDash: [3, 3], stroke: tokens.grid },
          },
        },
      ],
      animationAppear: { duration: 350 },
    }
  }, [metric, points, tokens.grid, tokens.text])

  return (
    <ChartFrame
      title={metric === 'online_seconds' ? '在线时长趋势' : '启动次数趋势'}
      icon={<LineChart className='size-4' aria-hidden='true' />}
    >
      {points.length === 0 ? (
        <EmptyChart message={'暂无趋势数据'} />
      ) : (
        <div className='h-64 sm:h-72'>
          {themeReady && spec && (
            <VChart
              key={`usage-trend-${metric}-${resolvedTheme}`}
              spec={{
                ...spec,
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
              option={VCHART_OPTION}
            />
          )}
        </div>
      )}
    </ChartFrame>
  )
}

export type EventMetric = 'count' | 'unique_users'

export function TelemetryEventTrendChart({
  data,
  metric,
}: {
  data: EventTrend[]
  metric: EventMetric
}) {
  const { resolvedTheme, themeReady } = useChartTheme()
  const tokens = chartTokens(resolvedTheme)
  const points = data
  const names = useMemo(() => {
    const totals = new Map<string, number>()
    for (const row of points) {
      totals.set(row.name, (totals.get(row.name) ?? 0) + row[metric])
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name)
  }, [metric, points])
  const visiblePoints = useMemo(
    () => points.filter((point) => names.includes(point.name)),
    [names, points]
  )
  const spec = useMemo(() => {
    if (visiblePoints.length === 0) return null
    const values = visiblePoints.map((point) => ({
      bucket_ts: point.bucket_ts,
      name: point.name,
      value: point[metric],
    }))
    return {
      type: 'line' as const,
      data: [{ id: 'event-trend', values }],
      xField: 'bucket_ts',
      yField: 'value',
      seriesField: 'name',
      color: CHART_COLORS,
      line: { style: { lineWidth: 2 } },
      point: {
        visible: visiblePoints.length <= 48,
        style: { size: 4, stroke: '#ffffff', lineWidth: 1 },
      },
      legends: {
        visible: names.length > 1,
        orient: 'bottom',
        maxRow: 2,
        item: { label: { style: { fill: tokens.text, fontSize: 10 } } },
      },
      tooltip: {
        dimension: {
          title: {
            value: (datum: { bucket_ts: number }) =>
              formatTelemetryBucket(datum.bucket_ts),
          },
          content: [
            {
              key: (datum: { name: string }) => datum.name,
              value: (datum: { value: number }) => String(datum.value),
            },
          ],
        },
      },
      axes: [
        {
          orient: 'bottom',
          label: {
            formatMethod: (value: number | string) =>
              formatTelemetryBucket(Number(value)),
            style: { fill: tokens.text, fontSize: 10 },
            autoLimit: true,
          },
          tick: { visible: false },
        },
        {
          orient: 'left',
          label: { style: { fill: tokens.text, fontSize: 10 } },
          grid: {
            visible: true,
            style: { lineDash: [3, 3], stroke: tokens.grid },
          },
        },
      ],
      animationAppear: { duration: 350 },
    }
  }, [metric, names, tokens.grid, tokens.text, visiblePoints])

  return (
    <ChartFrame
      title={metric === 'unique_users' ? '事件独立 IP 趋势' : '事件触发趋势'}
      icon={<LineChart className='size-4' aria-hidden='true' />}
    >
      {visiblePoints.length === 0 ? (
        <EmptyChart message={'暂无事件趋势数据'} />
      ) : (
        <div className='h-72 sm:h-80'>
          {themeReady && spec && (
            <VChart
              key={`event-trend-${metric}-${resolvedTheme}`}
              spec={{
                ...spec,
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
              option={VCHART_OPTION}
            />
          )}
        </div>
      )}
    </ChartFrame>
  )
}

export function TelemetryBarChart({
  title,
  rows,
  valueLabel,
  formatValue,
}: {
  title: string
  rows: Array<{ label: string; value: number }>
  valueLabel?: string
  formatValue?: (value: number) => string
}) {
  const { t } = useTranslation()
  const { resolvedTheme, themeReady } = useChartTheme()
  const tokens = chartTokens(resolvedTheme)
  const visibleRows = rows.filter(
    (row) => Number.isFinite(row.value) && row.value > 0
  )
  const spec = useMemo(() => {
    if (visibleRows.length === 0) return null
    return {
      type: 'bar' as const,
      direction: 'horizontal' as const,
      data: [{ id: 'telemetry-bars', values: visibleRows }],
      xField: 'value',
      yField: 'label',
      bar: { style: { fill: '#2563eb', cornerRadius: 4 } },
      label: {
        visible: true,
        position: 'right',
        style: { fill: tokens.text, fontSize: 10 },
        formatMethod: (value: number | string) =>
          formatValue ? formatValue(Number(value)) : String(value),
      },
      axes: [
        {
          orient: 'left',
          label: {
            style: { fill: tokens.text, fontSize: 10 },
            autoLimit: true,
          },
          tick: { visible: false },
        },
        {
          orient: 'bottom',
          label: { style: { fill: tokens.text, fontSize: 10 } },
          grid: {
            visible: true,
            style: { lineDash: [3, 3], stroke: tokens.grid },
          },
        },
      ],
      tooltip: {
        mark: {
          title: { value: (datum: { label: string }) => datum.label },
          content: [
            {
              key: valueLabel ?? '数量',
              value: (datum: { value: number }) =>
                formatValue ? formatValue(datum.value) : String(datum.value),
            },
          ],
        },
      },
    }
  }, [formatValue, t, tokens.grid, tokens.text, valueLabel, visibleRows])

  return (
    <ChartFrame
      title={title}
      icon={<BarChart3 className='size-4' aria-hidden='true' />}
    >
      {visibleRows.length === 0 ? (
        <EmptyChart message={'暂无排行数据'} />
      ) : (
        <div className='h-56 sm:h-64'>
          {themeReady && spec && (
            <VChart
              key={`telemetry-bars-${resolvedTheme}-${title}`}
              spec={{
                ...spec,
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
              option={VCHART_OPTION}
            />
          )}
        </div>
      )}
    </ChartFrame>
  )
}

export function TelemetryRegionChart({
  rows,
  title,
  valueLabel,
}: {
  rows: EventRegion[]
  title: string
  valueLabel: string
}) {
  const chartRows = rows.slice(0, 12).map((row) => ({
    label:
      [row.country, row.region, row.city]
        .filter((value) => value && value !== '未知')
        .join(' / ') || '未知地区',
    value: row.unique_users,
  }))
  return (
    <TelemetryBarChart title={title} rows={chartRows} valueLabel={valueLabel} />
  )
}
