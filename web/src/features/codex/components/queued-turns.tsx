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
import { ChevronDown, Clock3, LoaderCircle, Pause, Play, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { codexError } from '../api'
import type { CodexQueuedTurn } from '../types'
import { Button } from '../vendor/zcode/button'

type QueueOperation = { requestId: string; action: 'cancel' | 'resume' }

export function QueuedTurns(props: {
  turns: CodexQueuedTurn[]
  onCancel?: (requestId: string) => Promise<void>
  onResume?: (requestId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const contentId = useId()
  const locked = useRef(false)
  const [expanded, setExpanded] = useState(true)
  const [pending, setPending] = useState<QueueOperation | null>(null)
  const [error, setError] = useState<
    (QueueOperation & { message: string }) | null
  >(null)

  async function operate(requestId: string, action: QueueOperation['action']) {
    const turn = props.turns.find((entry) => entry.requestId === requestId)
    const callback = action === 'cancel' ? props.onCancel : props.onResume
    if (locked.current || !callback || !turn || turn.status === 'starting') {
      return
    }
    if (
      action === 'resume' &&
      (turn.status !== 'paused' || turn.canResume === false)
    ) {
      return
    }
    locked.current = true
    setPending({ requestId, action })
    setError(null)
    try {
      await callback(requestId)
    } catch (cause) {
      setError({ requestId, action, message: codexError(cause) })
      setExpanded(true)
    } finally {
      locked.current = false
      setPending(null)
    }
  }

  if (!props.turns.length) return null
  return (
    <section
      aria-label={t('Queued messages')}
      className='chatgpt-queued-turns border-border/70 bg-background mb-2 overflow-hidden rounded-2xl border'
    >
      <button
        type='button'
        className='text-muted-foreground hover:bg-hover flex min-h-10 w-full items-center gap-2.5 rounded-2xl px-4 py-2 text-left transition-colors'
        aria-label={
          expanded ? t('Hide queued messages') : t('Show queued messages')
        }
        aria-expanded={expanded}
        aria-controls={contentId}
        title={t('Queued messages run one at a time.')}
        onClick={() => setExpanded((current) => !current)}
      >
        <Clock3 className='size-4 shrink-0' aria-hidden />
        <span className='min-w-0 flex-1 text-xs font-medium'>
          {t('Queued messages ({{count}})', { count: props.turns.length })}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      <div id={contentId} hidden={!expanded}>
        <ul className='divide-border/60 max-h-44 divide-y overflow-y-auto overscroll-contain px-3 pb-1'>
          {props.turns.map((turn) => {
            const operation =
              pending?.requestId === turn.requestId ? pending : null
            const failure = error?.requestId === turn.requestId ? error : null
            const errorId = `${contentId}-${turn.requestId}-error`
            const canCancel = !!props.onCancel && turn.status !== 'starting'
            const canResume =
              !!props.onResume &&
              turn.status === 'paused' &&
              turn.canResume !== false
            let status = t('Queued')
            let StatusIcon = Clock3
            if (turn.status === 'paused') {
              status = t('Paused')
              StatusIcon = Pause
            }
            if (turn.status === 'starting') {
              status = t('Starting task…')
              StatusIcon = LoaderCircle
            }
            if (operation) {
              status =
                operation.action === 'resume'
                  ? t('Resuming queued message…')
                  : t('Cancelling queued message…')
              StatusIcon = LoaderCircle
            }
            const inProgress = !!operation || turn.status === 'starting'
            return (
              <li key={turn.requestId} className='py-2'>
                <div className='flex items-start gap-2'>
                  <div className='min-w-0 flex-1 px-1 py-0.5'>
                    <p
                      className='text-foreground line-clamp-2 text-sm leading-5 break-words'
                      title={turn.prompt}
                    >
                      {turn.prompt}
                    </p>
                    <p
                      role={inProgress ? 'status' : undefined}
                      aria-atomic={inProgress || undefined}
                      className='text-muted-foreground mt-1 flex items-center gap-1.5 text-xs'
                    >
                      <StatusIcon
                        className={cn(
                          'size-3 shrink-0',
                          inProgress &&
                            'animate-spin motion-reduce:animate-none'
                        )}
                        aria-hidden
                      />
                      <span>{status}</span>
                    </p>
                    {turn.status === 'paused' && turn.error && (
                      <p className='text-muted-foreground mt-1 text-xs leading-4 break-words'>
                        {t(turn.error)}
                      </p>
                    )}
                  </div>
                  <div className='flex shrink-0 items-center gap-0.5'>
                    {turn.status === 'paused' && (
                      <Button
                        type='button'
                        size='icon-md'
                        variant='ghost'
                        className='size-9 rounded-full sm:size-8'
                        aria-label={t('Resume queued message: {{prompt}}', {
                          prompt: turn.prompt,
                          interpolation: { escapeValue: false },
                        })}
                        aria-busy={operation?.action === 'resume'}
                        aria-describedby={failure ? errorId : undefined}
                        title={t('Resume queued message')}
                        disabled={!!pending || !canResume}
                        onClick={() => void operate(turn.requestId, 'resume')}
                      >
                        {operation?.action === 'resume' ? (
                          <LoaderCircle
                            className='size-4 animate-spin motion-reduce:animate-none'
                            aria-hidden
                          />
                        ) : (
                          <Play className='size-4' aria-hidden />
                        )}
                      </Button>
                    )}
                    <Button
                      type='button'
                      size='icon-md'
                      variant='ghost'
                      className='size-9 rounded-full sm:size-8'
                      aria-label={t('Cancel queued message: {{prompt}}', {
                        prompt: turn.prompt,
                        interpolation: { escapeValue: false },
                      })}
                      aria-busy={operation?.action === 'cancel'}
                      aria-describedby={failure ? errorId : undefined}
                      title={t('Cancel queued message')}
                      disabled={!!pending || !canCancel}
                      onClick={() => void operate(turn.requestId, 'cancel')}
                    >
                      {operation?.action === 'cancel' ? (
                        <LoaderCircle
                          className='size-4 animate-spin motion-reduce:animate-none'
                          aria-hidden
                        />
                      ) : (
                        <X className='size-4' aria-hidden />
                      )}
                    </Button>
                  </div>
                </div>
                {failure && (
                  <div
                    role='alert'
                    id={errorId}
                    className='text-destructive mt-1 flex items-start gap-2 px-1 text-xs'
                  >
                    <p className='min-w-0 flex-1 py-1.5 break-words'>
                      {t(failure.message)}
                    </p>
                    <Button
                      type='button'
                      variant='ghost'
                      className='min-h-8 rounded-lg px-2 text-xs text-current'
                      disabled={
                        !!pending ||
                        (failure.action === 'resume' ? !canResume : !canCancel)
                      }
                      onClick={() =>
                        void operate(turn.requestId, failure.action)
                      }
                    >
                      {t('Retry')}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
