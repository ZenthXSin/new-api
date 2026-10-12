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
  Clock3,
  Ellipsis,
  LoaderCircle,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { isCodexBusy } from '../lib/events'
import { Button } from '../vendor/zcode/button'
import type { CodexTaskListProps } from './codex-task-list'

export function SidebarTasks(
  props: CodexTaskListProps & { workspaceId?: string; conversationId?: string }
) {
  const { t } = useTranslation()
  const [archived, setArchived] = useState(false)
  const selectedArchived = props.tasks.find(
    (task) =>
      task.workspaceId === props.workspaceId &&
      task.conversationId === props.conversationId
  )?.archived
  useEffect(() => {
    if (selectedArchived !== undefined) setArchived(selectedArchived)
  }, [props.workspaceId, props.conversationId, selectedArchived])
  const tasks = props.tasks
    .filter((task) => task.archived === archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <section aria-label={t('Tasks')} className='codex-sidebar-tasks mt-2 pt-1'>
      <div className='flex min-h-8 items-center justify-between gap-2 px-3'>
        <h2 className='chatgpt-section-label text-muted-foreground text-xs font-medium'>
          {archived ? t('Archived tasks') : t('Recent tasks')}
        </h2>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          aria-label={t('Show archived tasks')}
          title={t('Show archived tasks')}
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          <Archive className='size-3.5' aria-hidden />
        </Button>
      </div>
      {props.loading && (
        <p
          role='status'
          className='text-muted-foreground flex items-center gap-2 px-3 py-3 text-xs'
        >
          <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
          {t('Loading tasks...')}
        </p>
      )}
      {props.error && (
        <div className='px-3 py-2 text-xs'>
          <p role='alert' className='text-destructive'>
            {t(props.error)}
          </p>
          <Button
            type='button'
            variant='ghost'
            size='xs'
            onClick={props.onRetry}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      {!props.loading && !props.error && tasks.length === 0 && (
        <p className='text-muted-foreground px-3 py-3 text-xs'>
          {archived
            ? t('No archived tasks.')
            : t('Your tasks will appear here.')}
        </p>
      )}
      {tasks.map((task) => {
        const selected =
          task.workspaceId === props.workspaceId &&
          task.conversationId === props.conversationId
        const busy = isCodexBusy(task.status)
        const actionDisabled = props.disabled || busy || task.workspaceArchived
        let StatusIcon = Circle
        let status = t('Ready')
        if (busy) {
          StatusIcon = LoaderCircle
          status = t('Running')
        }
        if (task.status === 'waiting_approval' || task.approvalCount > 0) {
          StatusIcon = Clock3
          status = t('Waiting for approval')
        } else if (!busy && task.latestTurnStatus === 'completed') {
          StatusIcon = Check
          status = t('Completed')
        } else if (
          task.status === 'error' ||
          task.latestTurnStatus === 'failed'
        ) {
          status = t('Failed')
        }
        return (
          <div
            key={task.id}
            className={`codex-sidebar-task-row group/task flex min-w-0 items-center rounded-lg ${selected ? 'bg-selected' : 'hover:bg-hover'}`}
          >
            <button
              type='button'
              aria-current={selected ? 'page' : undefined}
              aria-label={t('Open task {{title}}', { title: task.title })}
              title={`${task.title} · ${task.workspaceName}`}
              aria-description={`${task.workspaceName} · ${status}`}
              className='focus-visible:ring-ring flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-left outline-none focus-visible:ring-2 md:min-h-8'
              onClick={() =>
                props.onSelect(task.workspaceId, task.conversationId)
              }
            >
              <span className='min-w-0 flex-1 truncate text-sm'>
                {task.title}
              </span>
              {busy || status === t('Failed') ? (
                <StatusIcon
                  className={`size-3.5 shrink-0 ${busy && task.status !== 'waiting_approval' ? 'animate-spin' : ''}`}
                  aria-label={status}
                />
              ) : (
                <span className='sr-only'>{status}</span>
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-sm'
                    aria-label={t('Task options for {{title}}', {
                      title: task.title,
                    })}
                    className='mr-1 shrink-0 data-[popup-open]:opacity-100 md:opacity-0 md:group-focus-within/task:opacity-100 md:group-hover/task:opacity-100'
                  />
                }
              >
                <Ellipsis className='size-4' aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='end'
                className='codex-zcode codex-chatgpt chatgpt-popover'
              >
                <DropdownMenuItem
                  disabled={actionDisabled}
                  onClick={() => props.onRename(task)}
                >
                  <Pencil className='size-4' aria-hidden />
                  {t('Rename task')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actionDisabled}
                  onClick={() => props.onArchive(task)}
                >
                  {task.archived ? (
                    <ArchiveRestore className='size-4' aria-hidden />
                  ) : (
                    <Archive className='size-4' aria-hidden />
                  )}
                  {task.archived ? t('Restore task') : t('Archive task')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actionDisabled}
                  variant='destructive'
                  onClick={() => props.onDelete(task)}
                >
                  <Trash2 className='size-4' aria-hidden />
                  {t('Delete task')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })}
      {props.hasMore && (
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='text-muted-foreground mt-2 w-full text-xs'
          disabled={props.loadingMore}
          onClick={props.onLoadMore}
        >
          {t(props.loadingMore ? 'Loading tasks...' : 'Load more tasks')}
        </Button>
      )}
    </section>
  )
}
