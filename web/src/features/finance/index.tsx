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
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import {
  getFinanceOverview,
  getFinanceTrends,
  type FinanceOverview,
  type FinanceTrends,
} from './api'
import { PaidMoneyTrendChart } from './components/paid-money-trend-chart'
import { ProfitSummaryCards } from './components/profit-summary-cards'
import { RevenueTrendChart } from './components/revenue-trend-chart'
import { UserGrowthChart } from './components/user-growth-chart'

const DAY = 86400

const RANGE_OPTIONS = [
  { days: 7, labelKey: 'Last 7 Days' },
  { days: 30, labelKey: 'Last 30 Days' },
  { days: 90, labelKey: 'Last 90 Days' },
] as const

function timeRange(days: number): { start: number; end: number } {
  const end = Math.floor(Date.now() / 1000)
  return { start: end - days * DAY, end }
}

export function Finance() {
  const { t } = useTranslation()
  const [days, setDays] = useState<number>(30)
  const { start, end } = useMemo(() => timeRange(days), [days])

  const overviewQuery = useQuery({
    queryKey: ['finance-overview', start, end],
    queryFn: () => getFinanceOverview(start, end),
  })
  const trendsQuery = useQuery({
    queryKey: ['finance-trends', start, end],
    queryFn: () => getFinanceTrends(start, end),
  })

  const overview: FinanceOverview | undefined = overviewQuery.data
  const trends: FinanceTrends | undefined = trendsQuery.data
  const loading = overviewQuery.isLoading || trendsQuery.isLoading
  const error = overviewQuery.isError || trendsQuery.isError

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Finance Overview')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <ToggleGroup
          value={[
            RANGE_OPTIONS.find((item) => item.days === days)?.labelKey ??
              'Last 30 Days',
          ]}
          onValueChange={(value) => {
            const selected = value.at(-1)
            const option = RANGE_OPTIONS.find(
              (item) => item.labelKey === selected
            )
            if (option) setDays(option.days)
          }}
          aria-label={t('Finance Overview')}
          variant='outline'
          size='sm'
        >
          {RANGE_OPTIONS.map((option) => (
            <ToggleGroupItem key={option.days} value={option.labelKey}>
              {t(option.labelKey)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <ProfitSummaryCards
          overview={overview}
          loading={loading}
          error={error}
        />
        <RevenueTrendChart
          data={trends?.cost}
          loading={loading}
          error={error}
        />
        <UserGrowthChart data={trends?.users} loading={loading} error={error} />
        <PaidMoneyTrendChart
          data={trends?.users}
          loading={loading}
          error={error}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
