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
import type { ColumnDef } from '@tanstack/react-table'
import { VChart } from '@visactor/react-vchart'
import { Download } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTablePagination,
  DataTableView,
  useDataTable,
} from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import { useChartTheme } from '@/lib/use-chart-theme'
import { VCHART_OPTION } from '@/lib/vchart'

import { formatMoney } from '../lib/format'
import {
  simulationToCsv,
  type SimulationData,
  type SimulationDay,
} from '../lib/profit-simulation'

interface ProfitSimulationResultsProps {
  data: SimulationData
  startDate: string
}

export function ProfitSimulationResults(props: ProfitSimulationResultsProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const { resolvedTheme, themeReady } = useChartTheme()
  const summary = props.data.summary
  const columns = useMemo<ColumnDef<SimulationDay>[]>(
    () => [
      { accessorKey: 'date', header: t('Date') },
      {
        accessorKey: 'revenue',
        header: t('Simulated Revenue'),
        cell: ({ row }) => `$${formatMoney(row.original.revenue, locale)}`,
      },
      {
        accessorKey: 'cost',
        header: t('Simulated Cost'),
        cell: ({ row }) => `$${formatMoney(row.original.cost, locale)}`,
      },
      {
        accessorKey: 'profit',
        header: t('Simulated Profit'),
        cell: ({ row }) => (
          <span
            className={
              row.original.profit < 0 ? 'text-destructive' : 'text-success'
            }
          >{`$${formatMoney(row.original.profit, locale)}`}</span>
        ),
      },
      {
        accessorKey: 'margin',
        header: t('Profit Margin (%)'),
        cell: ({ row }) => `${formatMoney(row.original.margin, locale)}%`,
      },
      {
        accessorKey: 'cumulativeProfit',
        header: t('Cumulative Profit'),
        cell: ({ row }) =>
          `$${formatMoney(row.original.cumulativeProfit, locale)}`,
      },
    ],
    [locale, t]
  )
  const { table } = useDataTable({
    data: props.data.days,
    columns,
    initialPagination: { pageIndex: 0, pageSize: 20 },
    withPaginationRowModel: true,
    getRowId: (row) => row.date,
  })
  const metrics = [
    {
      label: t('Simulated Revenue'),
      value: `$${formatMoney(summary.totalRevenue, locale)}`,
    },
    {
      label: t('Simulated Cost'),
      value: `$${formatMoney(summary.totalCost, locale)}`,
    },
    {
      label: t('Simulated Profit'),
      value: `$${formatMoney(summary.totalProfit, locale)}`,
    },
    {
      label: t('Average Profit Margin'),
      value: `${formatMoney(summary.averageMargin, locale)}%`,
    },
    {
      label: t('Daily Average Profit'),
      value: `$${formatMoney(summary.averageDailyProfit, locale)}`,
    },
    {
      label: t('Best Day'),
      value: `$${formatMoney(summary.maxDailyProfit, locale)}`,
    },
    {
      label: t('Worst Day'),
      value: `$${formatMoney(summary.minDailyProfit, locale)}`,
    },
    {
      label: t('Profitable Days'),
      value: `${formatNumber(summary.profitableDays, locale)} / ${formatNumber(props.data.days.length, locale)}`,
    },
  ]
  const spec = useMemo(
    () => ({
      type: 'line' as const,
      data: [
        {
          id: 'profit-simulation',
          values: props.data.days.flatMap((day) => [
            {
              date: day.date,
              series: t('Simulated Revenue'),
              value: day.revenue,
            },
            { date: day.date, series: t('Simulated Cost'), value: day.cost },
            {
              date: day.date,
              series: t('Simulated Profit'),
              value: day.profit,
            },
          ]),
        },
      ],
      xField: 'date',
      yField: 'value',
      seriesField: 'series',
      color: ['#0f766e', '#d97706', '#2563eb'],
      line: { style: { lineWidth: 2 } },
      point: { visible: props.data.days.length <= 31, style: { size: 4 } },
      legends: { visible: true, orient: 'bottom', maxRow: 2 },
      axes: [
        {
          orient: 'bottom',
          label: { style: { fontSize: 10 } },
          tick: { visible: false },
        },
        {
          orient: 'left',
          label: {
            formatMethod: (value: number | string) =>
              `$${formatNumber(Number(value), locale)}`,
            style: { fontSize: 10 },
          },
          grid: { visible: true },
        },
      ],
      tooltip: {
        dimension: {
          content: [
            {
              key: (datum: { series: string }) => datum.series,
              value: (datum: { value: number }) =>
                `$${formatMoney(datum.value, locale)}`,
            },
          ],
        },
      },
      theme: resolvedTheme === 'dark' ? 'dark' : 'light',
      background: 'transparent',
      animation: false,
    }),
    [locale, props.data.days, resolvedTheme, t]
  )

  const exportCsv = () => {
    try {
      const blob = new Blob([simulationToCsv(props.data)], {
        type: 'text/csv;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `profit-simulation-${props.startDate}.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      handleServerError(error)
    }
  }

  return (
    <div className='space-y-4' aria-label={t('Simulation Results')}>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <p role='status' className='font-medium'>
            {t('Simulation generated for {{days}} days.', {
              days: props.data.days.length,
            })}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t('Simulation period: {{start}} to {{end}}', {
              start: props.startDate,
              end: props.data.days.at(-1)?.date,
            })}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t('All amounts are in USD.')}
          </p>
        </div>
        <Button type='button' variant='outline' onClick={exportCsv}>
          <Download className='size-4' />
          {t('Export Simulation CSV')}
        </Button>
      </div>
      <dl className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
        {metrics.map((metric) => (
          <Card key={metric.label} size='sm'>
            <CardContent>
              <dt className='text-muted-foreground text-xs'>{metric.label}</dt>
              <dd className='mt-2 text-lg font-semibold tabular-nums'>
                {metric.value}
              </dd>
            </CardContent>
          </Card>
        ))}
      </dl>
      <Card>
        <CardHeader>
          <CardTitle>{t('Simulation Trend')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className='h-72 w-full sm:h-80'>
            {themeReady && (
              <VChart key={resolvedTheme} spec={spec} option={VCHART_OPTION} />
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('Daily Simulation Details')}</CardTitle>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Daily profit margins are assumptions; rounded amounts can differ slightly. The average margin uses total profit divided by total revenue.'
            )}
          </p>
        </CardHeader>
        <CardContent className='space-y-3'>
          <DataTableView
            table={table}
            tableContainerClassName='overflow-x-auto'
            tableClassName='min-w-[680px]'
            containerProps={{
              role: 'region',
              'aria-label': t('Daily Simulation Details'),
            }}
          />
          <DataTablePagination table={table} />
        </CardContent>
      </Card>
    </div>
  )
}
