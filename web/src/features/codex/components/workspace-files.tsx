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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { codexApi, codexError } from '../api'
import { WorkspaceFileEditor } from './workspace-file-editor'

export function WorkspaceFiles(props: {
  id: string
  actor: string
  running: boolean
  onDirty?: (dirty: boolean) => void
  initialPath?: string | null
  onPathConsumed?: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [directory, setDirectory] = useState('')
  const [selected, setSelected] = useState<string | null>(
    props.initialPath || null
  )
  useEffect(() => {
    if (props.initialPath) {
      setSelected(props.initialPath)
      props.onPathConsumed?.()
    }
  }, [props])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState('')
  const [filter, setFilter] = useState('')
  const files = useQuery({
    queryKey: ['codex', props.actor, props.id, 'files', directory],
    queryFn: ({ signal }) => codexApi.files(props.id, directory, signal),
  })
  async function refresh() {
    await client.invalidateQueries({
      queryKey: ['codex', props.actor, props.id, 'files'],
    })
  }
  if (selected !== null) {
    return (
      <WorkspaceFileEditor
        key={selected}
        id={props.id}
        actor={props.actor}
        path={selected}
        creating={creating}
        running={props.running}
        onDirty={props.onDirty}
        onBack={() => {
          setSelected(null)
          setCreating(false)
          setNewName('')
          void refresh()
        }}
      />
    )
  }
  const parent = directory.split('/').slice(0, -1).join('/')
  const entries = [...(files.data?.entries ?? [])]
    .filter((entry) =>
      entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
    )
    .sort((first, second) => {
      if (first.type !== second.type) return first.type === 'directory' ? -1 : 1
      return first.name.localeCompare(second.name)
    })
  return (
    <>
      <div className='shrink-0 space-y-3 border-b px-3 py-3 sm:px-4'>
        <div className='flex items-center gap-2'>
          {directory && (
            <Button
              type='button'
              size='icon-sm'
              variant='ghost'
              aria-label={t('Parent directory')}
              onClick={() => {
                setDirectory(parent)
                setFilter('')
              }}
            >
              <ArrowLeft className='size-4' aria-hidden />
            </Button>
          )}
          <div className='min-w-0 flex-1'>
            <p className='text-sm font-medium'>{t('Project files')}</p>
            <code
              className='text-muted-foreground mt-0.5 block truncate text-xs'
              title={directory || '/'}
            >
              {directory || '/'}
            </code>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            aria-label={t('Refresh files')}
            title={t('Refresh files')}
            disabled={files.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={cn('size-4', files.isFetching && 'animate-spin')}
              aria-hidden
            />
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-9'
            aria-label={t('New file')}
            disabled={props.running}
            onClick={() => {
              setCreating(!creating)
              setNameError('')
            }}
          >
            <FilePlus2 className='size-4' aria-hidden />
            {t('New file')}
          </Button>
        </div>
        <div className='relative'>
          <Search
            className='text-muted-foreground absolute top-2.5 left-3 size-4'
            aria-hidden
          />
          <Input
            aria-label={t('Filter files')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className='h-9 pl-9 text-base md:text-sm'
            placeholder={t('Filter files')}
          />
        </div>
      </div>
      {creating && (
        <form
          className='bg-muted/25 shrink-0 space-y-2 border-b p-3 sm:p-4'
          onSubmit={(event) => {
            event.preventDefault()
            if (props.running) return
            const value = newName.trim()
            if (
              !value ||
              value.length > 1000 ||
              value.includes('\\') ||
              value
                .split('/')
                .some(
                  (part) =>
                    !part || part === '.' || part === '..' || part === '.git'
                )
            ) {
              setNameError(
                'Use a relative file path without empty, dot, or parent segments.'
              )
              return
            }
            setNameError('')
            setSelected([directory, value].filter(Boolean).join('/'))
          }}
        >
          <label htmlFor='codex-new-file-path' className='text-sm font-medium'>
            {t('New file path')}
          </label>
          <div className='flex items-center gap-2'>
            <Input
              id='codex-new-file-path'
              autoFocus
              aria-invalid={!!nameError}
              aria-describedby={nameError ? 'codex-new-file-error' : undefined}
              className='h-10 min-w-0 flex-1 text-base md:text-sm'
              placeholder='src/example.ts'
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value)
                setNameError('')
              }}
              disabled={props.running}
            />
            <Button
              type='submit'
              size='sm'
              className='h-10'
              disabled={!newName.trim() || props.running}
            >
              {t('Create')}
            </Button>
            <Button
              type='button'
              variant='ghost'
              size='icon-sm'
              aria-label={t('Cancel')}
              onClick={() => setCreating(false)}
            >
              <X className='size-4' aria-hidden />
            </Button>
          </div>
          {nameError && (
            <p
              id='codex-new-file-error'
              role='alert'
              className='text-destructive text-xs'
            >
              {t(nameError)}
            </p>
          )}
        </form>
      )}
      {props.running && (
        <p className='text-muted-foreground shrink-0 border-b px-4 py-3 text-xs'>
          {t(
            'File editing is paused until your environment is available and idle.'
          )}
        </p>
      )}
      {files.isLoading && (
        <p
          role='status'
          className='text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm'
        >
          <LoaderCircle className='size-4 animate-spin' aria-hidden />
          {t('Loading files...')}
        </p>
      )}
      {files.isError && (
        <div
          role='alert'
          className='text-destructive flex items-start gap-3 border-b bg-red-500/5 p-4 text-sm'
        >
          <p className='min-w-0 flex-1 break-words'>
            {t(codexError(files.error))}
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void files.refetch()}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      <div className='min-h-0 min-w-0 flex-1 overflow-auto p-2 sm:p-3'>
        {!files.isLoading &&
          !files.isError &&
          files.data?.entries.length === 0 && (
            <div className='text-muted-foreground flex h-full min-h-52 flex-col items-center justify-center gap-3 p-6 text-center text-sm'>
              <span className='bg-muted rounded-2xl p-4'>
                <Folder className='size-6' aria-hidden />
              </span>
              <p>{t('This folder is empty.')}</p>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={props.running}
                onClick={() => setCreating(true)}
              >
                <FilePlus2 className='size-4' aria-hidden />
                {t('Create a file')}
              </Button>
            </div>
          )}
        {!!files.data?.entries.length && entries.length === 0 && (
          <p className='text-muted-foreground p-8 text-center text-sm'>
            {t('No matching files.')}
          </p>
        )}
        {entries.map((entry) => (
          <button
            type='button'
            key={entry.path}
            title={entry.path}
            className='hover:bg-muted focus-visible:bg-muted flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset'
            onClick={() => {
              if (entry.type === 'directory') {
                setDirectory(entry.path)
                setFilter('')
                setCreating(false)
              } else {
                setCreating(false)
                setSelected(entry.path)
              }
            }}
          >
            {entry.type === 'directory' ? (
              <Folder
                className='text-muted-foreground size-4 shrink-0'
                aria-hidden
              />
            ) : (
              <File
                className='text-muted-foreground size-4 shrink-0'
                aria-hidden
              />
            )}
            <span className='min-w-0 flex-1 truncate'>{entry.name}</span>
            {entry.type === 'directory' ? (
              <ChevronRight
                className='text-muted-foreground size-4 shrink-0'
                aria-hidden
              />
            ) : (
              <span className='text-muted-foreground shrink-0 text-xs'>
                {entry.size < 1024
                  ? `${entry.size} B`
                  : `${(entry.size / 1024).toFixed(1)} KB`}
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}
