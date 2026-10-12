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
import { useQueries } from '@tanstack/react-query'
import { Archive, ArchiveRestore, LoaderCircle, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'

import { codexApi, codexError } from '../api'
import { isCodexBusy } from '../lib/events'
import type { CodexWorkspace } from '../types'
import { Button } from '../vendor/zcode/button'

export type BulkManagementResult = {
  deletedProjects: string[]
  deletedConversations: {
    workspaceId: string
    conversationId: string
    replacementId: string
  }[]
}
type BulkItem = {
  key: string
  name: string
  workspaceId: string
  conversationId?: string
  archived: boolean
  disabled: boolean
}
type Operation = 'archive' | 'restore' | 'delete'

export function BulkManagement(props: {
  actor: string
  workspaces: CodexWorkspace[]
  blocked?: boolean
  beforeChange?: () => boolean
  onBusyChange?: (busy: boolean) => void
  isCurrentActor?: () => boolean
  onComplete: (result: BulkManagementResult) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [section, setSection] = useState<'projects' | 'conversations'>(
    'projects'
  )
  const [filter, setFilter] = useState('')
  const [archiveFilter, setArchiveFilter] = useState<
    'active' | 'archived' | 'all'
  >('active')
  const [selected, setSelected] = useState<string[]>([])
  const [working, setWorking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [failures, setFailures] = useState<string[]>([])
  const [progress, setProgress] = useState<{
    completed: number
    total: number
  } | null>(null)
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const histories = useQueries({
    queries: props.workspaces.map((workspace) => ({
      queryKey: ['codex', props.actor, 'conversations', workspace.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        codexApi.conversations(workspace.id, signal),
      enabled: section === 'conversations',
      staleTime: 0,
      retry: 1,
    })),
  })
  const items: BulkItem[] = props.workspaces.flatMap((workspace, index) => {
    const disabled = !!props.blocked || isCodexBusy(workspace.status)
    if (section === 'projects') {
      return [
        {
          key: workspace.id,
          name: workspace.name,
          workspaceId: workspace.id,
          archived: workspace.archived,
          disabled,
        },
      ]
    }
    return (histories[index]?.data?.conversations ?? []).map(
      (conversation) => ({
        key: `${workspace.id}/${conversation.id}`,
        name: `${workspace.name} / ${conversation.customName ? conversation.name : t(conversation.name)}`,
        workspaceId: workspace.id,
        conversationId: conversation.id,
        archived: !!conversation.archived,
        disabled:
          disabled || workspace.archived || isCodexBusy(conversation.status),
      })
    )
  })
  const query = filter.trim().toLocaleLowerCase()
  const visible = items.filter(
    (item) =>
      item.name.toLocaleLowerCase().includes(query) &&
      (archiveFilter === 'all' ||
        item.archived === (archiveFilter === 'archived'))
  )
  const eligible = visible.filter((item) => !item.disabled)
  const selectedItems = visible.filter(
    (item) => selected.includes(item.key) && !item.disabled
  )
  const loading =
    section === 'conversations' &&
    histories.some((history) => history.isLoading)
  const historyErrors =
    section === 'conversations' && histories.some((history) => history.isError)
  const allSelected =
    eligible.length > 0 && eligible.every((item) => selected.includes(item.key))

  function clearSelection() {
    setSelected([])
    setConfirmDelete(false)
    setFailures([])
    setProgress(null)
  }
  async function apply(operation: Operation) {
    if (
      locked.current ||
      !selectedItems.length ||
      props.beforeChange?.() === false
    ) {
      return
    }
    locked.current = true
    setWorking(true)
    props.onBusyChange?.(true)
    setConfirmDelete(false)
    setFailures([])
    const targets = selectedItems.filter(
      (item) =>
        operation === 'delete' || item.archived === (operation === 'restore')
    )
    const result: BulkManagementResult = {
      deletedProjects: [],
      deletedConversations: [],
    }
    const successful = new Set<string>()
    const errors: string[] = []
    setProgress({ completed: 0, total: targets.length })
    try {
      for (const item of targets) {
        if (!mounted.current || props.isCurrentActor?.() === false) break
        try {
          if (item.conversationId) {
            if (operation === 'delete') {
              const response = await codexApi.deleteConversation(
                item.workspaceId,
                item.conversationId
              )
              result.deletedConversations.push({
                workspaceId: item.workspaceId,
                conversationId: item.conversationId,
                replacementId: response.conversationId,
              })
            } else {
              await codexApi.updateConversation(
                item.workspaceId,
                item.conversationId,
                { archived: operation === 'archive' }
              )
            }
          } else if (operation === 'delete') {
            await codexApi.remove(item.workspaceId)
            result.deletedProjects.push(item.workspaceId)
          } else {
            await codexApi.update(item.workspaceId, {
              archived: operation === 'archive',
            })
          }
          successful.add(item.key)
        } catch (error) {
          errors.push(`${item.name}: ${t(codexError(error))}`)
        }
        if (mounted.current) {
          setProgress({
            completed: successful.size + errors.length,
            total: targets.length,
          })
        }
      }
      if (mounted.current && props.isCurrentActor?.() !== false) {
        setSelected((keys) => keys.filter((key) => !successful.has(key)))
        setFailures(errors)
        await props.onComplete(result)
      }
    } finally {
      locked.current = false
      if (mounted.current) {
        setWorking(false)
        props.onBusyChange?.(false)
      }
    }
  }
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-4'>
      <div
        className='bg-muted flex gap-1 rounded-xl p-1'
        role='group'
        aria-label={t('Manage items')}
      >
        {(['projects', 'conversations'] as const).map((value) => (
          <Button
            key={value}
            variant={section === value ? 'secondary' : 'ghost'}
            className='min-h-10 flex-1 rounded-lg'
            disabled={working}
            aria-pressed={section === value}
            onClick={() => {
              setSection(value)
              clearSelection()
            }}
          >
            {t(value === 'projects' ? 'Projects' : 'Conversations')}
          </Button>
        ))}
      </div>
      <div className='flex flex-wrap gap-2'>
        <Input
          aria-label={t('Filter items')}
          placeholder={t('Search projects and conversations')}
          value={filter}
          disabled={working}
          className='min-w-0 flex-1 basis-48'
          onChange={(event) => {
            setFilter(event.target.value)
            clearSelection()
          }}
        />
        <select
          aria-label={t('Archive filter')}
          value={archiveFilter}
          disabled={working}
          className='border-border bg-background min-h-10 rounded-lg border px-3 text-sm'
          onChange={(event) => {
            setArchiveFilter(event.target.value as typeof archiveFilter)
            clearSelection()
          }}
        >
          <option value='active'>{t('Not archived')}</option>
          <option value='archived'>{t('Archived')}</option>
          <option value='all'>{t('All items')}</option>
        </select>
      </div>
      <div className='text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-sm'>
        <label className='flex min-h-10 cursor-pointer items-center gap-2'>
          <input
            type='checkbox'
            aria-label={t('Select all visible items')}
            className='accent-foreground size-4'
            disabled={working || eligible.length === 0}
            checked={allSelected}
            onChange={() => {
              setSelected(allSelected ? [] : eligible.map((item) => item.key))
              setConfirmDelete(false)
            }}
          />
          {t('Select all')}
        </label>
        <span role='status'>
          {t('{{count}} selected', { count: selectedItems.length })}
        </span>
      </div>
      {props.blocked && (
        <p className='text-muted-foreground text-sm'>
          {t('Wait for the active task to finish before managing items.')}
        </p>
      )}
      {loading && (
        <p
          role='status'
          className='text-muted-foreground flex items-center gap-2 text-sm'
        >
          <LoaderCircle className='size-4 animate-spin' aria-hidden />
          {t('Loading conversations...')}
        </p>
      )}
      {historyErrors && (
        <div role='alert' className='text-destructive text-sm'>
          {t('Some conversations could not be loaded.')}{' '}
          <Button
            variant='ghost'
            disabled={working}
            onClick={() => {
              for (const history of histories) {
                if (history.isError) void history.refetch()
              }
            }}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      <div
        className='border-border min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border'
        role='group'
        aria-label={t('Items to manage')}
      >
        {visible.map((item) => (
          <label
            key={item.key}
            className={`border-border hover:bg-accent flex min-h-12 items-center gap-3 border-b px-3 py-2 last:border-b-0 ${item.disabled ? 'opacity-50' : 'cursor-pointer'}`}
          >
            <input
              type='checkbox'
              aria-label={t('Select {{name}}', {
                name: item.name,
                interpolation: { escapeValue: false },
              })}
              className='accent-foreground size-4 shrink-0'
              checked={selected.includes(item.key)}
              disabled={working || item.disabled}
              onChange={() => {
                setSelected((keys) =>
                  keys.includes(item.key)
                    ? keys.filter((key) => key !== item.key)
                    : [...keys, item.key]
                )
                setConfirmDelete(false)
              }}
            />
            <span className='min-w-0 flex-1 text-sm break-words'>
              {item.name}
            </span>
            {item.archived && (
              <Archive
                className='text-muted-foreground size-4 shrink-0'
                aria-label={t('Archived')}
              />
            )}
          </label>
        ))}
        {!visible.length && !loading && (
          <p className='text-muted-foreground p-6 text-center text-sm'>
            {t('No matching items.')}
          </p>
        )}
      </div>
      {progress && (
        <p role='status' className='text-muted-foreground text-sm'>
          {t('Processed {{completed}} of {{total}}', progress)}
        </p>
      )}
      {failures.length > 0 && (
        <div
          role='alert'
          className='text-destructive max-h-28 overflow-y-auto text-sm'
        >
          <p>{t('Failed items remain selected. You can retry them.')}</p>
          {failures.map((failure) => (
            <p key={failure} className='mt-1 break-words'>
              {failure}
            </p>
          ))}
        </div>
      )}
      {confirmDelete ? (
        <div className='border-destructive/30 bg-destructive/5 rounded-xl border p-3'>
          <p className='text-sm'>
            {t(
              section === 'projects'
                ? 'Delete {{count}} projects and their files and conversations? This cannot be undone.'
                : 'Delete {{count}} conversations and their history? Project files are kept.',
              { count: selectedItems.length }
            )}
          </p>
          <div className='mt-3 flex justify-end gap-2'>
            <Button variant='ghost' onClick={() => setConfirmDelete(false)}>
              {t('Cancel')}
            </Button>
            <Button variant='destructive' onClick={() => void apply('delete')}>
              {t('Confirm deletion')}
            </Button>
          </div>
        </div>
      ) : (
        <div className='flex flex-wrap gap-2'>
          <Button
            variant='secondary'
            disabled={working || !selectedItems.some((item) => !item.archived)}
            onClick={() => void apply('archive')}
          >
            <Archive className='size-4' aria-hidden />
            {t('Archive selected')}
          </Button>
          <Button
            variant='secondary'
            disabled={working || !selectedItems.some((item) => item.archived)}
            onClick={() => void apply('restore')}
          >
            <ArchiveRestore className='size-4' aria-hidden />
            {t('Restore selected')}
          </Button>
          <Button
            variant='destructive'
            disabled={working || !selectedItems.length}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className='size-4' aria-hidden />
            {t('Delete selected')}
          </Button>
        </div>
      )}
    </div>
  )
}
