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
import { Banknote } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { formatNumber } from '@/lib/format'
import { useChartTheme } from '@/lib/use-chart-theme'
import { VCHART_OPTION } from '@/lib/vchart'

import type { UserTrendPoint } from '../api'

const PAID_MONEY_COLOR = '#d97706'

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

export function PaidMoneyTrendChart({
  data,
  loading,
  error,
}: {
  data: UserTrendPoint[] | undefined
  loading: boolean
  error: boolean
}) {
  const { t } = useTranslation()
  const { resolvedTheme, themeReady } = useChartTheme()
  const tokens = useMemo(() => chartTokens(resolvedTheme), [resolvedTheme])
  const points = useMemo(
    () =>
      (data ?? []).map((point) => ({
        date: point.date,
        value: point.paid_money,
      })),
    [data]
  )

  const spec = useMemo(() => {
    if (points.length === 0) return null
    return {
      type: 'line' as const,
      data: [{ id: 'paid-money-trend', values: points }],
      xField: 'date',
      yField: 'value',
      line: { style: { stroke: PAID_MONEY_COLOR, lineWidth: 2.5 } },
      point: { visible: points.length <= 30, style: { size: 3 } },
      tooltip: {
        mark: {
          title: {
            value: (datum: { date: string }) => datum.date,
          },
          content: [
            {
              key: t('Paid Money Trend'),
              value: (datum: { value: number }) =>
                `¥${formatNumber(datum.value)}`,
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
          label: {
            formatMethod: (value: number | string) =>
              `¥${formatNumber(Number(value))}`,
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
  }, [points, t, tokens])

  let body: React.ReactNode
  if (loading) {
    body = (
      <div className='text-muted-foreground flex h-40 items-center justify-center text-sm'>
        {t('Loading')}
      </div>
    )
  } else if (error) {
    body = (
      <div className='text-destructive flex h-40 items-center justify-center text-sm'>
        {t('Failed to load finance overview')}
      </div>
    )
  } else if (points.length === 0) {
    body = (
      <div className='text-muted-foreground flex h-40 items-center justify-center text-sm'>
        {t('No Data')}
      </div>
    )
  } else {
    body = (
      <div className='h-64 sm:h-72'>
        {themeReady && spec && (
          <VChart
            key={`paid-money-trend-${resolvedTheme}`}
            spec={{
              ...spec,
              theme: resolvedTheme === 'dark' ? 'dark' : 'light',
              background: 'transparent',
            }}
            option={VCHART_OPTION}
          />
        )}
      </div>
    )
  }

  return (
    <section className='border-border bg-card rounded-lg border p-4'>
      <header className='flex items-center gap-2 pb-3'>
        <span className='text-primary'>
          <Banknote className='size-4' aria-hidden='true' />
        </span>
        <h3 className='text-sm font-semibold'>{t('Paid Money Trend')}</h3>
      </header>
      {body}
    </section>
  )
}
