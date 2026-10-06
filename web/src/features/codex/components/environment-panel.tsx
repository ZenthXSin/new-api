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
  ChevronDown,
  CircleAlert,
  Cpu,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  Power,
  RefreshCw,
  Server,
  Square,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import type { CodexEnvironment } from '../types'

export function EnvironmentPanel(props: {
  environment?: CodexEnvironment
  loading: boolean
  taskRunning?: boolean
  unavailable: boolean
  pending: 'start' | 'stop' | null
  error?: string
  onStart: () => void
  onStop: () => void
  onRetry: () => void
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const environment = props.environment
  const status = environment?.status
  const busy = props.taskRunning || !!environment?.activeWorkspaceId
  const starting = status === 'starting' || props.pending === 'start'
  const unavailable = props.unavailable || !environment
  const disabled = unavailable || !!props.pending || starting
  const labels = {
    not_created: t('Environment not created'),
    stopped: t('Environment sleeping'),
    starting: t('Starting environment'),
    running: t('Environment running'),
    error: t('Environment error'),
  }
  let label = environment
    ? labels[environment.status]
    : t('Environment unavailable')
  if (props.pending === 'stop') label = t('Stopping environment...')
  if (starting) label = labels.starting
  if (unavailable) label = t('Environment unavailable')
  if (props.loading) label = t('Loading environment...')
  const showRetry = props.unavailable && !props.loading
  const showStop =
    status === 'running' || status === 'error' || props.pending === 'stop'
  const failure = props.error || environment?.lastError
  const activeId = environment?.activeWorkspaceId
  const tone = cn(
    'text-muted-foreground',
    status === 'running' &&
      !unavailable &&
      'text-emerald-700 dark:text-emerald-400',
    (failure || status === 'error' || (props.unavailable && !props.loading)) &&
      'text-destructive'
  )
  return (
    <section
      aria-label={t('Personal environment')}
      className='min-w-0 shrink-0'
    >
      <Popover open={expanded} onOpenChange={setExpanded}>
        <PopoverTrigger
          aria-label={t('Personal environment details')}
          title={label}
          className='hover:bg-muted focus-visible:ring-ring flex h-10 items-center gap-2 rounded-lg px-2 text-xs outline-none focus-visible:ring-2 sm:h-9 sm:px-2.5'
        >
          <span className='relative flex size-5 items-center justify-center'>
            {props.loading || starting || props.pending ? (
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
            ) : (
              <Server className='text-muted-foreground size-4' aria-hidden />
            )}
            {!props.loading && !starting && !props.pending && (
              <span
                className={cn(
                  'bg-background absolute -right-0.5 -bottom-0.5 flex size-2.5 items-center justify-center rounded-full',
                  tone
                )}
              >
                <span className='size-1.5 rounded-full bg-current' />
              </span>
            )}
          </span>
          <span className={cn('hidden lg:inline', tone)}>{label}</span>
          <ChevronDown
            className='text-muted-foreground hidden size-3 sm:block'
            aria-hidden
          />
        </PopoverTrigger>
        <PopoverContent
          align='end'
          sideOffset={8}
          collisionPadding={12}
          className='max-h-[min(36rem,80dvh)] w-[min(360px,calc(100vw-24px))] gap-0 overflow-y-auto rounded-2xl p-4 shadow-xl'
        >
          <div className='flex items-center justify-between gap-3'>
            <PopoverTitle className='font-sans text-sm font-semibold'>
              {t('Personal environment')}
            </PopoverTitle>
            <span
              role='status'
              className={cn('flex items-center gap-1.5 text-xs', tone)}
            >
              <span className='size-1.5 rounded-full bg-current' />
              {label}
            </span>
          </div>
          <p className='text-muted-foreground mt-2 text-xs leading-5'>
            {t(
              'One personal environment shared by all your projects. Each project keeps its own files and conversation.'
            )}
          </p>
          {environment && (
            <dl className='bg-muted/50 my-4 grid grid-cols-3 gap-3 rounded-xl p-3 text-xs'>
              <div>
                <dt className='text-muted-foreground mb-1.5 flex items-center gap-1'>
                  <Cpu className='size-3' aria-hidden />
                  {t('CPU')}
                </dt>
                <dd className='text-sm font-medium'>
                  {environment.limits.cpus}
                </dd>
              </div>
              <div>
                <dt className='text-muted-foreground mb-1.5 flex items-center gap-1'>
                  <MemoryStick className='size-3' aria-hidden />
                  {t('Memory')}
                </dt>
                <dd className='text-sm font-medium'>
                  {(environment.limits.memoryBytes / 1024 ** 3).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 1 }
                  )}{' '}
                  GiB
                </dd>
              </div>
              <div>
                <dt className='text-muted-foreground mb-1.5 flex items-center gap-1'>
                  <HardDrive className='size-3' aria-hidden />
                  {t('Storage limit')}
                </dt>
                <dd className='text-sm font-medium'>
                  {(environment.limits.diskBytes / 1024 ** 3).toLocaleString(
                    undefined,
                    { maximumFractionDigits: 1 }
                  )}{' '}
                  GiB
                </dd>
              </div>
            </dl>
          )}
          {activeId && (
            <button
              type='button'
              className='hover:bg-muted mb-3 w-full rounded-lg border px-3 py-2 text-left'
              onClick={() => {
                props.onSelect(activeId)
                setExpanded(false)
              }}
            >
              <span className='text-muted-foreground block text-xs'>
                {t('Active project:')}
              </span>
              <span className='mt-1 block truncate text-sm font-medium'>
                {environment?.activeWorkspaceName || t('Open active project')}
              </span>
            </button>
          )}
          <div className='text-muted-foreground space-y-2 text-xs leading-5'>
            <p>{t('Only one task can run at a time across your projects.')}</p>
            {environment && (
              <p>
                {t(
                  'Sleeps after {{minutes}} minutes without activity. Files and conversations are preserved.',
                  { minutes: Math.ceil(environment.idleSeconds / 60) }
                )}
              </p>
            )}
            <p>
              {t(
                'Starting the environment does not send a model request. Sending a task wakes it automatically.'
              )}
            </p>
          </div>
          {failure && (
            <p
              role='alert'
              className='text-destructive mt-3 flex items-start gap-2 text-xs leading-5 break-words'
            >
              <CircleAlert className='mt-0.5 size-3.5 shrink-0' aria-hidden />
              <span className='min-w-0'>{t(failure)}</span>
            </p>
          )}
          <div className='mt-4 flex flex-wrap items-center justify-end gap-2 border-t pt-3'>
            {environment && (
              <span className='text-muted-foreground mr-auto text-xs'>
                {t('Projects: {{count}}', { count: environment.projectCount })}
              </span>
            )}
            {showRetry && (
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={props.onRetry}
              >
                <RefreshCw className='size-3.5' />
                {t('Retry environment')}
              </Button>
            )}
            {!showRetry && showStop && (
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={props.onStop}
                disabled={disabled || busy}
                title={
                  busy
                    ? t(
                        'Stop the active task before stopping your environment.'
                      )
                    : undefined
                }
              >
                <Square className='size-3.5' />
                {t('Stop environment')}
              </Button>
            )}
            {!showRetry && (!showStop || status === 'error') && (
              <Button
                type='button'
                size='sm'
                onClick={props.onStart}
                disabled={disabled || busy}
                title={t(
                  'Starting the environment does not send a model request.'
                )}
              >
                <Power className='size-3.5' />
                {t('Start environment')}
              </Button>
            )}
          </div>
          {busy && (
            <p className='text-muted-foreground mt-2 text-xs leading-5'>
              {t('Stop the active task before stopping your environment.')}
            </p>
          )}
        </PopoverContent>
      </Popover>
    </section>
  )
}
