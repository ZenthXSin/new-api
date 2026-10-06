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
  Check,
  ChevronDown,
  Circle,
  LoaderCircle,
  Terminal,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { CodexThread } from '../types'

export function WorkspaceLogs(props: { thread: CodexThread | null }) {
  const { t } = useTranslation()
  const commands =
    props.thread?.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === 'commandExecution')
    ) ?? []
  return (
    <>
      <div className='flex shrink-0 items-center justify-between border-b px-4 py-3'>
        <p className='text-sm font-medium'>{t('Command history')}</p>
        <span className='text-muted-foreground text-xs'>{commands.length}</span>
      </div>
      {commands.length === 0 && (
        <div className='text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm'>
          <span className='bg-muted rounded-2xl p-4'>
            <Terminal className='size-6' aria-hidden />
          </span>
          <p className='text-foreground font-medium'>{t('No commands yet.')}</p>
          <p>{t('Command output will appear here.')}</p>
        </div>
      )}
      {commands.length > 0 && (
        <div className='min-h-0 min-w-0 flex-1 space-y-3 overflow-auto p-3 sm:p-4'>
          {commands.map((command, index) => {
            const active = command.status === 'inProgress'
            const failed =
              command.status === 'failed' ||
              (typeof command.exitCode === 'number' && command.exitCode !== 0)
            const completed = command.status === 'completed'
            let status = t('Interrupted')
            let Icon = Circle
            if (active) {
              status = t('Running')
              Icon = LoaderCircle
            } else if (failed) {
              status = t('Failed')
              Icon = X
            } else if (completed) {
              status = t('Completed')
              Icon = Check
            }
            return (
              <details
                key={command.id}
                open={index === commands.length - 1 || active || failed}
                className='group overflow-hidden rounded-xl border'
              >
                <summary className='bg-muted/30 flex cursor-pointer list-none items-start gap-2 p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px]'>
                  <ChevronDown
                    className='mt-0.5 size-4 shrink-0 transition-transform group-not-open:-rotate-90'
                    aria-hidden
                  />
                  <span className='min-w-0 flex-1 space-y-2'>
                    <code className='block font-mono text-[13px] leading-5 break-all'>
                      $ {command.command}
                    </code>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-xs',
                        failed ? 'text-destructive' : 'text-muted-foreground'
                      )}
                    >
                      <Icon
                        className={cn('size-3', active && 'animate-spin')}
                        aria-hidden
                      />
                      {status}
                      {typeof command.exitCode === 'number' && (
                        <span className='ml-2'>
                          {t('Exit {{code}}', { code: command.exitCode })}
                        </span>
                      )}
                    </span>
                  </span>
                </summary>
                <pre className='max-h-[55vh] min-w-0 overflow-auto border-t p-4 font-mono text-[13px] leading-6 break-all whitespace-pre-wrap'>
                  {command.aggregatedOutput || t('No command output.')}
                </pre>
              </details>
            )
          })}
        </div>
      )}
    </>
  )
}
