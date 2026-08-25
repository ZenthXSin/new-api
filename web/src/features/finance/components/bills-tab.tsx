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
import type { ColumnDef } from '@tanstack/react-table'
import { Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { DataTablePage, TruncatedCell, useDataTable } from '@/components/data-table'
import { DatePicker } from '@/components/date-picker'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDebounce } from '@/hooks/use-debounce'

import {
  exportFinanceBills,
  getFinanceBills,
  type FinanceBillItem,
  type FinanceBillType,
} from '../api'
import { billTypeLabel, formatSignedMoney, formatTimestamp } from '../lib/format'

const ALL_TYPES = 'all'

const BILL_TYPES: FinanceBillType[] = [
  'topup',
  'refund',
  'subscription',
  'affiliate',
  'income',
  'expense',
]

const BILL_TYPE_BADGE_VARIANTS: Record<string, StatusVariant> = {
  topup: 'success',
  refund: 'danger',
  subscription: 'info',
  affiliate: 'purple',
  income: 'success',
  expense: 'danger',
}

function toSeconds(date: Date | undefined): number | undefined {
  return date ? Math.floor(date.getTime() / 1000) : undefined
}

function amountClassName(value: number): string | undefined {
  if (value < 0) return 'text-destructive'
  if (value > 0) return 'text-success'
  return undefined
}

export function BillsTab() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const [type, setType] = useState<string>(ALL_TYPES)
  const [username, setUsername] = useState('')
  const [startDate, setStartDate] = useState<Date | undefined>(undefined)
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const [isExporting, setIsExporting] = useState(false)
  const debouncedUsername = useDebounce(username, 400)

  const start = toSeconds(startDate)
  const end = toSeconds(endDate)

  const resetPage = () =>
    setPagination((current) => ({ ...current, pageIndex: 0 }))

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      'finance-bills',
      pagination.pageIndex,
      pagination.pageSize,
      type,
      debouncedUsername,
      start,
      end,
    ],
    queryFn: () =>
      getFinanceBills({
        page: pagination.pageIndex + 1,
        size: pagination.pageSize,
        type: type === ALL_TYPES ? undefined : (type as FinanceBillType),
        username: debouncedUsername.trim() || undefined,
        start,
        end,
      }),
    placeholderData: (previous) => previous,
  })

  const columns = useMemo<ColumnDef<FinanceBillItem>[]>(
    () => [
      {
        accessorKey: 'time',
        header: t('Time'),
        cell: ({ row }) => formatTimestamp(row.original.time),
        meta: { mobileTitle: true },
      },
      {
        accessorKey: 'type',
        header: t('Type'),
        cell: ({ row }) => (
          <StatusBadge
            label={t(billTypeLabel(row.original.type))}
            variant={
              BILL_TYPE_BADGE_VARIANTS[row.original.type] ?? 'neutral'
            }
            copyable={false}
          />
        ),
        meta: { mobileBadge: true },
      },
      {
        accessorKey: 'username',
        header: t('Username'),
        cell: ({ row }) => row.original.username || '-',
        meta: { mobileHidden: true },
      },
      {
        accessorKey: 'amount_money',
        header: t('Amount'),
        cell: ({ row }) => {
          const amount = row.original.amount_money
          return (
            <span className={amountClassName(amount)}>
              {formatSignedMoney(amount)}
            </span>
          )
        },
      },
      {
        accessorKey: 'note',
        header: t('Note'),
        cell: ({ row }) => <TruncatedCell>{row.original.note || '-'}</TruncatedCell>,
      },
      {
        accessorKey: 'source',
        header: t('Source'),
        cell: ({ row }) => row.original.source || '-',
        meta: { mobileHidden: true },
      },
    ],
    [t]
  )

  const { table } = useDataTable({
    data: data?.items ?? [],
    columns,
    pagination,
    onPaginationChange: setPagination,
    manualPagination: true,
    totalCount: data?.total ?? 0,
  })

  const handleExport = async () => {
    setIsExporting(true)
    try {
      await exportFinanceBills({
        type: type === ALL_TYPES ? undefined : (type as FinanceBillType),
        username: username.trim() || undefined,
        start,
        end,
      })
      toast.success(t('Operation successful'))
    } finally {
      setIsExporting(false)
    }
  }

  const selectItems = useMemo(
    () =>
      BILL_TYPES.map((billType) => ({
        value: billType,
        label: t(billTypeLabel(billType)),
      })),
    [t]
  )

  return (
    <DataTablePage
      table={table}
      columns={columns}
      isLoading={isLoading}
      isFetching={isFetching}
      emptyTitle={t('No bills found')}
      skeletonKeyPrefix='finance-bills-skeleton'
      paginationInFooter={false}
      toolbar={
        <div className='flex flex-wrap items-center gap-2'>
          <Select
            items={selectItems}
            value={type}
            onValueChange={(value: string | null) => {
              setType(value ?? ALL_TYPES)
              resetPage()
            }}
          >
            <SelectTrigger size='sm' className='w-36'>
              <SelectValue>
                {type === ALL_TYPES ? t('All Types') : t(billTypeLabel(type))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value={ALL_TYPES}>{t('All Types')}</SelectItem>
                {BILL_TYPES.map((billType) => (
                  <SelectItem key={billType} value={billType}>
                    {t(billTypeLabel(billType))}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            value={username}
            onChange={(event) => {
              setUsername(event.target.value)
              resetPage()
            }}
            placeholder={t('Username')}
            className='h-7 w-40 text-sm'
          />
          <DatePicker
            selected={startDate}
            onSelect={(date) => {
              setStartDate(date)
              resetPage()
            }}
            placeholder={t('Start Time')}
          />
          <DatePicker
            selected={endDate}
            onSelect={(date) => {
              setEndDate(date)
              resetPage()
            }}
            placeholder={t('End Time')}
          />
          <Button
            variant='outline'
            size='sm'
            onClick={handleExport}
            disabled={isExporting}
          >
            <Download className='size-4' aria-hidden='true' />
            {t('Export CSV')}
          </Button>
        </div>
      }
    />
  )
}