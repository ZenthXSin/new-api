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
import { UserPlus } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useChartTheme } from '@/lib/use-chart-theme'
import { VCHART_OPTION } from '@/lib/vchart'

import type { UserTrendPoint } from '../api'

const NEW_USERS_COLOR = '#0f766e'
const PAID_USERS_COLOR = '#d97706'

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

export function UserGrowthChart({
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
  const points = data ?? []

  const flat = useMemo(
    () =>
      points.flatMap((point) => [
        { date: point.date, series: 'new', value: point.new_users },
        { date: point.date, series: 'paid', value: point.paid_users },
      ]),
    [points]
  )

  const spec = useMemo(() => {
    if (flat.length === 0) return null
    return {
      type: 'line' as const,
      data: [{ id: 'user-growth', values: flat }],
      xField: 'date',
      yField: 'value',
      seriesField: 'series',
      color: [NEW_USERS_COLOR, PAID_USERS_COLOR],
      line: { style: { lineWidth: 2 } },
      point: { visible: points.length <= 30, style: { size: 3 } },
      legends: { visible: true, orient: 'bottom', maxRow: 1 },
      tooltip: {
        dimension: {
          content: [
            { key: t('New Users'), value: 'value' },
            { key: t('Paid Users'), value: 'value' },
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
  }, [flat, points.length, t, tokens])

  return (
    <section className='border-border bg-card rounded-lg border p-4'>
      <header className='flex items-center gap-2 pb-3'>
        <span className='text-primary'>
          <UserPlus className='size-4' aria-hidden='true' />
        </span>
        <h3 className='text-sm font-semibold'>{t('User Growth')}</h3>
      </header>
      {loading ? (
        <div className='text-muted-foreground flex h-40 items-center justify-center text-sm'>
          {t('Loading')}
        </div>
      ) : error ? (
        <div className='text-destructive flex h-40 items-center justify-center text-sm'>
          {t('Failed to load finance overview')}
        </div>
      ) : points.length === 0 ? (
        <div className='text-muted-foreground flex h-40 items-center justify-center text-sm'>
          {t('No Data')}
        </div>
      ) : (
        <div className='h-64 sm:h-72'>
          {themeReady && spec && (
            <VChart
              key={`user-growth-${resolvedTheme}`}
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
    </section>
  )
}
