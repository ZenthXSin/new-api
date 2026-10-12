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
import { HeartPulse, Info, RefreshCw, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import dayjs from '@/lib/dayjs'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

import { getGroupAvailability, type AvailabilityRange } from './api'
import { AvailabilityStatusBadge } from './components/availability-status'
import { GroupAvailabilityCard } from './components/group-availability-card'

const RANGES = [
  { value: '90m', label: '90 minutes' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
] as const

export function GroupAvailability() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const [range, setRange] = useState<AvailabilityRange>('24h')
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [autoSort, setAutoSort] = useState(true)
  const query = useQuery({
    queryKey: [
      'group-availability',
      user?.id,
      user?.role,
      user?.group,
      range,
      autoSort,
    ],
    queryFn: ({ signal }) =>
      getGroupAvailability(range, signal, autoSort ? 'auto' : 'name'),
    enabled: Boolean(user),
    staleTime: 15_000,
    gcTime: 0,
    refetchInterval: autoRefresh
      ? (result) =>
          Math.max(15, result.state.data?.refresh_interval_seconds ?? 15) * 1000
      : false,
    refetchIntervalInBackground: false,
    retry: false,
    meta: { errorToast: false },
  })
  const data = query.data
  const searchTerm = search.trim().toLocaleLowerCase()
  const groups =
    data?.groups.filter((group) =>
      (group.display_name || group.group)
        .toLocaleLowerCase()
        .includes(searchTerm)
    ) ?? []

  return (
    <SectionPageLayout stackActionsOnMobile>
      <SectionPageLayout.Title>
        <span className='inline-flex items-center gap-2'>
          <HeartPulse className='size-5' />
          {t('Group Availability')}
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <ToggleGroup
          value={[range]}
          onValueChange={(values) => {
            const next = RANGES.find((option) => option.value === values[0])
            if (next) setRange(next.value)
          }}
          variant='outline'
          size='sm'
          aria-label={t('Observation period')}
        >
          {RANGES.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {t(option.label)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button
          variant='outline'
          size='sm'
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            className={cn('size-4', query.isFetching && 'animate-spin')}
          />
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='flex min-w-0 flex-col gap-5'>
          <p className='text-muted-foreground text-sm'>
            {t(
              'One summary per accessible group, based only on requests with more than 10,000 input tokens, including cached input. No qualifying traffic is shown as unknown.'
            )}
          </p>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='relative w-full sm:max-w-xs'>
              <Search className='text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4' />
              <Input
                className='pl-9'
                aria-label={t('Search groups')}
                placeholder={t('Search groups')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className='text-muted-foreground flex flex-wrap items-center gap-3 text-xs'>
              {data && !query.isError && (
                <span>
                  {t('Updated at {{time}}', {
                    time: dayjs.unix(data.generated_at).format('HH:mm:ss'),
                  })}
                </span>
              )}
              <div className='flex items-center gap-2'>
                <Switch
                  id='availability-auto-sort'
                  checked={autoSort}
                  onCheckedChange={setAutoSort}
                  size='sm'
                />
                <Label
                  htmlFor='availability-auto-sort'
                  className='text-xs'
                  title={t('Requests first, then success rate (highest first)')}
                >
                  {t('Auto sort')}
                </Label>
              </div>
              <div className='flex items-center gap-2'>
                <Switch
                  id='availability-auto-refresh'
                  checked={autoRefresh}
                  onCheckedChange={setAutoRefresh}
                  size='sm'
                />
                <Label htmlFor='availability-auto-refresh' className='text-xs'>
                  {t('Refresh every {{seconds}} seconds', {
                    seconds: data?.refresh_interval_seconds ?? 15,
                  })}
                </Label>
              </div>
            </div>
          </div>
          {query.isPending && <LoadingState />}
          {query.isError && (
            <ErrorState
              title={t('Unable to load group availability')}
              description={t('Please refresh to try again.')}
              onRetry={() => void query.refetch()}
            />
          )}
          {!query.isPending && !query.isError && data && (
            <>
              {!data.coverage_complete && (
                <Alert>
                  <Info />
                  <AlertTitle>{t('History is still accumulating')}</AlertTitle>
                  <AlertDescription>
                    {t(
                      'Collection started at {{time}}. Earlier periods have no samples.',
                      {
                        time: dayjs
                          .unix(data.collection_started_at)
                          .format('YYYY-MM-DD HH:mm:ss'),
                      }
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <div
                className='flex flex-wrap items-center gap-x-4 gap-y-2 text-xs'
                aria-label={t('Availability legend')}
              >
                <AvailabilityStatusBadge status='healthy' />
                <AvailabilityStatusBadge status='warning' />
                <AvailabilityStatusBadge status='critical' />
                <AvailabilityStatusBadge
                  status='unknown'
                  sampleState='insufficient'
                />
                <AvailabilityStatusBadge status='unknown' sampleState='none' />
              </div>
              {groups.length === 0 ? (
                <EmptyState
                  icon={HeartPulse}
                  title={
                    searchTerm
                      ? t('No matching groups')
                      : t('No accessible groups')
                  }
                  description={
                    searchTerm
                      ? t('Try another group name.')
                      : t('Groups you can use will appear here.')
                  }
                />
              ) : (
                <div className='grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3'>
                  {groups.map((group) => (
                    <GroupAvailabilityCard
                      key={group.group}
                      group={group}
                      data={data}
                    />
                  ))}
                </div>
              )}
              <p className='text-muted-foreground text-xs leading-relaxed'>
                {t(
                  'Health needs at least {{count}} samples. Failure rates of {{warning}}% and {{critical}}% indicate degraded and critical health. Timings are descriptive; this is not an active probe or an uptime guarantee.',
                  {
                    count: data.min_samples,
                    warning: data.warning_error_rate,
                    critical: data.critical_error_rate,
                  }
                )}
              </p>
            </>
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
