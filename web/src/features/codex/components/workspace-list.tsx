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
  ArrowLeft,
  CircleCheck,
  Clock3,
  FolderGit2,
  LoaderCircle,
  Plus,
  Search,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { isCodexBusy } from '../lib/events'
import type { CodexWorkspace } from '../types'

interface WorkspaceListProps {
  workspaces: CodexWorkspace[]
  selected?: string
  open: boolean
  onClose: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onBack: () => void
  loading?: boolean
}
export function WorkspaceList(props: WorkspaceListProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const drawer = useRef<HTMLElement>(null)
  const { open, onClose } = props
  useEffect(() => {
    if (!open || window.matchMedia('(min-width: 768px)').matches) return
    const previous = document.activeElement as HTMLElement | null
    drawer.current?.querySelector<HTMLButtonElement>('button')?.focus()
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = drawer.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input'
      )
      const first = controls?.[0]
      const last = controls ? [...controls].at(-1) : undefined
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      previous?.focus()
    }
  }, [open, onClose])
  const workspaces = props.workspaces
    .filter(
      (workspace) =>
        workspace.archived === archived &&
        workspace.name.toLowerCase().includes(search.trim().toLowerCase())
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  const groups = archived
    ? [{ label: t('Archived projects'), entries: workspaces }]
    : [
        {
          label: t('In progress'),
          entries: workspaces.filter((workspace) =>
            isCodexBusy(workspace.status)
          ),
        },
        {
          label: t('Recent projects'),
          entries: workspaces.filter(
            (workspace) => !isCodexBusy(workspace.status)
          ),
        },
      ]
  return (
    <>
      {props.open && (
        <button
          type='button'
          className='absolute inset-0 z-40 bg-black/35 md:hidden'
          onClick={props.onClose}
          aria-label={t('Close project list')}
          tabIndex={-1}
        />
      )}
      <aside
        ref={drawer}
        aria-label={t('Codex projects')}
        className={cn(
          'bg-muted/30 absolute inset-y-0 left-0 z-50 flex w-[min(300px,86vw)] shrink-0 flex-col border-r bg-background md:static md:z-auto md:flex md:w-60 lg:w-64',
          !props.open && 'hidden'
        )}
      >
        <div className='flex h-16 shrink-0 items-center gap-2.5 px-5'>
          <Terminal className='size-5' aria-hidden />
          <span className='text-base font-semibold tracking-tight'>Codex</span>
          <span className='text-muted-foreground rounded border px-1.5 py-0.5 text-[10px]'>
            {t('Admin')}
          </span>
          <Button
            type='button'
            size='icon-sm'
            variant='ghost'
            className='ml-auto size-10 md:hidden'
            aria-label={t('Close project list')}
            onClick={props.onClose}
          >
            <X />
          </Button>
        </div>
        <div className='space-y-3 px-3'>
          <Button
            type='button'
            variant='outline'
            className='bg-background h-10 w-full justify-start rounded-lg px-3 shadow-none'
            onClick={props.onNew}
          >
            <Plus className='size-4' />
            {t('New task')}
          </Button>
          <label className='focus-within:ring-ring/40 flex h-9 items-center gap-2 rounded-lg px-3 focus-within:ring-2'>
            <Search aria-hidden className='text-muted-foreground size-4' />
            <input
              aria-label={t('Search projects')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className='placeholder:text-muted-foreground w-full min-w-0 bg-transparent text-base outline-none md:text-sm'
              placeholder={t('Search projects')}
            />
            {!!search && (
              <button
                type='button'
                aria-label={t('Clear project search')}
                className='text-muted-foreground hover:text-foreground p-1'
                onClick={() => setSearch('')}
              >
                <X className='size-3.5' />
              </button>
            )}
          </label>
        </div>
        <div className='mt-4 flex items-center justify-between px-5'>
          <span className='text-muted-foreground text-xs font-medium'>
            {archived ? t('Archived projects') : t('Your projects')}
          </span>
          <Button
            type='button'
            size='icon-xs'
            variant='ghost'
            aria-pressed={archived}
            aria-label={t('Show archived projects')}
            onClick={() => setArchived(!archived)}
          >
            <Archive className='size-3.5' />
          </Button>
        </div>
        <nav className='min-h-0 flex-1 overflow-y-auto px-3 py-2'>
          {props.loading && (
            <p
              role='status'
              className='text-muted-foreground px-2 py-4 text-sm'
            >
              {t('Loading projects...')}
            </p>
          )}
          {!props.loading && workspaces.length === 0 && (
            <div className='text-muted-foreground px-2 py-6 text-sm leading-6'>
              <FolderGit2 className='mb-3 size-5' aria-hidden />
              <p>
                {search ? t('No matching projects.') : t('No projects yet.')}
              </p>
              {!search && !archived && (
                <p className='mt-2 text-xs'>
                  {t('Start a task or import a project to begin.')}
                </p>
              )}
            </div>
          )}
          {groups
            .filter((group) => group.entries.length > 0)
            .map((group) => (
              <section
                key={group.label}
                aria-label={group.label}
                className='mb-3'
              >
                {!archived && (
                  <h2 className='text-muted-foreground px-2 py-2 text-[11px] font-medium'>
                    {group.label}
                    <span className='ml-1.5 tabular-nums'>
                      {group.entries.length}
                    </span>
                  </h2>
                )}
                <div className='space-y-1'>
                  {group.entries.map((workspace) => (
                    <button
                      type='button'
                      key={workspace.id}
                      aria-current={
                        workspace.id === props.selected ? 'page' : undefined
                      }
                      title={workspace.name}
                      onClick={() => props.onSelect(workspace.id)}
                      className={cn(
                        'hover:bg-muted focus-visible:ring-ring/40 group flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2.5 text-left outline-none focus-visible:ring-2',
                        workspace.id === props.selected &&
                          'border-border/70 bg-background shadow-sm'
                      )}
                    >
                      <WorkspaceState status={workspace.status} />
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-sm font-medium'>
                          {workspace.name}
                        </span>
                        <span className='text-muted-foreground mt-1 flex items-center gap-2 text-xs'>
                          <span className='min-w-0 flex-1 truncate'>
                            {workspace.model || t('New project')}
                          </span>
                          <ProjectTime value={workspace.updatedAt} />
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
        </nav>
        <div className='border-border/60 border-t p-3'>
          <Button
            type='button'
            variant='ghost'
            className='h-10 w-full justify-start text-sm'
            onClick={props.onBack}
          >
            <ArrowLeft className='size-4' />
            {t('Back to dashboard')}
          </Button>
        </div>
      </aside>
    </>
  )
}
export function ProjectTime(props: { value: string | number }) {
  const { i18n } = useTranslation()
  const date = new Date(props.value)
  const elapsed = Math.max(0, Date.now() - date.getTime())
  if (!Number.isFinite(elapsed)) return null
  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let count = Math.floor(elapsed / 60_000)
  if (count >= 1440) {
    unit = 'day'
    count = Math.floor(count / 1440)
  } else if (count >= 60) {
    unit = 'hour'
    count = Math.floor(count / 60)
  }
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const locale =
    ({ zhCN: 'zh-CN', zhTW: 'zh-TW' } as Record<string, string>)[language] ||
    language
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(locale)}
      className='shrink-0 tabular-nums'
    >
      {new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto',
        style: 'narrow',
      }).format(-count, unit)}
    </time>
  )
}
function WorkspaceState(props: { status: string }) {
  const { t } = useTranslation()
  if (props.status === 'running' || props.status === 'starting') {
    return (
      <LoaderCircle
        className='mt-0.5 size-4 shrink-0 animate-spin text-emerald-700 dark:text-emerald-400'
        aria-label={t('Running')}
      />
    )
  }
  if (props.status === 'waiting_approval') {
    return (
      <Clock3
        className='mt-0.5 size-4 shrink-0 text-amber-600'
        aria-label={t('Waiting for approval')}
      />
    )
  }
  if (props.status === 'error') {
    return (
      <span
        className='bg-destructive mt-1.5 size-2 shrink-0 rounded-full'
        aria-label={t('Failed')}
      />
    )
  }
  if (props.status === 'idle') {
    return (
      <CircleCheck
        className='text-muted-foreground mt-0.5 size-4 shrink-0'
        aria-label={t('Ready')}
      />
    )
  }
  return <FolderGit2 className='text-muted-foreground mt-0.5 size-4 shrink-0' />
}
