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
import { VChart } from '@visactor/react-vchart'
import { LineChart } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { formatLogQuota } from '@/lib/format'
import { useChartTheme } from '@/lib/use-chart-theme'
import { VCHART_OPTION } from '@/lib/vchart'

import type { CostTrendPoint } from '../api'

const REVENUE_COLOR = '#0f766e'
const COST_COLOR = '#d97706'
const PROFIT_COLOR = '#2563eb'

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

function ChartCard({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className='border-border bg-card rounded-lg border p-4'>
      <header className='flex items-center gap-2 pb-3'>
        <span className='text-primary'>{icon}</span>
        <h3 className='text-sm font-semibold'>{title}</h3>
      </header>
      <div className='px-1 py-2'>{children}</div>
    </section>
  )
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className='text-muted-foreground flex h-40 items-center justify-center text-sm'>
      {message}
    </div>
  )
}

export function RevenueTrendChart({
  data,
  loading,
  error,
}: {
  data: CostTrendPoint[] | undefined
  loading: boolean
  error: boolean
}) {
  const { t } = useTranslation()
  const { resolvedTheme, themeReady } = useChartTheme()
  const tokens = useMemo(() => chartTokens(resolvedTheme), [resolvedTheme])
  const points = useMemo(() => data ?? [], [data])

  const seriesLabel = useCallback(
    (series: string) => {
      if (series === 'revenue') return t('Revenue')
      if (series === 'cost') return t('Cost')
      return t('Gross Profit')
    },
    [t]
  )

  const spec = useMemo(() => {
    if (points.length === 0) return null
    const flat = points.flatMap((point) => [
      { date: point.date, series: 'revenue', value: point.revenue_quota },
      { date: point.date, series: 'cost', value: point.cost_quota },
      { date: point.date, series: 'profit', value: point.gross_profit_quota },
    ])
    return {
      type: 'line' as const,
      data: [{ id: 'revenue-trend', values: flat }],
      xField: 'date',
      yField: 'value',
      seriesField: 'series',
      color: [REVENUE_COLOR, COST_COLOR, PROFIT_COLOR],
      line: { style: { lineWidth: 2 } },
      point: { visible: points.length <= 30, style: { size: 3 } },
      legends: { visible: true, orient: 'bottom', maxRow: 1 },
      tooltip: {
        dimension: {
          content: [
            {
              key: (datum: { series: string }) => seriesLabel(datum.series),
              value: (datum: { value: number }) => formatLogQuota(datum.value),
            },
          ],
        },
      },
      axes: [
        {
          orient: 'bottom',
          label: { style: { fill: tokens.text, fontSize: 10 } },
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
  }, [points, seriesLabel, tokens])

  if (loading) {
    return (
      <ChartCard
        title={t('Revenue Trend')}
        icon={<LineChart className='size-4' aria-hidden='true' />}
      >
        <div className='text-muted-foreground flex h-40 items-center justify-center text-sm'>
          {t('Loading')}
        </div>
      </ChartCard>
    )
  }
  if (error) {
    return (
      <ChartCard
        title={t('Revenue Trend')}
        icon={<LineChart className='size-4' aria-hidden='true' />}
      >
        <div className='text-destructive flex h-40 items-center justify-center text-sm'>
          {t('Failed to load finance overview')}
        </div>
      </ChartCard>
    )
  }

  const flat = points.flatMap((point) => [
    { date: point.date, series: 'revenue', value: point.revenue_quota },
    { date: point.date, series: 'cost', value: point.cost_quota },
    { date: point.date, series: 'profit', value: point.gross_profit_quota },
  ])

  return (
    <ChartCard
      title={t('Revenue Trend')}
      icon={<LineChart className='size-4' aria-hidden='true' />}
    >
      {points.length === 0 ? (
        <EmptyChart message={t('No Data')} />
      ) : (
        <div className='h-64 sm:h-72'>
          {themeReady && spec && (
            <VChart
              key={`revenue-trend-${resolvedTheme}`}
              spec={{
                ...spec,
                data: [{ id: 'revenue-trend', values: flat }],
                theme: resolvedTheme === 'dark' ? 'dark' : 'light',
                background: 'transparent',
              }}
              option={VCHART_OPTION}
            />
          )}
        </div>
      )}
    </ChartCard>
  )
}
