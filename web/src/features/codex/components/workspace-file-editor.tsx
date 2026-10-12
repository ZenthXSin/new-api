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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  FileCode2,
  FileWarning,
  LoaderCircle,
  RotateCcw,
  Save,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { codexApi, codexError, downloadCodexFile } from '../api'
import type { CodexFile } from '../types'
import { Button } from '../vendor/zcode/button'
import { WorkspaceCodeEditor } from './workspace-code-editor'

export function WorkspaceFileEditor(props: {
  id: string
  actor: string
  path: string
  preview?: boolean
  initialLine?: number
  creating: boolean
  running: boolean
  readOnly?: boolean
  onBusy?: (busy: boolean) => void
  onBack: () => void
  onDirty?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const writeBlocked = props.running || props.readOnly || props.preview
  const onBusy = useRef(props.onBusy)
  onBusy.current = props.onBusy
  const [content, setContent] = useState('')
  const [hash, setHash] = useState<string | null>(null)
  const [baseline, setBaseline] = useState('')
  const [editing, setEditing] = useState(props.creating)
  const [reloading, setReloading] = useState(false)
  const loaded = useRef(false)
  const unsavedFile = props.creating && hash === null
  const tooLarge = useMemo(
    () => new TextEncoder().encode(content).byteLength > 1024 * 1024,
    [content]
  )
  const query = useQuery({
    queryKey: ['codex', props.actor, props.id, 'file', props.path],
    queryFn: ({ signal }) => codexApi.file(props.id, props.path, signal),
    enabled: !unsavedFile,
    staleTime: 0,
    retry: (failureCount, error) => {
      const status = isAxiosError(error) ? error.response?.status : undefined
      if (status && status >= 400 && status < 500) return false
      return failureCount < 2
    },
  })
  const dirty = content !== baseline || unsavedFile
  const fileData = unsavedFile ? undefined : query.data
  const incomplete = !!fileData?.binary || !!fileData?.truncated
  const segments = props.path.split('/')
  const filename = segments.at(-1) || props.path
  const onDirty = useRef(props.onDirty)
  onDirty.current = props.onDirty
  useEffect(() => {
    onDirty.current?.(dirty)
    return () => onDirty.current?.(false)
  }, [dirty])
  useEffect(() => {
    if (
      unsavedFile ||
      query.isError ||
      !query.data ||
      (loaded.current && dirty)
    ) {
      return
    }
    loaded.current = true
    setContent(query.data.content)
    setBaseline(query.data.content)
    setHash(query.data.hash)
  }, [query.data, query.isError, dirty, unsavedFile])
  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])
  const save = useMutation({
    mutationFn: () =>
      codexApi.save(props.id, {
        path: props.path,
        content,
        expectedHash: hash,
      }),
    onSuccess: (file: CodexFile) => {
      setHash(file.hash)
      setBaseline(file.content)
      setContent(file.content)
      loaded.current = true
      client.setQueryData(
        ['codex', props.actor, props.id, 'file', props.path],
        file
      )
      void client.invalidateQueries({
        queryKey: ['codex', props.actor, props.id, 'diff'],
      })
      void client.invalidateQueries({
        queryKey: ['codex', props.actor, props.id, 'files'],
      })
    },
  })
  const download = useMutation({
    mutationFn: async () => {
      const blob = dirty
        ? new Blob([content], { type: 'text/plain;charset=utf-8' })
        : await codexApi.download(props.id, props.path)
      downloadCodexFile(blob, filename)
    },
  })
  const operationBusy = save.isPending || reloading
  useEffect(() => {
    onBusy.current?.(operationBusy)
    return () => onBusy.current?.(false)
  }, [operationBusy])
  function back() {
    if (save.isPending || reloading) return
    if (!dirty || window.confirm(t('Discard unsaved file changes?'))) {
      props.onBack()
    }
  }
  const canSave =
    !writeBlocked &&
    !save.isPending &&
    dirty &&
    !query.isError &&
    !query.isLoading &&
    !reloading &&
    !incomplete &&
    !tooLarge
  async function reload() {
    if (save.isPending || reloading) return
    if (dirty && !window.confirm(t('Discard unsaved file changes?'))) return
    setReloading(true)
    try {
      const result = await query.refetch()
      if (result.data && !result.isError) {
        loaded.current = true
        setContent(result.data.content)
        setBaseline(result.data.content)
        setHash(result.data.hash)
        save.reset()
      }
    } finally {
      setReloading(false)
    }
  }
  let status = t('Read only')
  if (editing) status = t('Editing')
  if (dirty) status = t('Unsaved changes')
  if (save.isSuccess && !dirty) status = t('File saved.')
  if (writeBlocked || incomplete) status = t('Read only')
  if (query.isLoading || reloading) status = t('Loading file...')
  if (save.isPending) status = t('Saving...')
  if (query.isError && !loaded.current) status = t('Unable to open file')
  if (incomplete) status = t('Download available')
  return (
    <>
      <header className='bg-background border-border/60 shrink-0 border-b px-3 py-3'>
        <div className='flex min-w-0 items-center gap-1.5'>
          <Button
            type='button'
            size='icon-md'
            variant='ghost'
            className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2'
            aria-label={t('Back to files')}
            title={t('Back to files')}
            disabled={save.isPending || reloading}
            onClick={back}
          >
            <ArrowLeft className='size-4' aria-hidden />
          </Button>
          <nav
            className='min-w-0 flex-1 overflow-x-auto'
            aria-label={t('File path')}
            title={props.path}
          >
            <div className='text-muted-foreground flex w-max min-w-full items-center gap-1.5 py-1 text-xs'>
              {segments.slice(0, -1).map((segment, index) => (
                <Fragment key={segments.slice(0, index + 1).join('/')}>
                  <span>{segment}</span>
                  <ChevronRight className='size-3 shrink-0' aria-hidden />
                </Fragment>
              ))}
              <span
                className='text-foreground inline-flex items-center gap-1.5 font-medium'
                aria-current='page'
              >
                <FileCode2 className='size-4 shrink-0' aria-hidden />
                {filename}
              </span>
            </div>
          </nav>
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2'
            aria-label={t('Close file')}
            title={t('Close file')}
            disabled={save.isPending || reloading}
            onClick={back}
          >
            <X className='size-4' aria-hidden />
          </Button>
        </div>
        <div className='mt-2 flex items-center justify-end gap-2'>
          <Button
            type='button'
            size='sm'
            variant={editing ? 'secondary' : 'ghost'}
            className='focus-visible:ring-ring h-9 rounded-full px-3 text-xs focus-visible:ring-2'
            disabled={
              writeBlocked ||
              query.isError ||
              query.isLoading ||
              save.isPending ||
              reloading ||
              incomplete
            }
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            aria-label={t('Edit')}
          >
            {editing ? t('Done editing') : t('Edit')}
          </Button>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='focus-visible:ring-ring h-9 gap-1.5 rounded-full px-3 text-xs focus-visible:ring-2'
            aria-label={t('Download file')}
            title={t('Download file')}
            disabled={
              download.isPending ||
              query.isLoading ||
              (!fileData && !loaded.current && !props.creating)
            }
            onClick={() => download.mutate()}
          >
            {download.isPending ? (
              <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
            ) : (
              <Download className='size-3.5' aria-hidden />
            )}
            {download.isPending ? t('Downloading...') : t('Download')}
          </Button>
          <Button
            type='button'
            size='sm'
            className='bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-ring h-9 gap-1.5 rounded-full px-4 text-xs focus-visible:ring-2 focus-visible:ring-offset-2'
            disabled={!canSave}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
            ) : (
              <Save className='size-3.5' aria-hidden />
            )}
            {t('Save')}
          </Button>
        </div>
      </header>
      {props.readOnly && !props.preview && (
        <p className='text-foreground-subtle shrink-0 border-b px-4 py-3 text-xs'>
          {t('This task is read only. Restore it to edit files.')}
        </p>
      )}
      {props.running && !props.readOnly && (
        <p className='text-foreground-subtle shrink-0 border-b px-4 py-3 text-xs'>
          {t(
            'File editing is paused until your environment is available and idle.'
          )}
        </p>
      )}
      {query.isError && (
        <div
          role='alert'
          className='text-destructive flex items-start gap-3 border-b bg-red-500/5 p-4 text-sm'
        >
          <p className='min-w-0 flex-1 break-words'>
            {t(codexError(query.error))}
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void reload()}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      {incomplete && !query.isError && (
        <div
          role='status'
          className='text-muted-foreground flex min-h-48 flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-center text-sm'
        >
          <FileWarning className='size-10 shrink-0 opacity-60' aria-hidden />
          <p className='text-foreground max-w-full font-medium break-all'>
            {filename}
          </p>
          {fileData?.size !== undefined && (
            <p className='text-xs tabular-nums'>
              {(fileData.size / 1024 / 1024).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}{' '}
              MiB
            </p>
          )}
          <p>
            {fileData?.binary
              ? t('Binary files cannot be edited as text.')
              : t(
                  'This file is too large to preview. Download the original file.'
                )}
          </p>
          <Button
            type='button'
            size='sm'
            disabled={download.isPending}
            onClick={() => download.mutate()}
          >
            <Download className='size-3.5' aria-hidden />
            {download.isPending
              ? t('Downloading...')
              : t('Download original file')}
          </Button>
        </div>
      )}
      {download.isError && (
        <p
          role='alert'
          className='text-destructive shrink-0 px-4 py-3 text-sm break-words'
        >
          {t(codexError(download.error))}
        </p>
      )}
      {tooLarge && (
        <p
          role='alert'
          className='text-destructive shrink-0 border-b bg-amber-500/5 p-4 text-sm'
        >
          {t('File exceeds the 1 MiB editing limit')}
        </p>
      )}
      {save.isError && (
        <div
          role='alert'
          className='shrink-0 space-y-3 border-b bg-amber-500/5 p-4 text-sm'
        >
          <p className='text-destructive break-words'>
            {t(codexError(save.error))}
          </p>
          <p className='text-foreground-subtle text-xs'>
            {t(
              'Your edits are preserved. Download them before reloading a changed file.'
            )}
          </p>
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              onClick={() =>
                downloadCodexFile(
                  new Blob([content], { type: 'text/plain' }),
                  props.path.split('/').at(-1) || 'file.txt'
                )
              }
            >
              <Download className='size-3.5' aria-hidden />
              {t('Download edits')}
            </Button>
            {(!props.creating || hash !== null) && (
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='text-destructive'
                onClick={() => void reload()}
              >
                <RotateCcw className='size-3.5' aria-hidden />
                {t('Reload file')}
              </Button>
            )}
          </div>
        </div>
      )}
      {query.isLoading && (
        <p
          role='status'
          className='text-foreground-subtle flex items-center justify-center gap-2 p-10 text-sm'
        >
          <LoaderCircle className='size-4 animate-spin' aria-hidden />
          {t('Loading file...')}
        </p>
      )}
      {!query.isLoading &&
        (!query.isError || loaded.current) &&
        (!incomplete || dirty) && (
          <WorkspaceCodeEditor
            path={props.path}
            initialLine={props.initialLine}
            value={content}
            focusOnEdit={editing}
            onChange={setContent}
            onSave={() => {
              if (canSave) save.mutate()
            }}
            readOnly={
              !editing ||
              writeBlocked ||
              save.isPending ||
              reloading ||
              incomplete
            }
          />
        )}
      <div className='text-muted-foreground bg-background border-border/60 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-2 text-[11px]'>
        <span
          role='status'
          className={cn(
            'mr-auto flex min-h-6 items-center gap-1.5',
            dirty && 'text-amber-700 dark:text-amber-400'
          )}
        >
          {dirty && (
            <span className='size-1.5 rounded-full bg-current' aria-hidden />
          )}
          {save.isSuccess && !dirty && (
            <Check className='size-3.5' aria-hidden />
          )}
          {status}
        </span>
        {!query.isLoading &&
          (!query.isError || loaded.current) &&
          (!incomplete || dirty) && (
            <span className='tabular-nums'>
              {t('{{count}} lines', { count: content.split('\n').length })}
            </span>
          )}
        {!incomplete && !query.isError && <span>UTF-8</span>}
      </div>
    </>
  )
}
