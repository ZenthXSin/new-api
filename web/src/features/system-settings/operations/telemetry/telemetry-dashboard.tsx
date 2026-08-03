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
import { Activity, CircleGauge, Clock3, Sigma } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useTheme } from '@/context/theme-provider'
import { VCHART_OPTION } from '@/lib/vchart'

import type { TelemetryTimeSeriesRow } from './api'
import { buildTelemetryDashboardData } from './telemetry-dashboard-data'

type TelemetryDashboardProps = {
  data: TelemetryTimeSeriesRow[]
  hours: number
  loading: boolean
}

const statusColors: Record<string, string> = {
  success: '#22c55e',
  failure: '#ef4444',
  unknown: '#f59e0b',
}

const eventColors = ['#3b82f6', '#14b8a6', '#f59e0b', '#ef4444']

function formatMetric(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    value
  )
}

export function TelemetryDashboard({
  data,
  hours,
  loading,
}: TelemetryDashboardProps) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const [themeReady, setThemeReady] = useState(false)
  const dashboard = useMemo(
    () => buildTelemetryDashboardData(data, hours),
    [data, hours]
  )

  useEffect(() => {
    let active = true
    setThemeReady(false)
    void import('@visactor/vchart').then(({ ThemeManager }) => {
      if (!active) return
      ThemeManager.setCurrentTheme(resolvedTheme === 'dark' ? 'dark' : 'light')
      setThemeReady(true)
    })
    return () => {
      active = false
    }
  }, [resolvedTheme])

  const empty = !loading && data.length === 0
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const chartBase = { theme, background: 'transparent' }
  const statusLabel = (status: string) => {
    if (status === 'success') return t('Success')
    if (status === 'failure') return t('Failure')
    return t('Unknown')
  }
  const kpis = [
    {
      label: t('Total events'),
      value: formatMetric(dashboard.totalEvents),
      icon: Activity,
      color: 'text-blue-500',
    },
    {
      label: t('Success rate'),
      value: `${dashboard.successRate.toFixed(1)}%`,
      icon: CircleGauge,
      color: 'text-emerald-500',
    },
    {
      label: t('Average duration'),
      value: `${formatMetric(dashboard.averageDurationMs)} ms`,
      icon: Clock3,
      color: 'text-amber-500',
    },
    {
      label: t('Total value'),
      value: formatMetric(dashboard.totalValue),
      icon: Sigma,
      color: 'text-rose-500',
    },
  ]

  if (empty) {
    return (
      <div className='text-muted-foreground flex min-h-52 items-center justify-center border-y py-12 text-sm'>
        {t('No telemetry chart data is available.')}
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
        {kpis.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className='min-w-0 rounded-lg border p-3'>
            <div className='text-muted-foreground flex items-center gap-2 text-xs'>
              <Icon className={`size-4 shrink-0 ${color}`} />
              <span className='truncate'>{label}</span>
            </div>
            <div className='mt-2 truncate text-xl font-semibold tabular-nums'>
              {loading ? '--' : value}
            </div>
          </div>
        ))}
      </div>

      <div className='border-y py-4'>
        <h4 className='mb-3 text-sm font-medium'>{t('Event trend')}</h4>
        <div className='h-72'>
          {themeReady && !loading && (
            <VChart
              key={`trend-${theme}`}
              option={VCHART_OPTION}
              spec={{
                ...chartBase,
                type: 'line',
                data: [
                  {
                    id: 'trend',
                    values: dashboard.trendData.map((item) => ({
                      ...item,
                      statusLabel: statusLabel(item.status),
                    })),
                  },
                ],
                xField: 'time',
                yField: 'value',
                seriesField: 'statusLabel',
                point: {
                  visible: dashboard.trendData.length < 80,
                  style: { size: 7, lineWidth: 2 },
                },
                line: { style: { lineWidth: 2 } },
                legends: { visible: true, orient: 'top' },
                axes: [
                  { orient: 'bottom', type: 'time', label: { formatMethod: (value: string) => new Date(Number(value)).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit' }) } },
                  { orient: 'left', min: 0 },
                ],
                color: dashboard.statusData.map(
                  (item) => statusColors[item.category] ?? '#64748b'
                ),
                tooltip: { visible: true },
              }}
            />
          )}
        </div>
      </div>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <div className='min-w-0 border-b pb-4 lg:border-b-0 lg:border-r lg:pr-4'>
          <h4 className='mb-3 text-sm font-medium'>
            {t('Status distribution')}
          </h4>
          <div className='h-64'>
            {themeReady && !loading && (
              <VChart
                key={`status-${theme}`}
                option={VCHART_OPTION}
                spec={{
                  ...chartBase,
                  type: 'pie',
                  data: [{ id: 'status', values: dashboard.statusData.map((item) => ({ ...item, category: statusLabel(item.category) })) }],
                  valueField: 'value',
                  categoryField: 'category',
                  outerRadius: 0.78,
                  innerRadius: 0.48,
                  legends: { visible: true, orient: 'bottom' },
                  color: dashboard.statusData.map(
                    (item) => statusColors[item.category] ?? '#64748b'
                  ),
                  tooltip: { visible: true },
                }}
              />
            )}
          </div>
        </div>
        <div className='min-w-0'>
          <h4 className='mb-3 text-sm font-medium'>
            {t('Event type distribution')}
          </h4>
          <div className='h-64'>
            {themeReady && !loading && (
              <VChart
                key={`event-types-${theme}`}
                option={VCHART_OPTION}
                spec={{
                  ...chartBase,
                  type: 'bar',
                  direction: 'horizontal',
                  data: [{ id: 'events', values: dashboard.eventTypeData }],
                  xField: 'value',
                  yField: 'category',
                  color: eventColors,
                  axes: [
                    { orient: 'bottom', min: 0 },
                    { orient: 'left', label: { autoLimit: true } },
                  ],
                  tooltip: { visible: true },
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
