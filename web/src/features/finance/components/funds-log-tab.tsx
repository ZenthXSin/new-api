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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DataTablePage,
  TruncatedCell,
  useDataTable,
} from '@/components/data-table'
import { DatePicker } from '@/components/date-picker'
import { StatusBadge, type StatusVariant } from '@/components/status-badge'
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
  getFinanceFundsLog,
  type FundsLogItem,
  type FundsLogType,
} from '../api'
import {
  formatQuotaDelta,
  formatTimestamp,
  fundsLogTypeLabel,
} from '../lib/format'

const ALL_TYPES = 'all'

const FUNDS_LOG_TYPES: FundsLogType[] = ['topup', 'consume', 'refund']

const FUNDS_LOG_TYPE_BADGE_VARIANTS: Record<string, StatusVariant> = {
  topup: 'success',
  consume: 'warning',
  refund: 'danger',
}

function toSeconds(date: Date | undefined): number | undefined {
  return date ? Math.floor(date.getTime() / 1000) : undefined
}

function quotaDeltaClassName(value: number): string | undefined {
  if (value < 0) return 'text-destructive'
  if (value > 0) return 'text-success'
  return undefined
}

export function FundsLogTab() {
  const { t } = useTranslation()
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const [type, setType] = useState<string>(ALL_TYPES)
  const [username, setUsername] = useState('')
  const [startDate, setStartDate] = useState<Date | undefined>(undefined)
  const [endDate, setEndDate] = useState<Date | undefined>(undefined)
  const debouncedUsername = useDebounce(username, 400)

  const start = toSeconds(startDate)
  const end = toSeconds(endDate)

  const resetPage = () =>
    setPagination((current) => ({ ...current, pageIndex: 0 }))

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      'finance-funds-log',
      pagination.pageIndex,
      pagination.pageSize,
      type,
      debouncedUsername,
      start,
      end,
    ],
    queryFn: () =>
      getFinanceFundsLog({
        page: pagination.pageIndex + 1,
        size: pagination.pageSize,
        type: type === ALL_TYPES ? undefined : (type as FundsLogType),
        username: debouncedUsername.trim() || undefined,
        start,
        end,
      }),
    placeholderData: (previous) => previous,
  })

  const columns = useMemo<ColumnDef<FundsLogItem>[]>(
    () => [
      {
        accessorKey: 'time',
        header: t('Time'),
        cell: ({ row }) => formatTimestamp(row.original.time),
        meta: { mobileTitle: true },
      },
      {
        accessorKey: 'username',
        header: t('Username'),
        cell: ({ row }) => row.original.username || '-',
        meta: { mobileHidden: true },
      },
      {
        accessorKey: 'type',
        header: t('Type'),
        cell: ({ row }) => (
          <StatusBadge
            label={t(fundsLogTypeLabel(row.original.type))}
            variant={
              FUNDS_LOG_TYPE_BADGE_VARIANTS[row.original.type] ?? 'neutral'
            }
            copyable={false}
          />
        ),
        meta: { mobileBadge: true },
      },
      {
        accessorKey: 'quota_delta',
        header: t('Quota Delta'),
        cell: ({ row }) => {
          const delta = row.original.quota_delta
          return (
            <span className={quotaDeltaClassName(delta)}>
              {formatQuotaDelta(delta)}
            </span>
          )
        },
      },
      {
        accessorKey: 'description',
        header: t('Description'),
        cell: ({ row }) => (
          <TruncatedCell>{row.original.description || '-'}</TruncatedCell>
        ),
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

  const selectItems = useMemo(
    () =>
      FUNDS_LOG_TYPES.map((logType) => ({
        value: String(logType),
        label: t(fundsLogTypeLabel(logType)),
      })),
    [t]
  )

  return (
    <DataTablePage
      table={table}
      columns={columns}
      isLoading={isLoading}
      isFetching={isFetching}
      emptyTitle={t('No funds log found')}
      skeletonKeyPrefix='finance-funds-log-skeleton'
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
                {type === ALL_TYPES
                  ? t('All Types')
                  : t(fundsLogTypeLabel(type))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                <SelectItem value={ALL_TYPES}>{t('All Types')}</SelectItem>
                {FUNDS_LOG_TYPES.map((logType) => (
                  <SelectItem key={logType} value={String(logType)}>
                    {t(fundsLogTypeLabel(logType))}
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
        </div>
      }
    />
  )
}
