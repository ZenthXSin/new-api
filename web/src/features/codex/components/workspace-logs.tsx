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
  Copy,
  Download,
  LoaderCircle,
  Terminal,
  X,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'

import { downloadCodexFile } from '../api'
import type { CodexItem, CodexThread } from '../types'
import { Button } from '../vendor/zcode/button'

export function WorkspaceLogs(props: { thread: CodexThread | null }) {
  const { t } = useTranslation()
  const commands =
    props.thread?.turns.flatMap((turn) =>
      turn.items.filter((item) => item.type === 'commandExecution')
    ) ?? []
  const activeCount = commands.filter(
    (command) => command.status === 'inProgress'
  ).length
  return (
    <>
      <div className='border-border flex min-h-18 shrink-0 items-center gap-3 border-b px-5 py-3 max-sm:px-4'>
        <p className='text-foreground flex min-w-0 flex-1 items-center gap-2 text-sm font-medium'>
          {t('Command history')}
          <span className='bg-surface text-foreground-subtle rounded-md px-1.5 py-0.5 text-xs font-normal tabular-nums'>
            {commands.length}
          </span>
        </p>
        {activeCount > 0 && (
          <span
            role='status'
            className='text-foreground-subtle inline-flex items-center gap-1.5 text-xs'
          >
            <LoaderCircle className='size-3 animate-spin' aria-hidden />
            {t('Running')}
          </span>
        )}
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='text-foreground-subtle focus-visible:outline-ring size-9 rounded-full focus-visible:outline-2 max-sm:size-11'
          aria-label={t('Download logs')}
          title={t('Download logs')}
          disabled={commands.length === 0}
          onClick={() => {
            const log = commands
              .map((command) => {
                const lines = []
                if (command.cwd) {
                  lines.push(`${t('Working directory')}: ${command.cwd}`)
                }
                lines.push(`$ ${command.command ?? ''}`)
                if (command.aggregatedOutput) {
                  lines.push(command.aggregatedOutput)
                }
                if (typeof command.exitCode === 'number') {
                  lines.push(t('Exit {{code}}', { code: command.exitCode }))
                }
                return lines.join('\n')
              })
              .join('\n\n')
            downloadCodexFile(
              new Blob([log], { type: 'text/plain;charset=utf-8' }),
              'codex-command-history.txt'
            )
          }}
        >
          <Download className='size-4' aria-hidden />
        </Button>
      </div>
      {commands.length === 0 && (
        <div
          role='status'
          className='text-foreground-subtle flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center text-sm leading-6'
        >
          <span className='bg-surface mb-1 flex size-12 items-center justify-center rounded-2xl'>
            <Terminal className='size-5' aria-hidden />
          </span>
          <p className='text-foreground font-medium'>{t('No commands yet.')}</p>
          <p className='max-w-xs'>{t('Command output will appear here.')}</p>
        </div>
      )}
      {commands.length > 0 && (
        <div className='min-h-0 min-w-0 flex-1 space-y-4 overflow-auto p-4'>
          {commands.map((command, index) => (
            <WorkspaceCommandLog
              key={command.id}
              command={command}
              latest={index === commands.length - 1}
            />
          ))}
        </div>
      )}
    </>
  )
}

function WorkspaceCommandLog(props: { command: CodexItem; latest: boolean }) {
  const { t } = useTranslation()
  const contentId = useId()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const clipboard = useCopyToClipboard({ notify: false })
  const active = props.command.status === 'inProgress'
  const failed =
    props.command.status === 'failed' ||
    (typeof props.command.exitCode === 'number' && props.command.exitCode !== 0)
  const completed = props.command.status === 'completed'
  const isExpanded = expanded ?? (props.latest || active || failed)
  const copied =
    !!props.command.aggregatedOutput &&
    clipboard.copiedText === props.command.aggregatedOutput
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
    <article className='border-border bg-background min-w-0 overflow-hidden rounded-xl border'>
      <button
        type='button'
        aria-expanded={isExpanded}
        aria-controls={contentId}
        aria-label={props.command.command || t('Command history')}
        className='bg-surface/45 hover:bg-hover focus-visible:outline-ring flex w-full cursor-pointer items-start gap-2.5 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
        onClick={() => setExpanded(!isExpanded)}
      >
        <ChevronDown
          className={cn(
            'text-foreground-subtle mt-0.5 size-3.5 shrink-0 transition-transform',
            !isExpanded && '-rotate-90'
          )}
          aria-hidden
        />
        <span className='min-w-0 flex-1'>
          <code className='text-foreground block font-mono text-xs leading-5 break-all'>
            <span aria-hidden className='text-foreground-subtle mr-2'>
              $
            </span>
            {props.command.command}
          </code>
          <span
            className={cn(
              'mt-2 inline-flex flex-wrap items-center gap-1.5 text-xs',
              failed ? 'text-destructive' : 'text-foreground-subtle'
            )}
          >
            <Icon
              className={cn('size-3', active && 'animate-spin')}
              aria-hidden
            />
            {status}
            {typeof props.command.exitCode === 'number' && (
              <span className='ml-1'>
                {t('Exit {{code}}', { code: props.command.exitCode })}
              </span>
            )}
          </span>
        </span>
      </button>
      {isExpanded && (
        <div id={contentId} className='border-border border-t'>
          <div className='flex min-h-10 min-w-0 items-center gap-2 px-3 py-1'>
            {props.command.cwd && (
              <span
                className='text-foreground-subtle min-w-0 flex-1 truncate font-mono text-[11px]'
                title={props.command.cwd}
              >
                <span className='sr-only'>{t('Working directory')}: </span>
                {props.command.cwd}
              </span>
            )}
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='text-foreground-subtle focus-visible:outline-ring ml-auto h-8 gap-1.5 rounded-full px-2.5 focus-visible:outline-2'
              aria-label={t('Copy output')}
              title={t('Copy output')}
              disabled={!props.command.aggregatedOutput}
              onClick={async () => {
                const success = await clipboard.copyToClipboard(
                  props.command.aggregatedOutput ?? ''
                )
                setCopyFailed(!success)
              }}
            >
              {copied ? (
                <Check className='size-3.5' aria-hidden />
              ) : (
                <Copy className='size-3.5' aria-hidden />
              )}
              <span>{copied ? t('Copied') : t('Copy')}</span>
            </Button>
            <span className='sr-only' aria-live='polite' aria-atomic='true'>
              {copied ? t('Copied to clipboard') : ''}
            </span>
          </div>
          {copyFailed && (
            <p role='alert' className='text-destructive px-4 pb-2 text-xs'>
              {t('Failed to copy to clipboard')}
            </p>
          )}
          <pre
            role='region'
            aria-label={props.command.command || t('Command history')}
            tabIndex={0}
            className='text-foreground-subtle focus-visible:outline-ring max-h-[55vh] min-w-0 overflow-auto px-4 pb-4 font-mono text-xs leading-5 break-words whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
          >
            {props.command.aggregatedOutput || t('No command output.')}
          </pre>
        </div>
      )}
    </article>
  )
}
