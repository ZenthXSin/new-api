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
  FileCode2,
  FilePlus2,
  Folder,
  LoaderCircle,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react'
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { cn } from '@/features/codex/vendor/zcode/utils'

import { codexApi, codexError } from '../api'
import { Button } from '../vendor/zcode/button'

const WorkspaceFileEditor = lazy(() =>
  import('./workspace-file-editor').then((module) => ({
    default: module.WorkspaceFileEditor,
  }))
)

export function WorkspaceFiles(props: {
  id: string
  actor: string
  running: boolean
  readOnly?: boolean
  onBusy?: (busy: boolean) => void
  onDirty?: (dirty: boolean) => void
  initialPath?: string | null
  onPathConsumed?: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const writeBlocked = props.running || props.readOnly
  const uploadBusy = useRef(false)
  const editorBusy = useRef(false)
  const onBusy = useRef(props.onBusy)
  onBusy.current = props.onBusy
  useEffect(() => () => onBusy.current?.(false), [])
  const inputId = useId()
  const dirty = useRef(false)
  const requestedPath = useRef<string | null>(null)
  const focusPath = useRef<string | null>(null)
  const fileList = useRef<HTMLUListElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const [directory, setDirectory] = useState(
    () => props.initialPath?.split('/').slice(0, -1).join('/') || ''
  )
  const [selected, setSelected] = useState<string | null>(
    props.initialPath || null
  )
  useEffect(() => {
    const nextPath = props.initialPath || null
    if (requestedPath.current === nextPath) return
    requestedPath.current = nextPath
    if (!nextPath) return
    if (
      nextPath !== selected &&
      dirty.current &&
      !window.confirm(t('Discard unsaved file changes?'))
    ) {
      props.onPathConsumed?.()
      return
    }
    if (nextPath !== selected) {
      setCreating(false)
      setDirectory(nextPath.split('/').slice(0, -1).join('/'))
      setFilter('')
      setSelected(nextPath)
    }
    props.onPathConsumed?.()
  }, [props, selected, t])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [nameError, setNameError] = useState('')
  const [filter, setFilter] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadLocked = useRef(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadedPaths, setUploadedPaths] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const files = useQuery({
    queryKey: ['codex', props.actor, props.id, 'files', directory],
    queryFn: ({ signal }) => codexApi.files(props.id, directory, signal),
  })
  useEffect(() => {
    if (selected !== null || !focusPath.current || files.isFetching) return
    const row = [
      ...(fileList.current?.querySelectorAll<HTMLButtonElement>(
        '[data-zcode-file-row]'
      ) ?? []),
    ].find((entry) => entry.dataset.zcodeFileRow === focusPath.current)
    if (row) row.focus()
    else filterInput.current?.focus()
    focusPath.current = null
  }, [selected, files.data, files.isFetching])
  async function refresh() {
    await client.invalidateQueries({
      queryKey: ['codex', props.actor, props.id, 'files'],
    })
  }
  async function uploadFiles(selectedFiles: File[]) {
    if (writeBlocked || uploadLocked.current || !selectedFiles.length) return
    uploadLocked.current = true
    uploadBusy.current = true
    onBusy.current?.(true)
    setUploading(true)
    setUploadError('')
    setUploadedPaths([])
    const uploaded: string[] = []
    const errors: string[] = []
    try {
      for (const file of selectedFiles) {
        if (file.size > 25 * 1024 * 1024) {
          errors.push(
            `${file.name}: ${t('The file exceeds the upload limit.')}`
          )
          continue
        }
        try {
          const result = await codexApi.upload(
            props.id,
            [directory, file.name].filter(Boolean).join('/'),
            file
          )
          uploaded.push(result.path)
        } catch (error) {
          errors.push(`${file.name}: ${t(codexError(error))}`)
        }
      }
      setUploadedPaths(uploaded)
      setUploadError(errors.join('\n'))
      if (uploaded.length) {
        await Promise.all([
          refresh(),
          client.invalidateQueries({
            queryKey: ['codex', props.actor, props.id, 'diff'],
          }),
        ])
      }
    } finally {
      uploadLocked.current = false
      uploadBusy.current = false
      onBusy.current?.(editorBusy.current)
      setUploading(false)
    }
  }
  if (selected !== null) {
    return (
      <Suspense
        fallback={
          <p role='status' className='text-muted-foreground p-4 text-sm'>
            {t('Loading file...')}
          </p>
        }
      >
        <WorkspaceFileEditor
          key={selected}
          id={props.id}
          actor={props.actor}
          path={selected}
          creating={creating}
          running={props.running}
          readOnly={props.readOnly}
          onBusy={(value) => {
            editorBusy.current = value
            onBusy.current?.(value || uploadBusy.current)
          }}
          onDirty={(value) => {
            dirty.current = value
            props.onDirty?.(value)
          }}
          onBack={() => {
            focusPath.current = selected
            setSelected(null)
            setCreating(false)
            setNewName('')
            void refresh()
          }}
        />
      </Suspense>
    )
  }
  const segments = directory.split('/').filter(Boolean)
  const parent = segments.slice(0, -1).join('/')
  const entries = [...(files.data?.entries ?? [])]
    .filter((entry) =>
      entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
    )
    .sort((first, second) => {
      if (first.type !== second.type) return first.type === 'directory' ? -1 : 1
      return first.name.localeCompare(second.name)
    })
  return (
    <div
      role='group'
      aria-label={t('Project files')}
      className='bg-background relative flex min-h-0 min-w-0 flex-1 flex-col'
      onDragOver={(event) => {
        event.preventDefault()
        if (
          !writeBlocked &&
          !uploading &&
          [...event.dataTransfer.types].includes('Files')
        ) {
          setDragging(true)
        }
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setDragging(false)
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void uploadFiles([...event.dataTransfer.files])
      }}
    >
      {dragging && (
        <div className='bg-background/95 border-foreground/40 pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center text-sm'>
          <Upload className='size-7' aria-hidden />
          {t('Drop files here to upload')}
        </div>
      )}
      <input
        ref={uploadInput}
        type='file'
        multiple
        className='hidden'
        aria-label={t('Choose files to upload')}
        disabled={writeBlocked || uploading}
        onChange={(event) => {
          const selectedFiles = [...(event.target.files ?? [])]
          event.target.value = ''
          void uploadFiles(selectedFiles)
        }}
      />
      <header className='border-border/60 shrink-0 space-y-3 border-b px-4 pt-4 pb-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <h2 className='min-w-0 flex-1 text-[15px] font-medium'>
            {t('Project files')}
          </h2>
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2'
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
            variant='ghost'
            size='icon-md'
            className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2'
            aria-label={t('Upload files')}
            title={t('Upload files')}
            disabled={writeBlocked || uploading}
            onClick={() => uploadInput.current?.click()}
          >
            {uploading ? (
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
            ) : (
              <Upload className='size-4' aria-hidden />
            )}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='focus-visible:ring-ring h-9 gap-1.5 rounded-full px-3 text-xs focus-visible:ring-2'
            aria-label={t('New file')}
            aria-expanded={creating}
            aria-controls={`${inputId}-form`}
            disabled={writeBlocked}
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
            className='text-muted-foreground pointer-events-none absolute top-3 left-3 size-4'
            aria-hidden
          />
          <Input
            ref={filterInput}
            aria-label={t('Filter files')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className='bg-muted/55 h-10 rounded-xl border-transparent pr-10 pl-10 text-base shadow-none md:text-sm'
            placeholder={t('Filter files')}
          />
          {filter && (
            <Button
              type='button'
              variant='ghost'
              size='icon-md'
              className='absolute top-1 right-1 size-8 rounded-full'
              aria-label={t('Clear file filter')}
              onClick={() => setFilter('')}
            >
              <X className='size-3.5' aria-hidden />
            </Button>
          )}
        </div>
        <nav
          aria-label={t('Folder path')}
          className='flex min-w-0 items-center gap-1 overflow-x-auto text-xs'
        >
          {directory && (
            <Button
              type='button'
              variant='ghost'
              size='icon-md'
              className='size-7 shrink-0 rounded-full'
              aria-label={t('Parent directory')}
              onClick={() => {
                setDirectory(parent)
                setFilter('')
                setCreating(false)
              }}
            >
              <ArrowLeft className='size-3.5' aria-hidden />
            </Button>
          )}
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-7 shrink-0 rounded-lg text-xs'
            aria-label={t('Project root')}
            aria-current={!directory ? 'location' : undefined}
            onClick={() => {
              setDirectory('')
              setFilter('')
              setCreating(false)
            }}
          >
            <Folder className='size-3.5' aria-hidden />
            {t('Files')}
          </Button>
          {segments.map((segment, index) => {
            const path = segments.slice(0, index + 1).join('/')
            return (
              <Fragment key={path}>
                <ChevronRight
                  className='text-muted-foreground size-3 shrink-0'
                  aria-hidden
                />
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='h-7 max-w-48 shrink-0 rounded-lg text-xs'
                  title={path}
                  aria-label={t('Open folder {{path}}', {
                    path,
                    interpolation: { escapeValue: false },
                  })}
                  aria-current={path === directory ? 'location' : undefined}
                  onClick={() => {
                    setDirectory(path)
                    setFilter('')
                    setCreating(false)
                  }}
                >
                  <span className='truncate'>{segment}</span>
                </Button>
              </Fragment>
            )
          })}
        </nav>
      </header>
      {uploading && (
        <p role='status' className='text-muted-foreground px-3 py-2 text-xs'>
          {t('Uploading files...')}
        </p>
      )}
      {!!uploadedPaths.length && (
        <div role='status' className='px-3 py-2 text-xs'>
          <p>{t('Files uploaded.')}</p>
          {uploadedPaths.map((path) => (
            <code key={path} className='mt-1 block break-all'>
              {path}
            </code>
          ))}
        </div>
      )}
      {uploadError && (
        <p
          role='alert'
          className='text-destructive px-3 py-2 text-xs break-words whitespace-pre-wrap'
        >
          {uploadError}
        </p>
      )}
      {creating && (
        <form
          id={`${inputId}-form`}
          className='bg-muted/30 border-border/60 shrink-0 space-y-2 border-b p-4'
          onSubmit={(event) => {
            event.preventDefault()
            if (writeBlocked) return
            const value = newName.trim()
            const path = [directory, value].filter(Boolean).join('/')
            if (
              !value ||
              [...path].length > 1024 ||
              path.split('/').length > 128 ||
              value.includes('\\') ||
              [...value].some(
                (character) =>
                  character.charCodeAt(0) < 32 ||
                  character.charCodeAt(0) === 127
              ) ||
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
            setSelected(path)
          }}
        >
          <label
            htmlFor={`${inputId}-path`}
            className='text-ui-base font-medium'
          >
            {t('New file path')}
          </label>
          <div className='flex items-center gap-2'>
            <Input
              id={`${inputId}-path`}
              autoFocus
              aria-invalid={!!nameError}
              aria-describedby={nameError ? `${inputId}-error` : undefined}
              className='h-10 min-w-0 flex-1 text-base md:text-sm'
              placeholder='src/example.ts'
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value)
                setNameError('')
              }}
              disabled={writeBlocked}
            />
            <Button
              type='submit'
              size='sm'
              className='h-10'
              disabled={!newName.trim() || writeBlocked}
            >
              {t('Create')}
            </Button>
            <Button
              type='button'
              variant='ghost'
              size='icon-md'
              aria-label={t('Cancel')}
              onClick={() => setCreating(false)}
            >
              <X className='size-4' aria-hidden />
            </Button>
          </div>
          {nameError && (
            <p
              id={`${inputId}-error`}
              role='alert'
              className='text-destructive text-xs'
            >
              {t(nameError)}
            </p>
          )}
        </form>
      )}
      {props.readOnly && (
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
      {files.isLoading && (
        <p
          role='status'
          className='text-foreground-subtle flex items-center justify-center gap-2 p-10 text-sm'
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
      <div className='min-h-0 min-w-0 flex-1 overflow-auto p-2'>
        {!files.isLoading &&
          !files.isError &&
          files.data?.entries.length === 0 && (
            <div className='text-foreground-subtle flex h-full min-h-52 flex-col items-center justify-center gap-3 p-6 text-center text-sm'>
              <span className='bg-muted/60 text-muted-foreground rounded-2xl p-4'>
                <Folder className='size-6' aria-hidden />
              </span>
              <p>{t('This folder is empty.')}</p>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={writeBlocked}
                onClick={() => setCreating(true)}
              >
                <FilePlus2 className='size-4' aria-hidden />
                {t('Create a file')}
              </Button>
            </div>
          )}
        {!!files.data?.entries.length && entries.length === 0 && (
          <p className='text-foreground-subtle p-8 text-center text-sm'>
            {t('No matching files.')}
          </p>
        )}
        <ul
          ref={fileList}
          className='space-y-0.5'
          aria-label={t('Files in this folder')}
        >
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type='button'
                data-zcode-file-row={entry.path}
                title={entry.path}
                className='text-foreground hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-ring flex min-h-10 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 max-sm:min-h-11'
                onClick={() => {
                  setCreating(false)
                  if (entry.type === 'directory') {
                    setDirectory(entry.path)
                    setFilter('')
                  } else setSelected(entry.path)
                }}
              >
                {entry.type === 'directory' ? (
                  <Folder
                    className='text-muted-foreground size-[18px] shrink-0'
                    aria-hidden
                  />
                ) : (
                  <FileCode2
                    className='text-muted-foreground size-[18px] shrink-0'
                    aria-hidden
                  />
                )}
                <span className='min-w-0 flex-1 truncate'>{entry.name}</span>
                {entry.type === 'directory' ? (
                  <ChevronRight
                    className='text-muted-foreground size-3.5 shrink-0'
                    aria-hidden
                  />
                ) : (
                  <span className='text-muted-foreground shrink-0 text-[11px] tabular-nums'>
                    {entry.size < 1024
                      ? `${entry.size} B`
                      : `${(entry.size / 1024).toFixed(1)} KB`}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
