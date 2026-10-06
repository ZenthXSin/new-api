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
import { CircleHelp, Clock3, Database, Layers3, Zap } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { IconBadge } from '@/components/ui/icon-badge'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  formatLatency,
  formatUptimePct,
} from '@/features/performance-metrics/lib/format'
import { toIntlLocale } from '@/i18n/languages'
import dayjs from '@/lib/dayjs'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { AvailabilityGroup, GroupAvailabilityData } from '../api'
import { AVAILABILITY_STYLES } from '../lib/availability-styles'
import { AvailabilityStatusBadge } from './availability-status'
import { AvailabilityTimeline } from './availability-timeline'

export function GroupAvailabilityCard({
  group,
  data,
}: {
  group: AvailabilityGroup
  data: GroupAvailabilityData
}) {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const cacheRateId = useId()
  const name = group.display_name || group.group

  return (
    <Card
      className='min-w-0 rounded-2xl'
      role='region'
      aria-labelledby={titleId}
    >
      <CardHeader>
        <CardTitle>
          <div className='flex min-w-0 items-center gap-2.5'>
            <IconBadge tone='primary' size='lg'>
              <Layers3 />
            </IconBadge>
            <h3
              id={titleId}
              className='min-w-0 truncate font-semibold'
              title={name}
            >
              {name}
            </h3>
          </div>
        </CardTitle>
        <CardDescription className='line-clamp-2'>
          {group.description || t('All requests in this group')}
        </CardDescription>
        <CardAction>
          <AvailabilityStatusBadge
            status={group.status}
            sampleState={group.sample_state}
          />
        </CardAction>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <dl className='grid grid-cols-2 gap-3'>
          <div className='bg-muted/40 flex min-w-0 flex-col gap-1.5 rounded-xl p-3'>
            <dt className='text-muted-foreground flex items-center gap-1.5 text-xs'>
              <Zap className='size-3.5 shrink-0' />
              {t('Average first token')}
            </dt>
            <dd className='text-lg font-semibold tabular-nums'>
              {formatLatency(group.avg_ttft_ms ?? Number.NaN)}
            </dd>
          </div>
          <div className='bg-muted/40 flex min-w-0 flex-col gap-1.5 rounded-xl p-3'>
            <dt className='text-muted-foreground flex items-center gap-1.5 text-xs'>
              <Clock3 className='size-3.5 shrink-0' />
              {t('Average request duration')}
            </dt>
            <dd className='text-lg font-semibold tabular-nums'>
              {formatLatency(group.avg_duration_ms ?? Number.NaN)}
            </dd>
          </div>
          <div className='bg-muted/40 col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-xl p-3'>
            <dt>
              <Tooltip>
                <TooltipTrigger
                  id={cacheRateId}
                  className='text-muted-foreground focus-visible:ring-ring flex items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2'
                >
                  <Database className='size-3.5 shrink-0' aria-hidden='true' />
                  {t('Cache hit rate')}
                  <CircleHelp
                    className='size-3.5 shrink-0'
                    aria-hidden='true'
                  />
                </TooltipTrigger>
                <TooltipContent className='max-w-xs'>
                  {t(
                    'Cache-read tokens / total input tokens (including cache creation). Only reported cache usage is included.'
                  )}
                </TooltipContent>
              </Tooltip>
            </dt>
            <dd
              aria-labelledby={cacheRateId}
              className='text-lg font-semibold tabular-nums'
            >
              {formatUptimePct(group.cache_hit_rate ?? Number.NaN)}
            </dd>
          </div>
        </dl>
        <Separator />
        <div className='flex flex-wrap items-end justify-between gap-3'>
          <div className='flex flex-col gap-1'>
            <span className='text-muted-foreground text-xs'>
              {t('Observed success rate')}
            </span>
            {group.request_count !== null && (
              <span className='text-muted-foreground text-xs'>
                {t('Observed requests: {{value}}', {
                  value: formatNumber(
                    group.request_count,
                    toIntlLocale(i18n.language)
                  ),
                })}
              </span>
            )}
          </div>
          <strong
            className={cn(
              'text-3xl leading-none font-bold tabular-nums',
              AVAILABILITY_STYLES[group.status].text
            )}
          >
            {formatUptimePct(group.success_rate ?? Number.NaN)}
          </strong>
        </div>
        <AvailabilityTimeline
          buckets={group.buckets}
          bucketSeconds={data.bucket_seconds}
          startTime={data.start_time}
          endTime={data.end_time}
          groupName={name}
        />
        <p className='text-muted-foreground text-xs'>
          {group.last_request_at
            ? t('Last observed request: {{time}}', {
                time: dayjs
                  .unix(group.last_request_at)
                  .format('MM-DD HH:mm:ss'),
              })
            : t('No requests observed in this period')}
        </p>
      </CardContent>
    </Card>
  )
}
