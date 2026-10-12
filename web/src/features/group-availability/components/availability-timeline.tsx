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
import { useTranslation } from 'react-i18next'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  formatLatency,
  formatThroughput,
  formatUptimePct,
} from '@/features/performance-metrics/lib/format'
import { toIntlLocale } from '@/i18n/languages'
import dayjs from '@/lib/dayjs'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

import type { AvailabilityBucket } from '../api'
import { AVAILABILITY_STYLES } from '../lib/availability-styles'
import { AvailabilityStatusBadge } from './availability-status'

export function AvailabilityTimeline({
  buckets,
  bucketSeconds,
  startTime,
  endTime,
  groupName,
}: {
  buckets: AvailabilityBucket[]
  bucketSeconds: number
  startTime: number
  endTime: number
  groupName: string
}) {
  const { t, i18n } = useTranslation()

  return (
    <div className='flex min-w-0 flex-col gap-2'>
      <p className='text-muted-foreground text-xs'>{t('Observed history')}</p>
      <div
        className='flex h-8 min-w-0 items-end gap-0.5'
        role='group'
        aria-label={t('Availability history for {{group}}', {
          group: groupName,
        })}
      >
        {buckets.map((bucket) => {
          const style =
            bucket.sample_state === 'insufficient'
              ? {
                  ...AVAILABILITY_STYLES.unknown,
                  bar: 'bg-info',
                  height: '55%',
                }
              : AVAILABILITY_STYLES[bucket.status]
          const time = dayjs.unix(bucket.start_time).format('MM-DD HH:mm')
          const until = dayjs
            .unix(bucket.start_time + bucketSeconds)
            .format('MM-DD HH:mm')
          const success = formatUptimePct(bucket.success_rate ?? Number.NaN)
          let stateLabel = t(style.label)
          if (bucket.sample_state === 'none') stateLabel = t('No traffic')
          if (bucket.sample_state === 'insufficient') {
            stateLabel = t('Insufficient samples')
          }

          return (
            <Tooltip key={bucket.start_time}>
              <TooltipTrigger
                className='focus-visible:ring-ring flex h-full min-w-0 flex-1 items-end rounded-sm outline-none hover:opacity-75 focus-visible:ring-2'
                aria-label={`${time} – ${until}: ${stateLabel}, ${success}`}
              >
                <span
                  className={cn('w-full rounded-sm', style.bar)}
                  style={{ height: style.height }}
                  aria-hidden='true'
                />
              </TooltipTrigger>
              <TooltipContent className='max-w-xs'>
                <div className='flex flex-col gap-1.5'>
                  <p className='font-medium'>
                    {time} – {until}
                  </p>
                  <AvailabilityStatusBadge
                    status={bucket.status}
                    sampleState={bucket.sample_state}
                  />
                  <p>
                    {t('Observed success rate')}: {success}
                  </p>
                  <p>
                    {t('Cache hit rate')}:{' '}
                    {formatUptimePct(bucket.cache_hit_rate ?? Number.NaN)}
                  </p>
                  {bucket.request_count !== null && (
                    <p>
                      {t('Requests')}:{' '}
                      {formatNumber(
                        bucket.request_count,
                        toIntlLocale(i18n.language)
                      )}
                    </p>
                  )}
                  <p>
                    {t('Average first token')}:{' '}
                    {formatLatency(bucket.avg_ttft_ms ?? Number.NaN)}
                  </p>
                  <p>
                    {t('Average request duration')}:{' '}
                    {formatLatency(bucket.avg_duration_ms ?? Number.NaN)}
                  </p>
                  <p>
                    {t('Average output speed')}:{' '}
                    {formatThroughput(bucket.avg_output_tps ?? Number.NaN)}
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <div className='text-muted-foreground flex justify-between gap-2 text-[10px] tabular-nums'>
        <span>{dayjs.unix(startTime).format('MM-DD HH:mm')}</span>
        <span>{dayjs.unix(endTime).format('MM-DD HH:mm')}</span>
      </div>
    </div>
  )
}
