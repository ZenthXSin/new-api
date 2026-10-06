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
import {
  ArrowLeft,
  Check,
  Download,
  FileCode2,
  LoaderCircle,
  RotateCcw,
  Save,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { codexApi, codexError, downloadCodexFile } from '../api'
import type { CodexFile } from '../types'
import { WorkspaceCodeEditor } from './workspace-code-editor'

export function WorkspaceFileEditor(props: {
  id: string
  actor: string
  path: string
  creating: boolean
  running: boolean
  onBack: () => void
  onDirty?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [content, setContent] = useState('')
  const [hash, setHash] = useState<string | null>(null)
  const [baseline, setBaseline] = useState('')
  const [editing, setEditing] = useState(props.creating)
  const loaded = useRef(false)
  const query = useQuery({
    queryKey: ['codex', props.actor, props.id, 'file', props.path],
    queryFn: ({ signal }) => codexApi.file(props.id, props.path, signal),
    enabled: !props.creating,
    staleTime: 0,
  })
  const dirty = content !== baseline || (props.creating && hash === null)
  const onDirty = useRef(props.onDirty)
  onDirty.current = props.onDirty
  useEffect(() => {
    onDirty.current?.(dirty)
    return () => onDirty.current?.(false)
  }, [dirty])
  useEffect(() => {
    if (query.data && !loaded.current) {
      loaded.current = true
      setContent(query.data.content)
      setBaseline(query.data.content)
      setHash(query.data.hash)
    }
  }, [query.data])
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
    },
  })
  function back() {
    if (!dirty || window.confirm(t('Discard unsaved file changes?'))) {
      props.onBack()
    }
  }
  const canSave =
    !props.running &&
    !save.isPending &&
    dirty &&
    !query.isError &&
    !query.isLoading
  async function reload() {
    if (dirty && !window.confirm(t('Discard unsaved file changes?'))) return
    const result = await query.refetch()
    if (result.data) {
      loaded.current = true
      setContent(result.data.content)
      setBaseline(result.data.content)
      setHash(result.data.hash)
      save.reset()
    }
  }
  let status = t('Read only')
  if (editing) status = t('Editing')
  if (dirty) status = t('Unsaved changes')
  if (save.isSuccess && !dirty) status = t('File saved.')
  return (
    <>
      <div className='shrink-0 border-b px-3 py-3 sm:px-4'>
        <div className='flex min-w-0 items-start gap-2'>
          <Button
            type='button'
            size='icon-sm'
            variant='ghost'
            aria-label={t('Back to files')}
            disabled={save.isPending}
            onClick={back}
          >
            <ArrowLeft className='size-4' aria-hidden />
          </Button>
          <FileCode2
            className='text-muted-foreground mt-2 size-4 shrink-0'
            aria-hidden
          />
          <div className='min-w-0 flex-1 py-1'>
            <p className='text-sm font-medium break-all'>
              {props.path.split('/').at(-1)}
            </p>
            <code
              className='text-muted-foreground mt-1 block truncate text-xs'
              title={props.path}
            >
              {props.path}
            </code>
          </div>
        </div>
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <span
            role='status'
            className={cn(
              'mr-auto flex min-h-8 items-center gap-1.5 text-xs',
              dirty
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground'
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
          <Button
            type='button'
            size='sm'
            variant={editing ? 'secondary' : 'outline'}
            className='h-9'
            disabled={
              props.running ||
              query.isError ||
              query.isLoading ||
              save.isPending
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
            className='h-9'
            disabled={!canSave}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
            ) : (
              <Save className='size-4' aria-hidden />
            )}
            {t('Save')}
          </Button>
        </div>
      </div>
      {props.running && (
        <p className='text-muted-foreground shrink-0 border-b px-4 py-3 text-xs'>
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
      {save.isError && (
        <div
          role='alert'
          className='shrink-0 space-y-3 border-b bg-amber-500/5 p-4 text-sm'
        >
          <p className='text-destructive break-words'>
            {t(codexError(save.error))}
          </p>
          <p className='text-muted-foreground text-xs'>
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
            {!props.creating && (
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
          className='text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm'
        >
          <LoaderCircle className='size-4 animate-spin' aria-hidden />
          {t('Loading file...')}
        </p>
      )}
      {!query.isLoading && !query.isError && (
        <WorkspaceCodeEditor
          path={props.path}
          value={content}
          onChange={setContent}
          onSave={() => {
            if (canSave) save.mutate()
          }}
          readOnly={!editing || props.running || save.isPending}
        />
      )}
      <div className='text-muted-foreground flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs'>
        <span>
          {t('{{count}} lines', { count: content.split('\n').length })}
        </span>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          onClick={() =>
            downloadCodexFile(
              new Blob([content], { type: 'text/plain' }),
              props.path.split('/').at(-1) || 'file.txt'
            )
          }
          disabled={query.isLoading || query.isError}
        >
          <Download className='size-3.5' aria-hidden />
          {t('Download file')}
        </Button>
      </div>
    </>
  )
}
