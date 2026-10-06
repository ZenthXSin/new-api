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
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  LoaderCircle,
  PauseCircle,
  Terminal,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Response } from '@/components/ai-elements/response'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { codexItemText } from '../lib/events'
import type {
  CodexApproval,
  CodexApprovalAnswer,
  CodexItem,
  CodexThread,
  CodexTurn,
} from '../types'
import { ApprovalCard } from './approval-card'

export function CodexConversation(props: {
  thread: CodexThread | null
  running: boolean
  approvals: CodexApproval[]
  onApprove: (id: string, answer: CodexApprovalAnswer) => Promise<void>
}) {
  const { t } = useTranslation()
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [showBottom, setShowBottom] = useState(false)
  const itemCount =
    props.thread?.turns.reduce((count, turn) => count + turn.items.length, 0) ??
    0
  useLayoutEffect(() => {
    follow.current = true
    setShowBottom(false)
    if (viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    }
  }, [props.thread?.id])
  useLayoutEffect(() => {
    if (follow.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    }
  }, [props.thread, props.approvals])
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // Markdown/code renderers and expanded tools can resize after a network
      // event. Follow only when the reader has not scrolled into older messages.
      if (follow.current && viewport.current) {
        viewport.current.scrollTop = viewport.current.scrollHeight
      }
    })
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [])
  function scrollToBottom() {
    follow.current = true
    setShowBottom(false)
    if (viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    }
  }
  return (
    <div className='relative min-h-0 min-w-0 flex-1'>
      <div
        ref={viewport}
        className='h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain'
        onScroll={() => {
          const node = viewport.current
          if (!node) return
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 90
          setShowBottom(!follow.current)
        }}
        aria-label={t('Task conversation')}
      >
        <div
          ref={content}
          className='mx-auto w-full max-w-3xl min-w-0 space-y-8 px-4 pt-5 pb-8 sm:px-7'
        >
          {itemCount === 0 && (
            <div className='mx-auto flex max-w-md flex-col items-center px-4 py-12 text-center'>
              <div className='bg-muted mb-4 flex size-10 items-center justify-center rounded-xl'>
                <Terminal
                  className='text-muted-foreground size-5'
                  aria-hidden
                />
              </div>
              <p className='text-sm font-medium'>
                {t('Your project is ready.')}
              </p>
              <p className='text-muted-foreground mt-2 text-sm leading-6'>
                {t('Describe a task, or import project files to get started.')}
              </p>
            </div>
          )}
          {props.thread?.turns.map((turn) => (
            <ConversationTurn
              key={turn.id}
              turn={turn}
              running={props.running && turn.status === 'inProgress'}
            />
          ))}
          {props.approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onApprove={props.onApprove}
            />
          ))}
          {props.running && props.approvals.length === 0 && (
            <div
              role='status'
              className='text-muted-foreground flex items-center gap-2.5 py-1 text-xs'
            >
              <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
              {t('Codex is working...')}
            </div>
          )}
        </div>
      </div>
      {showBottom && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='bg-background/95 absolute bottom-4 left-1/2 -translate-x-1/2 gap-2 rounded-full shadow-md backdrop-blur'
          aria-label={t('Scroll to latest message')}
          onClick={scrollToBottom}
        >
          <ArrowDown className='size-3.5' aria-hidden />
          {t('Latest message')}
        </Button>
      )}
    </div>
  )
}

function ConversationTurn({
  turn,
  running,
}: {
  turn: CodexTurn
  running: boolean
}) {
  const { t } = useTranslation()
  const blocks: { id: string; items: CodexItem[]; activity: boolean }[] = []
  for (const item of turn.items) {
    const activity = !['userMessage', 'agentMessage', 'plan'].includes(
      item.type
    )
    const last = blocks.at(-1)
    if (activity && last?.activity) last.items.push(item)
    else blocks.push({ id: item.id, items: [item], activity })
  }
  return (
    <section className='min-w-0 space-y-5' aria-label={t('Task turn')}>
      {blocks
        .filter((block) => block.items[0].type === 'userMessage')
        .map((block) => (
          <CodexMessage
            key={block.id}
            item={block.items[0]}
            running={running}
          />
        ))}
      {!!turn.plan?.length && (
        <details
          className='group/plan bg-muted/20 min-w-0 rounded-lg border'
          open={running}
        >
          <summary className='flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium'>
            <ChevronRight
              className='size-3.5 group-open/plan:rotate-90'
              aria-hidden
            />
            {t('Implementation plan')}
            <span className='text-muted-foreground ml-auto font-normal'>
              {turn.plan.filter((step) => step.status === 'completed').length} /{' '}
              {turn.plan.length}
            </span>
          </summary>
          <div className='border-t px-3 py-3'>
            {turn.planExplanation && (
              <p className='text-muted-foreground mb-3 text-xs leading-5'>
                {turn.planExplanation}
              </p>
            )}
            <ol className='space-y-2.5'>
              {turn.plan.map((step) => (
                <li
                  key={step.step}
                  className='flex items-start gap-2 text-sm leading-5'
                >
                  {step.status === 'completed' && (
                    <CheckCircle2
                      className='mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400'
                      aria-label={t('Completed')}
                    />
                  )}
                  {step.status === 'inProgress' && (
                    <LoaderCircle
                      className='mt-0.5 size-3.5 shrink-0 animate-spin'
                      aria-label={t('Running')}
                    />
                  )}
                  {step.status === 'pending' && (
                    <span
                      className='border-muted-foreground/50 mt-1 size-3 shrink-0 rounded-full border'
                      aria-label={t('Pending')}
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 break-words',
                      step.status === 'completed' && 'text-muted-foreground'
                    )}
                  >
                    {step.step}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}
      {blocks
        .filter((block) => block.items[0].type !== 'userMessage')
        .map((block) =>
          block.activity ? (
            <ExecutionSteps
              key={block.id}
              items={block.items}
              running={running}
            />
          ) : (
            <CodexMessage
              key={block.id}
              item={block.items[0]}
              running={running}
            />
          )
        )}
      {turn.status === 'completed' && (
        <p className='text-muted-foreground flex items-center gap-2 border-t pt-3 text-xs'>
          <CheckCircle2
            className='size-3.5 text-emerald-600 dark:text-emerald-400'
            aria-hidden
          />
          {t('Task completed')}
        </p>
      )}
      {turn.status === 'interrupted' && (
        <p className='text-muted-foreground bg-muted/50 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs'>
          <PauseCircle className='size-4 shrink-0' aria-hidden />
          {t('Task stopped. Send a message to continue.')}
        </p>
      )}
      {(turn.error?.message || turn.status === 'failed') && (
        <div
          role='alert'
          className='text-destructive border-destructive/20 bg-destructive/5 flex items-start gap-2 rounded-lg border p-3 text-sm'
        >
          <CircleAlert className='mt-0.5 size-4 shrink-0' aria-hidden />
          <div>
            <p className='font-medium'>{t('Task failed')}</p>
            {turn.error?.message && (
              <p className='mt-1 leading-6 break-words'>{turn.error.message}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function ExecutionSteps({
  items,
  running,
}: {
  items: CodexItem[]
  running: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const inProgress =
    running && items.some((item) => item.status === 'inProgress')
  const latest = items.at(-1)
  let summary: string | undefined
  if (latest?.type === 'commandExecution') summary = latest.command
  if (latest?.type === 'fileChange') {
    summary = latest.changes?.[0]?.path.split('/').at(-1)
  }
  const open = expanded ?? inProgress
  return (
    <div className='min-w-0'>
      <button
        type='button'
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        className='text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-full min-w-0 items-center gap-2 rounded-lg py-2 text-left text-xs outline-none focus-visible:ring-2'
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-90'
          )}
          aria-hidden
        />
        <span className='shrink-0 font-medium'>{t('Execution steps')}</span>
        <span className='bg-muted shrink-0 rounded px-1.5 py-0.5 text-[10px]'>
          {t('{{count}} steps', { count: items.length })}
        </span>
        {summary && !open && (
          <span className='min-w-0 truncate font-mono text-[11px]'>
            {summary}
          </span>
        )}
        {inProgress && (
          <LoaderCircle
            className='ml-auto size-3.5 shrink-0 animate-spin'
            aria-hidden
          />
        )}
      </button>
      {open && (
        <div className='ml-1.5 min-w-0 space-y-1.5 border-l pb-1 pl-3'>
          {items.map((item) => (
            <CodexMessage key={item.id} item={item} running={running} />
          ))}
        </div>
      )}
    </div>
  )
}

function CodexMessage(props: { item: CodexItem; running: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const item = props.item
  const content = codexItemText(item)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  async function copy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
    }
  }
  if (item.type === 'userMessage') {
    return (
      <div className='flex flex-col items-end gap-1.5 pt-1'>
        <span className='text-muted-foreground pr-1 text-[11px]'>
          {t('You')}
        </span>
        <div className='bg-muted/70 max-w-[94%] rounded-2xl rounded-tr-md px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] break-words whitespace-pre-wrap sm:max-w-[85%]'>
          {content}
        </div>
      </div>
    )
  }
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return (
      <article className='group min-w-0 space-y-2.5'>
        <div className='flex items-center gap-2 text-xs font-medium'>
          <Terminal className='size-3.5' aria-hidden />
          {item.type === 'plan' ? t('Implementation plan') : 'Codex'}
        </div>
        <Response
          final={!props.running || item.status === 'completed'}
          parserId={`codex-${item.id}`}
          className='max-w-full text-sm leading-7 [overflow-wrap:anywhere] [&_.cm-content]:min-h-0! [&_.cm-content]:font-mono! [&_.cm-editor]:min-h-0! [&_.cm-editor]:max-w-full [&_.cm-gutters]:py-0! [&_.cm-gutters]:font-mono! [&_.cm-scroller]:min-h-0! [&_.cm-scroller]:font-mono! [&_[style*="--code-editor-min-height"]]:min-h-0! [&_pre]:max-w-full [&_pre]:overflow-x-auto'
        >
          {content}
        </Response>
        {!!content && (
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              variant='ghost'
              size='icon-xs'
              className='text-muted-foreground size-8'
              aria-label={copied ? t('Copied') : t('Copy response')}
              onClick={() => void copy()}
            >
              {copied ? (
                <Check className='size-3.5' />
              ) : (
                <Copy className='size-3.5' />
              )}
            </Button>
            {copyFailed && (
              <span role='status' className='text-destructive text-xs'>
                {t('Copy failed')}
              </span>
            )}
          </div>
        )}
      </article>
    )
  }
  if (item.type === 'reasoning') {
    return (
      <details className='text-muted-foreground min-w-0 text-xs'>
        <summary className='cursor-pointer py-2'>
          {t('Reasoning summary')}
        </summary>
        <div className='min-w-0 pt-1 text-sm leading-6'>
          <Response
            final={!props.running}
            parserId={`reasoning-${item.id}`}
            className='[overflow-wrap:anywhere]'
          >
            {content || t('Thinking...')}
          </Response>
        </div>
      </details>
    )
  }
  if (item.type === 'commandExecution') {
    return (
      <details
        className='group/tool border-border/70 min-w-0 overflow-hidden rounded-lg border'
        open={item.status === 'inProgress'}
      >
        <summary className='hover:bg-muted/50 flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs'>
          <Terminal
            className='text-muted-foreground size-3.5 shrink-0'
            aria-hidden
          />
          <code className='min-w-0 flex-1 truncate'>
            {item.command || t('Command')}
          </code>
          <span
            className={cn(
              'shrink-0 text-[10px]',
              typeof item.exitCode === 'number' && item.exitCode !== 0
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {item.status === 'inProgress'
              ? t('Running')
              : t('Exit {{code}}', { code: item.exitCode ?? '—' })}
          </span>
          <ChevronRight
            className='text-muted-foreground size-3 shrink-0 group-open/tool:rotate-90'
            aria-hidden
          />
        </summary>
        {item.cwd && (
          <p className='text-muted-foreground border-t px-3 py-2 font-mono text-[10px] break-all'>
            {item.cwd}
          </p>
        )}
        <pre className='bg-muted/30 max-h-72 max-w-full overflow-auto border-t p-3 font-mono text-xs leading-5'>
          {item.aggregatedOutput || t('No command output.')}
        </pre>
      </details>
    )
  }
  if (item.type === 'fileChange') {
    return (
      <details className='group/tool border-border/70 min-w-0 overflow-hidden rounded-lg border'>
        <summary className='hover:bg-muted/50 flex min-h-10 min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs'>
          <FileCode2
            className='text-muted-foreground size-3.5 shrink-0'
            aria-hidden
          />
          <span className='shrink-0'>
            {t('Changed {{count}} files', { count: item.changes?.length ?? 0 })}
          </span>
          <span className='text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]'>
            {item.changes
              ?.map((change) => change.path.split('/').at(-1))
              .join(', ')}
          </span>
          <ChevronRight
            className='text-muted-foreground size-3 shrink-0 group-open/tool:rotate-90'
            aria-hidden
          />
        </summary>
        {item.changes?.map((change) => (
          <div className='min-w-0 border-t' key={change.path}>
            <p className='px-3 py-2 font-mono text-xs break-all'>
              {change.path}
            </p>
            {change.diff && (
              <pre className='bg-muted/20 max-h-72 max-w-full overflow-auto p-3 font-mono text-xs leading-5'>
                {change.diff}
              </pre>
            )}
          </div>
        ))}
      </details>
    )
  }
  if (item.type === 'contextCompaction') {
    return (
      <p className='text-muted-foreground py-2 text-xs'>
        {t('Conversation context compacted.')}
      </p>
    )
  }
  return (
    <details className='text-muted-foreground min-w-0 rounded-lg border px-3 py-2 text-xs'>
      <summary className='cursor-pointer'>
        {item.type === 'webSearch' ? t('Web search') : t('Tool activity')}
      </summary>
      <pre className='mt-2 max-h-64 max-w-full overflow-auto [overflow-wrap:anywhere] whitespace-pre-wrap'>
        {JSON.stringify(item, null, 2)}
      </pre>
    </details>
  )
}
