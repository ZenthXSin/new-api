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
import {
  BadgeDollarSign,
  Banknote,
  Coins,
  PieChart,
  ReceiptText,
  Users,
  Wallet,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { formatLogQuota, formatNumber } from '@/lib/format'

import type { FinanceOverview } from '../api'

function percent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0%'
  return `${(value * 100).toFixed(1)}%`
}

function money(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '¥0'
  return `¥${formatNumber(value)}`
}

function OverviewCard({
  icon,
  title,
  value,
  hint,
}: {
  icon: React.ReactNode
  title: string
  value: string
  hint: string
}) {
  return (
    <div className='border-border bg-card rounded-lg border p-4'>
      <div className='text-muted-foreground flex items-center gap-2'>
        {icon}
        <span className='text-sm'>{title}</span>
      </div>
      <div className='text-foreground mt-2 text-xl font-semibold'>{value}</div>
      <div className='text-muted-foreground mt-1 text-xs'>{hint}</div>
    </div>
  )
}

export function ProfitSummaryCards({
  overview,
  loading,
  error,
}: {
  overview: FinanceOverview | undefined
  loading: boolean
  error: boolean
}) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className='text-muted-foreground py-8 text-center text-sm'>
        {t('Loading')}
      </div>
    )
  }
  if (error || !overview) {
    return (
      <div className='text-destructive py-8 text-center text-sm'>
        {t('Failed to load finance overview')}
      </div>
    )
  }

  return (
    <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
      <OverviewCard
        icon={<BadgeDollarSign className='size-4' aria-hidden='true' />}
        title={t('Revenue')}
        value={formatLogQuota(overview.revenue_quota)}
        hint={t('Quota consumed by users')}
      />
      <OverviewCard
        icon={<Coins className='size-4' aria-hidden='true' />}
        title={t('Cost')}
        value={formatLogQuota(overview.cost_quota)}
        hint={t('Upstream provider cost')}
      />
      <OverviewCard
        icon={<PieChart className='size-4' aria-hidden='true' />}
        title={t('Gross Profit')}
        value={formatLogQuota(overview.gross_profit_quota)}
        hint={`${t('Margin')} ${percent(overview.margin)}`}
      />
      <OverviewCard
        icon={<ReceiptText className='size-4' aria-hidden='true' />}
        title={t('Requests')}
        value={String(overview.request_count)}
        hint={`${t('Cost Coverage')} ${percent(overview.cost_coverage)}`}
      />
      <OverviewCard
        icon={<Users className='size-4' aria-hidden='true' />}
        title={t('Paid Users Period')}
        value={String(overview.paid_users_period)}
        hint={t('Users who paid in this window')}
      />
      <OverviewCard
        icon={<Wallet className='size-4' aria-hidden='true' />}
        title={t('Paid Users Total')}
        value={String(overview.paid_users_total)}
        hint={t('All users who ever paid')}
      />
      <OverviewCard
        icon={<Banknote className='size-4' aria-hidden='true' />}
        title={t('Paid Money Period')}
        value={money(overview.paid_money_period)}
        hint={t('Successful topups in this window')}
      />
      <OverviewCard
        icon={<Banknote className='size-4' aria-hidden='true' />}
        title={t('Paid Money Total')}
        value={money(overview.paid_money_total)}
        hint={t('All successful topups')}
      />
    </div>
  )
}
