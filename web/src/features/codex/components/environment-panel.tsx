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
  ArrowUpRight,
  CircleAlert,
  Container,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import type { CodexEnvironment } from '../types'
import { Button } from '../vendor/zcode/button'

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
  onSelect: (id: string, conversationId?: string) => void
}) {
  const { t } = useTranslation()
  const descriptionId = useId()
  const environment = props.environment
  const status = environment?.status
  const busy = !!props.taskRunning || !!environment?.activeWorkspaceId
  const unavailable = props.unavailable || !environment
  const starting =
    props.pending === 'start' || (!unavailable && status === 'starting')
  const stopping = props.pending === 'stop'
  const processing = props.loading || starting || stopping
  const disabled = processing || unavailable || busy
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
  if (starting) label = labels.starting
  if (stopping) label = t('Stopping environment...')
  if (unavailable) label = t('Environment unavailable')
  if (props.loading) label = t('Loading environment...')
  const showRetry = unavailable && !props.loading
  const showStop =
    !showRetry &&
    (stopping || (!starting && (status === 'running' || status === 'error')))
  const showStart =
    !showRetry && !stopping && (starting || status !== 'running')
  let startLabel = t('Start environment')
  if (status === 'not_created') startLabel = t('Create and start environment')
  if (status === 'error') startLabel = t('Retry start')
  let description = t(
    'Starting the environment does not send a model request. Sending a task wakes it automatically.'
  )
  if (status === 'not_created') {
    description = t(
      'Your environment will be created when you start it or send your first task.'
    )
  }
  if (unavailable) {
    description = t('Refresh environment status to reconnect and try again.')
  }
  if (busy) {
    description = t('Stop the active task before stopping your environment.')
  }
  const failure = props.error || environment?.lastError
  const activeId = environment?.activeWorkspaceId
  const tone = cn(
    'text-muted-foreground',
    status === 'running' &&
      !unavailable &&
      'text-emerald-700 dark:text-emerald-400',
    (failure || status === 'error' || showRetry) && 'text-destructive'
  )

  return (
    <section
      aria-label={t('Personal environment')}
      aria-busy={processing}
      className='min-w-0 text-sm'
    >
      <header className='flex min-w-0 items-center gap-3'>
        <span className='border-border/70 flex size-10 shrink-0 items-center justify-center rounded-xl border'>
          <Container className='size-5' aria-hidden />
        </span>
        <div className='min-w-0'>
          <h3 className='text-base font-semibold'>{t('Docker environment')}</h3>
          <p className='text-muted-foreground mt-1 text-xs'>
            {t('Hosted on this server')}
          </p>
        </div>
      </header>
      <p className='text-muted-foreground mt-4 text-sm leading-6'>
        {t(
          'One personal environment shared by all your projects. Each project keeps its own files and conversation.'
        )}
      </p>

      <div className='border-border/60 mt-5 flex flex-wrap items-center justify-between gap-4 border-y py-4'>
        <div className='min-w-0'>
          <p className='font-medium'>{t('Environment status')}</p>
          <p
            role='status'
            aria-live='polite'
            aria-atomic='true'
            className={cn('mt-2 flex items-center gap-2 text-xs', tone)}
          >
            {processing ? (
              <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
            ) : (
              <span
                className='size-1.5 shrink-0 rounded-full bg-current'
                aria-hidden
              />
            )}
            {label}
          </p>
        </div>
        <div className='flex max-w-full flex-wrap items-center gap-2'>
          {showRetry && (
            <Button
              type='button'
              variant='outline'
              className='focus-visible:ring-ring h-auto min-h-9 max-w-full gap-2 rounded-full px-4 py-2 text-sm whitespace-normal focus-visible:ring-2'
              onClick={props.onRetry}
              disabled={processing}
              aria-describedby={descriptionId}
            >
              <RefreshCw className='size-3.5' aria-hidden />
              {t('Retry environment')}
            </Button>
          )}
          {showStop && (
            <Button
              type='button'
              variant='outline'
              className='focus-visible:ring-ring h-auto min-h-9 max-w-full rounded-full px-4 py-2 text-sm whitespace-normal focus-visible:ring-2'
              onClick={props.onStop}
              disabled={disabled}
              aria-describedby={descriptionId}
            >
              {stopping && (
                <LoaderCircle
                  className='mr-1 size-3.5 animate-spin'
                  aria-hidden
                />
              )}
              {t('Stop environment')}
            </Button>
          )}
          {showStart && (
            <Button
              type='button'
              className='focus-visible:ring-ring h-auto min-h-9 max-w-full rounded-full px-4 py-2 text-sm whitespace-normal focus-visible:ring-2'
              onClick={props.onStart}
              disabled={disabled}
              aria-describedby={descriptionId}
            >
              {starting && (
                <LoaderCircle
                  className='mr-1 size-3.5 animate-spin'
                  aria-hidden
                />
              )}
              {startLabel}
            </Button>
          )}
        </div>
      </div>

      <p
        id={descriptionId}
        className='text-muted-foreground mt-3 text-xs leading-5'
      >
        {description}
      </p>
      {failure && (
        <p
          role='alert'
          className='border-destructive/20 bg-destructive/5 text-destructive mt-4 flex min-w-0 items-start gap-2 rounded-xl border p-3 text-sm leading-6 break-words'
        >
          <CircleAlert className='mt-1 size-4 shrink-0' aria-hidden />
          <span className='min-w-0 [overflow-wrap:anywhere]'>{t(failure)}</span>
        </p>
      )}

      {activeId && (
        <button
          type='button'
          aria-label={`${t('Active project:')} ${environment?.activeWorkspaceName || t('Open active project')}`}
          className='border-border/60 hover:bg-muted focus-visible:ring-ring mt-5 flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left outline-none focus-visible:ring-2'
          onClick={() =>
            props.onSelect(
              activeId,
              environment?.activeConversationId ?? undefined
            )
          }
        >
          <span className='min-w-0'>
            <span className='text-muted-foreground block text-xs'>
              {t('Active project:')}{' '}
            </span>
            <span
              className='mt-1 block truncate font-medium'
              title={environment?.activeWorkspaceName || undefined}
            >
              {environment?.activeWorkspaceName || t('Open active project')}
            </span>
          </span>
          <ArrowUpRight
            className='text-muted-foreground size-4 shrink-0'
            aria-hidden
          />
        </button>
      )}

      {environment && (
        <>
          <h4 className='mt-6 font-medium'>{t('Resource limits')}</h4>
          <p className='text-muted-foreground mt-1 text-xs leading-5'>
            {t('These are the limits applied to this environment.')}
          </p>
          <dl className='divide-border/60 mt-2 divide-y'>
            <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3'>
              <dt className='text-muted-foreground'>{t('CPU limit')}</dt>
              <dd className='text-right tabular-nums'>
                {environment.limits.cpuPercent !== undefined && (
                  <>{environment.limits.cpuPercent}% · </>
                )}
                {environment.limits.cpus.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}{' '}
                vCPU
              </dd>
            </div>
            <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3'>
              <dt className='text-muted-foreground'>{t('Memory limit')}</dt>
              <dd className='text-right tabular-nums'>
                {(environment.limits.memoryBytes / 1024 ** 2).toLocaleString(
                  undefined,
                  { maximumFractionDigits: 0 }
                )}{' '}
                MB
              </dd>
            </div>
            <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3'>
              <dt className='text-muted-foreground'>{t('Storage limit')}</dt>
              <dd className='text-right tabular-nums'>
                {(environment.limits.diskBytes / 1024 ** 3).toLocaleString(
                  undefined,
                  { maximumFractionDigits: 1 }
                )}{' '}
                GiB
              </dd>
            </div>
          </dl>
          {environment.runtime === 'docker' && (
            <>
              <h4 className='mt-6 font-medium'>{t('Runtime details')}</h4>
              <dl className='divide-border/60 mt-2 divide-y'>
                {environment.network && (
                  <>
                    <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3'>
                      <dt className='text-muted-foreground'>{t('Network')}</dt>
                      <dd>{t('Dedicated Docker bridge')}</dd>
                    </div>
                    <div className='flex flex-col gap-1 py-3'>
                      <dt className='text-muted-foreground'>
                        {t('Internet access')}
                      </dt>
                      <dd className='text-xs leading-5'>
                        <p>
                          {t(
                            'Internet access is allowed by the runtime policy.'
                          )}
                        </p>
                        {!environment.network.policyEditable && (
                          <p className='text-muted-foreground mt-1'>
                            {t(
                              'Network policy is managed by your administrator.'
                            )}
                          </p>
                        )}
                      </dd>
                    </div>
                  </>
                )}
                {environment.persistentStorage !== undefined && (
                  <div className='flex flex-col gap-1 py-3'>
                    <dt className='text-muted-foreground'>
                      {t('Persistent storage')}
                    </dt>
                    <dd className='text-xs leading-5'>
                      {environment.persistentStorage
                        ? t('Files are kept when the environment stops.')
                        : t('Files are not kept when the environment stops.')}
                    </dd>
                  </div>
                )}
                {environment.filesystemIsolation === 'user' && (
                  <div className='flex flex-col gap-1 py-3'>
                    <dt className='text-muted-foreground'>
                      {t('Environment scope')}
                    </dt>
                    <dd className='text-xs leading-5'>
                      {t('Projects share your personal environment.')}
                    </dd>
                  </div>
                )}
              </dl>
            </>
          )}
          <div className='border-border/60 border-t pt-4 text-xs leading-5'>
            <p className='text-muted-foreground'>
              {t(
                'Sleeps after {{minutes}} minutes without activity. Files and conversations are preserved.',
                { minutes: Math.ceil(environment.idleSeconds / 60) }
              )}
            </p>
            <p className='text-muted-foreground mt-1'>
              {t('Only one task can run at a time across your projects.')}
            </p>
            <p className='text-muted-foreground mt-1'>
              {t('Projects: {{count}}', { count: environment.projectCount })}
            </p>
          </div>
        </>
      )}
    </section>
  )
}
