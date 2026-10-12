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
  Archive,
  ArchiveRestore,
  Check,
  Circle,
  CircleAlert,
  Clock3,
  Ellipsis,
  LoaderCircle,
  Pause,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { isCodexBusy } from '../lib/events'
import type { CodexTask } from '../types'
import { Button } from '../vendor/zcode/button'

export interface CodexTaskListProps {
  tasks: CodexTask[]
  loading: boolean
  error?: string
  onRetry: () => void
  onSelect: (workspaceId: string, conversationId: string) => void
  onRename: (task: CodexTask) => void
  onArchive: (task: CodexTask) => void
  onDelete: (task: CodexTask) => void
  onSearch?: (query?: string) => void
  disabled?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
}

export function CodexTaskList(props: CodexTaskListProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('tasks')
  const [query, setQuery] = useState('')
  const search = query.trim().normalize('NFKC').toLocaleLowerCase()
  const tasks = props.tasks
    .filter(
      (task) =>
        task.archived === (tab === 'archive') &&
        task.title.normalize('NFKC').toLocaleLowerCase().includes(search)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <section className='codex-task-list min-w-0' aria-label={t('Tasks')}>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className='gap-0'
      >
        <div className='border-border flex min-w-0 flex-wrap items-center justify-between gap-x-4 border-b'>
          <TabsList
            activateOnFocus
            variant='line'
            className='codex-task-tabs h-12! gap-6 border-0! p-0'
            aria-label={t('Task view')}
          >
            <TabsTrigger
              value='tasks'
              className='codex-task-tab min-h-12 rounded-none border-0 px-0 py-3 after:hidden'
            >
              {t('Tasks')}
            </TabsTrigger>
            <TabsTrigger
              value='archive'
              className='codex-task-tab min-h-12 rounded-none border-0 px-0 py-3 after:hidden'
            >
              {t('Archive')}
            </TabsTrigger>
          </TabsList>
          <form
            role='search'
            aria-label={t('Search tasks')}
            className='codex-task-search bg-muted/50 mb-2 flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 sm:my-0 sm:max-w-64'
            onSubmit={(event) => {
              event.preventDefault()
              props.onSearch?.(query.trim())
            }}
          >
            <Search
              aria-hidden
              className='text-muted-foreground size-4 shrink-0'
            />
            <input
              type='search'
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('Search tasks')}
              placeholder={t('Search tasks')}
              className='placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-2 text-sm outline-none [&::-webkit-search-cancel-button]:hidden'
            />
            {query && (
              <button
                type='button'
                onClick={() => setQuery('')}
                aria-label={t('Clear task search')}
                className='text-muted-foreground hover:bg-hover focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2'
              >
                <X aria-hidden className='size-3.5' />
              </button>
            )}
            {props.onSearch && (
              <button
                type='submit'
                aria-label={t('Search all task messages')}
                title={t('Search all task messages')}
                className='text-muted-foreground hover:bg-hover focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2'
              >
                <Search aria-hidden className='size-4' />
              </button>
            )}
          </form>
        </div>
        <TabsContent value={tab} className='min-w-0'>
          {props.loading && (
            <div
              role='status'
              className='text-muted-foreground flex items-center gap-2 py-5 text-sm'
            >
              <LoaderCircle aria-hidden className='size-4 animate-spin' />
              {t('Loading tasks...')}
            </div>
          )}
          {props.error && (
            <div className='py-5'>
              <p role='alert' className='text-destructive text-sm'>
                {props.error}
              </p>
              <Button
                onClick={props.onRetry}
                disabled={props.loading}
                variant='outline'
                className='mt-3 min-h-9 px-3'
              >
                {t('Retry')}
              </Button>
            </div>
          )}
          {!props.loading && !props.error && tasks.length === 0 && (
            <div
              role='status'
              className='text-muted-foreground py-12 text-center text-sm'
            >
              {search
                ? t('No matching tasks.')
                : t(tab === 'archive' ? 'No archived tasks.' : 'No tasks yet.')}
            </div>
          )}
          {tasks.length > 0 && (
            <ul
              aria-label={t(tab === 'archive' ? 'Archived tasks' : 'Tasks')}
              aria-busy={props.loading || undefined}
            >
              {tasks.map((task) => (
                <CodexTaskRow
                  key={task.id}
                  task={task}
                  disabled={props.disabled}
                  onSelect={props.onSelect}
                  onRename={props.onRename}
                  onArchive={props.onArchive}
                  onDelete={props.onDelete}
                />
              ))}
            </ul>
          )}
          {props.hasMore && props.onLoadMore && (
            <div className='codex-task-load-more flex flex-col items-center gap-2 py-6'>
              {search && (
                <p className='text-muted-foreground text-center text-xs'>
                  {t(
                    'More tasks are available. Load more to search older titles.'
                  )}
                </p>
              )}
              <Button
                variant='outline'
                disabled={props.loading || props.loadingMore}
                onClick={props.onLoadMore}
                className='min-h-10 rounded-full px-5'
              >
                {props.loadingMore && (
                  <LoaderCircle aria-hidden className='size-4 animate-spin' />
                )}
                {t(props.loadingMore ? 'Loading tasks...' : 'Load more tasks')}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  )
}

function CodexTaskRow(
  props: Pick<
    CodexTaskListProps,
    'disabled' | 'onSelect' | 'onRename' | 'onArchive' | 'onDelete'
  > & { task: CodexTask }
) {
  const { t, i18n } = useTranslation()
  const task = props.task
  const mutationDisabled =
    !!props.disabled || task.workspaceArchived || isCodexBusy(task.status)
  const date = new Date(task.updatedAt)
  const validDate = Number.isFinite(date.getTime())
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const locale =
    ({ zhCN: 'zh-CN', zhTW: 'zh-TW' } as Record<string, string>)[language] ||
    language
  const elapsed = validDate ? Math.max(0, Date.now() - date.getTime()) : 0
  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let count = Math.floor(elapsed / 60_000)
  if (count >= 1440) {
    unit = 'day'
    count = Math.floor(count / 1440)
  } else if (count >= 60) {
    unit = 'hour'
    count = Math.floor(count / 60)
  }
  let status = t('Ready')
  let StatusIcon = Circle
  let statusClass = 'text-muted-foreground'
  if (task.status === 'waiting_approval' || task.approvalCount > 0) {
    status = t('Waiting for approval')
    StatusIcon = CircleAlert
    statusClass = 'text-amber-700 dark:text-amber-400'
  } else if (task.status === 'running' || task.status === 'starting') {
    status = t(task.status === 'starting' ? 'Starting' : 'Running')
    StatusIcon = LoaderCircle
  } else if (task.status === 'error' || task.latestTurnStatus === 'failed') {
    status = t('Failed')
    StatusIcon = CircleAlert
    statusClass = 'text-red-700 dark:text-red-400'
  } else if (
    task.status === 'interrupted' ||
    task.latestTurnStatus === 'interrupted'
  ) {
    status = t('Interrupted')
    StatusIcon = Pause
  } else if (task.queuedCount > 0) {
    status = t('Queued')
    StatusIcon = Clock3
  } else if (task.status === 'idle' && task.latestTurnStatus === 'completed') {
    status = t('Completed')
    StatusIcon = Check
  }

  return (
    <li className='codex-task-row group/task border-border hover:bg-muted/30 flex min-h-21 min-w-0 items-center gap-2 border-b py-4 sm:gap-4'>
      <button
        type='button'
        aria-label={t('Open task {{title}}', { title: task.title })}
        title={task.title}
        onClick={() => props.onSelect(task.workspaceId, task.conversationId)}
        className='codex-task-open focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2'
      >
        <span className='codex-task-title block truncate text-[15px] leading-6 font-medium'>
          {task.title}
        </span>
        <span className='codex-task-meta text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 text-[13px] leading-5'>
          {validDate && (
            <>
              <time
                className='shrink-0'
                dateTime={date.toISOString()}
                title={date.toLocaleString(locale)}
              >
                {elapsed < 60_000
                  ? t('Just now')
                  : new Intl.RelativeTimeFormat(locale, {
                      numeric: 'auto',
                      style: 'narrow',
                    }).format(-count, unit)}
              </time>
              <span aria-hidden>·</span>
            </>
          )}
          <span
            className='truncate'
            title={task.repository || task.workspaceName}
          >
            {task.repository || task.workspaceName}
          </span>
        </span>
      </button>
      <span
        className={`codex-task-status flex max-w-[32%] shrink-0 items-center gap-1.5 text-xs ${statusClass}`}
        title={status}
      >
        <StatusIcon
          aria-hidden
          className={`size-3.5 shrink-0 ${task.status === 'running' || task.status === 'starting' ? 'animate-spin' : ''}`}
        />
        <span className='truncate'>{status}</span>
      </span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              variant='ghost'
              size='icon-md'
              className='codex-task-menu size-9 shrink-0 rounded-full'
            />
          }
          aria-label={t('Task actions for {{title}}', { title: task.title })}
        >
          <Ellipsis aria-hidden className='size-4' />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          side='bottom'
          className='codex-zcode codex-web codex-chatgpt chatgpt-popover w-52 p-1.5'
        >
          <DropdownMenuItem
            disabled={props.disabled || task.workspaceArchived}
            onSelect={() => props.onRename(task)}
            className='min-h-10 gap-3 rounded-lg px-3'
          >
            <Pencil aria-hidden />
            {t('Rename task')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={mutationDisabled}
            onSelect={() => props.onArchive(task)}
            className='min-h-10 gap-3 rounded-lg px-3'
          >
            {task.conversationArchived ? (
              <ArchiveRestore aria-hidden />
            ) : (
              <Archive aria-hidden />
            )}
            {t(task.conversationArchived ? 'Restore task' : 'Archive task')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={mutationDisabled}
            variant='destructive'
            onSelect={() => props.onDelete(task)}
            className='min-h-10 gap-3 rounded-lg px-3'
          >
            <Trash2 aria-hidden />
            {t('Delete task')}
          </DropdownMenuItem>
          {task.workspaceArchived && (
            <p className='text-muted-foreground px-3 py-2 text-xs'>
              {t('Restore the project to manage this task.')}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
