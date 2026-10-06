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
import { CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toIntlLocale } from '@/i18n/languages'
import { formatUseTime } from '@/lib/format'
import { cn } from '@/lib/utils'

import {
  TIMING_TEXT_COLOR_MAP as textColorMap,
  formatTimingBytes,
  formatTimingEndStatus,
  formatTimingMilliseconds,
  getFirstResponseTimeColor,
  getResponseTimeColor,
  getTimingConnectionPhases,
  type TimingColor,
} from '../lib/format'
import type { DetailedTimingMetrics, LogOtherData } from '../types'

const dotColorMap: Record<TimingColor | 'neutral', string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-400',
  orange: 'bg-orange-500',
  danger: 'bg-red-500',
  neutral: 'bg-neutral',
}

/**
 * Softened fills for the full-height timing bar. The bar sits directly beside
 * dense numeric text, so the saturated `dotColorMap` tones (tuned for small
 * dots and badges) read as too high-contrast at that size; a translucent fill
 * keeps the status legible while matching the page's muted palette.
 */
const barColorMap: Record<TimingColor | 'neutral', string> = {
  success: 'bg-emerald-500/90',
  warning: 'bg-amber-400/80',
  orange: 'bg-orange-500/80',
  danger: 'bg-red-500/80',
  neutral: 'bg-neutral/80',
}

interface TimingMetricsCellProps {
  useTimeSec: number
  completionTokens: number
  frtMs?: number
  isStream: boolean
  className?: string
  /** Detailed relay timing shown in an accessible popover when available. */
  detailedTiming?: DetailedTimingMetrics
  /**
   * `bar` (default) draws a full-height color segment beside the labels,
   * matching the dense desktop table. `dot` swaps that segment for small
   * status dots inline with each label, matching the lighter-weight status
   * indicator used elsewhere on the mobile card.
   */
  indicator?: 'bar' | 'dot'
}

export function TimingMetricsCell(props: TimingMetricsCellProps) {
  const { t, i18n } = useTranslation()
  const indicator = props.indicator ?? 'bar'
  const showFirstToken = props.isStream
  const firstTokenSeconds =
    props.frtMs != null && props.frtMs > 0 ? props.frtMs / 1000 : null
  const firstTokenVariant: TimingColor | 'neutral' =
    firstTokenSeconds == null
      ? 'neutral'
      : getFirstResponseTimeColor(firstTokenSeconds)
  const totalTimeVariant = getResponseTimeColor(
    props.useTimeSec,
    props.completionTokens
  )
  const firstTokenLabel =
    firstTokenSeconds == null ? t('N/A') : formatUseTime(firstTokenSeconds)
  const totalTimeLabel = formatUseTime(props.useTimeSec)

  const labels = (
    <div className='flex min-h-8 min-w-0 flex-col justify-center gap-0.5 text-xs leading-tight'>
      {showFirstToken && (
        <div className='flex items-baseline gap-1.5'>
          {indicator === 'dot' && (
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                dotColorMap[firstTokenVariant]
              )}
            />
          )}
          <span className='text-muted-foreground shrink-0'>
            {t('First token')}
          </span>
          <span className={cn('tabular-nums', textColorMap[firstTokenVariant])}>
            {firstTokenLabel}
          </span>
        </div>
      )}
      <div className='flex items-baseline gap-1.5'>
        {indicator === 'dot' && (
          <span
            aria-hidden
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              dotColorMap[totalTimeVariant]
            )}
          />
        )}
        <span className='text-muted-foreground shrink-0'>{t('Duration')}</span>
        <span className={cn('tabular-nums', textColorMap[totalTimeVariant])}>
          {totalTimeLabel}
        </span>
      </div>
    </div>
  )

  const timingSummary =
    indicator === 'dot' ? (
      <div className={cn('flex items-stretch', props.className)}>{labels}</div>
    ) : (
      <div className={cn('flex items-stretch gap-2', props.className)}>
        <span
          aria-hidden
          className={cn(
            'flex w-1 shrink-0 flex-col overflow-hidden rounded-full',
            !showFirstToken && barColorMap[totalTimeVariant]
          )}
        >
          {showFirstToken && (
            <>
              <span className={cn('flex-1', barColorMap[firstTokenVariant])} />
              <span className={cn('flex-1', barColorMap[totalTimeVariant])} />
            </>
          )}
        </span>
        {labels}
      </div>
    )

  if (!props.detailedTiming) return timingSummary

  const detail = props.detailedTiming
  const connectionPhases = getTimingConnectionPhases(detail)
  let connectionValue = '—'
  if (detail.upstream_connection?.reused || detail.upstream_reused) {
    connectionValue = t('Reused')
  } else if (connectionPhases.length > 0) {
    connectionValue = connectionPhases
      .map((phase) => `${phase.label} ${formatTimingMilliseconds(phase.value)}`)
      .join(' / ')
  } else if (detail.upstream_connection_ms != null) {
    connectionValue = formatTimingMilliseconds(detail.upstream_connection_ms)
  }

  const detailRows = [
    {
      label: t('Site processing'),
      value: formatTimingMilliseconds(detail.site_processing_ms),
    },
    { label: t('Upstream connection'), value: connectionValue },
    {
      label: t('Upstream first event'),
      value: formatTimingMilliseconds(detail.upstream_first_event_ms),
    },
    {
      label: t('Relay processing'),
      value: formatTimingMilliseconds(detail.relay_processing_ms),
    },
    {
      label: t('Downstream send'),
      value: formatTimingMilliseconds(detail.downstream_send_ms),
    },
    {
      label: t('Total time'),
      value: formatTimingMilliseconds(detail.total_ms),
    },
    {
      label: t('Sent bytes'),
      value: formatTimingBytes(
        detail.sent_bytes,
        toIntlLocale(i18n.resolvedLanguage || i18n.language)
      ),
    },
    {
      label: t('End status'),
      value: formatTimingEndStatus(detail.end_status, t),
    },
  ]

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type='button'
            aria-label={t('View detailed timing')}
            onClick={(event) => event.stopPropagation()}
            className='focus-visible:ring-ring font-inherit inline-flex w-full min-w-0 cursor-pointer appearance-none border-0 bg-transparent p-0 text-left focus-visible:ring-2 focus-visible:outline-none'
          />
        }
      >
        {timingSummary}
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        collisionPadding={8}
        className='w-72 max-w-[calc(100vw-1rem)]'
      >
        <PopoverHeader>
          <PopoverTitle>{t('Timing details')}</PopoverTitle>
        </PopoverHeader>
        <dl className='divide-border/60 divide-y text-xs'>
          {detailRows.map((row) => (
            <div
              key={row.label}
              className='flex items-start justify-between gap-4 py-1.5 first:pt-0 last:pb-0'
            >
              <dt className='text-muted-foreground shrink-0'>{row.label}</dt>
              <dd className='text-foreground min-w-0 text-right font-mono break-words tabular-nums'>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}

interface StreamTpsCellProps {
  isStream: boolean
  tokensPerSecond?: number | null
  streamStatus?: LogOtherData['stream_status']
  className?: string
}

export function StreamTpsCell(props: StreamTpsCellProps) {
  const { t } = useTranslation()
  const showStreamError =
    props.isStream && props.streamStatus && props.streamStatus.status !== 'ok'
  const tpsLabel =
    props.tokensPerSecond != null
      ? `${Math.round(props.tokensPerSecond)} t/s`
      : '—'
  const streamLabel = props.isStream ? t('Stream') : t('Non-stream')

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col items-start justify-center gap-0.5 text-xs leading-tight',
        props.className
      )}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 font-medium',
          props.isStream ? 'text-info' : 'text-muted-foreground'
        )}
      >
        {streamLabel}
        {showStreamError && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={<CircleAlert className='text-destructive size-3' />}
              />
              <TooltipContent>
                <div className='space-y-0.5 text-xs'>
                  <p>
                    {t('Stream Status')}: {t('Error')}
                  </p>
                  <p>{props.streamStatus?.end_reason || 'unknown'}</p>
                  {(props.streamStatus?.error_count ?? 0) > 0 && (
                    <p>
                      {t('Soft Errors')}: {props.streamStatus?.error_count}
                    </p>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </span>
      <span className='text-muted-foreground/60 px-0.5 tabular-nums'>
        {tpsLabel}
      </span>
    </div>
  )
}
