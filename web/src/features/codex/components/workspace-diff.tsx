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
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileCode2,
  GitCompareArrows,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { codexApi, codexError, downloadCodexFile } from '../api'

export function WorkspaceDiff(props: {
  id: string
  actor: string
  running: boolean
  onOpenFile: (path: string) => void
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['codex', props.actor, props.id, 'diff'],
    queryFn: ({ signal }) => codexApi.diff(props.id, signal),
    refetchInterval: props.running ? 5000 : false,
  })
  const chunks = (query.data?.diff ?? '')
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.trim())
    .map((patch) => {
      const lines = patch.split('\n')
      const newPath = lines
        .find((line) => line.startsWith('+++ '))
        ?.slice(4)
        .split('\t')[0]
      const oldPath = lines
        .find((line) => line.startsWith('--- '))
        ?.slice(4)
        .split('\t')[0]
      let path = newPath === '/dev/null' ? oldPath : newPath
      if (!path) {
        path = lines.find((line) => line.startsWith('rename to '))?.slice(10)
        if (!path) {
          path = lines[0]?.match(
            /^diff --git (?:"(?:[^"\\]|\\.)*"|.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/
          )?.[1]
        }
      }
      if (path?.startsWith('"')) {
        try {
          // Git quotes UTF-8 paths with octal byte escapes. Decode the bytes before
          // passing the real path to the file API; never use summary-list order.
          const decoded = path
            .slice(1, -1)
            .replaceAll(/\\([0-7]{3}|[\\"tnr])/g, (_, value: string) => {
              if (/^[0-7]{3}$/.test(value)) {
                return String.fromCharCode(Number.parseInt(value, 8))
              }
              return (
                ({ t: '\t', n: '\n', r: '\r' } as Record<string, string>)[
                  value
                ] || value
              )
            })
          path = new TextDecoder().decode(
            Uint8Array.from(decoded, (character) => character.charCodeAt(0))
          )
        } catch {
          path = undefined
        }
      }
      if (path?.startsWith('a/') || path?.startsWith('b/')) path = path.slice(2)
      return {
        patch,
        path,
        deleted:
          newPath === '/dev/null' ||
          query.data?.files.find((file) => file.path === path)?.status === 'D',
      }
    })
  let added = 0,
    removed = 0
  for (const line of (query.data?.diff ?? '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return (
    <>
      <div className='flex shrink-0 items-center gap-2 border-b px-4 py-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-medium'>
            {t('Changed files')}{' '}
            <span className='text-muted-foreground ml-1 font-normal'>
              {query.data?.files.length ?? 0}
            </span>
          </p>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t('Changes from the initial project')}
          </p>
        </div>
        {!!query.data?.diff && (
          <span className='flex shrink-0 gap-2 font-mono text-xs'>
            <span className='text-emerald-700 dark:text-emerald-400'>
              +{added}
            </span>
            <span className='text-red-700 dark:text-red-400'>−{removed}</span>
          </span>
        )}
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          aria-label={t('Refresh changes')}
          title={t('Refresh changes')}
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw
            className={cn('size-4', query.isFetching && 'animate-spin')}
            aria-hidden
          />
        </Button>
        <Button
          type='button'
          variant='outline'
          size='icon-sm'
          aria-label={t('Download patch')}
          title={t('Download patch')}
          disabled={!query.data?.diff}
          onClick={() =>
            downloadCodexFile(
              new Blob([query.data?.diff ?? ''], { type: 'text/plain' }),
              'workspace.patch'
            )
          }
        >
          <Download className='size-4' aria-hidden />
        </Button>
      </div>
      {query.isError && (
        <div
          role='alert'
          className='bg-destructive/5 text-destructive flex items-start gap-3 border-b p-4 text-sm'
        >
          <p className='min-w-0 flex-1 break-words'>
            {t(codexError(query.error))}
          </p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => void query.refetch()}
          >
            {t('Retry')}
          </Button>
        </div>
      )}
      {query.isLoading && (
        <div
          role='status'
          className='text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm'
        >
          <LoaderCircle className='size-4 animate-spin' aria-hidden />
          {t('Loading changes...')}
        </div>
      )}
      {!query.isLoading && !query.isError && !query.data?.diff && (
        <div className='text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm'>
          <span className='bg-muted rounded-2xl p-4'>
            <GitCompareArrows className='size-6' aria-hidden />
          </span>
          <p className='text-foreground font-medium'>{t('No changes yet.')}</p>
          <p className='max-w-xs'>
            {t(
              'File changes will appear here after you or Codex edit the project.'
            )}
          </p>
        </div>
      )}
      {query.data?.truncated && (
        <p className='border-b bg-amber-500/10 p-3 text-sm'>
          {t(
            'This diff is truncated. Export the project to inspect all changes.'
          )}
        </p>
      )}
      {chunks.length > 0 && (
        <div className='min-h-0 min-w-0 flex-1 space-y-3 overflow-auto p-3 sm:p-4'>
          {chunks.map((chunk, index) => (
            <FileDiff
              key={chunk.path || String(index)}
              path={chunk.path || t('Changes')}
              patch={chunk.patch}
              onOpenFile={chunk.path ? props.onOpenFile : undefined}
              deleted={chunk.deleted}
            />
          ))}
        </div>
      )}
    </>
  )
}

function FileDiff(props: {
  path: string
  patch: string
  deleted?: boolean
  onOpenFile?: (path: string) => void
}) {
  const { t } = useTranslation()
  let oldLine = 0,
    newLine = 0,
    added = 0,
    removed = 0
  const rows = props.patch.split('\n').flatMap((line, index) => {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      return []
    }
    const range = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (range) {
      oldLine = Number(range[1])
      newLine = Number(range[2])
      return [{ id: index, line, oldNumber: '', newNumber: '', kind: 'range' }]
    }
    if (line.startsWith('+')) {
      added++
      return [
        {
          id: index,
          line,
          oldNumber: '',
          newNumber: String(newLine++),
          kind: 'added',
        },
      ]
    }
    if (line.startsWith('-')) {
      removed++
      return [
        {
          id: index,
          line,
          oldNumber: String(oldLine++),
          newNumber: '',
          kind: 'removed',
        },
      ]
    }
    if (line.startsWith(' ')) {
      return [
        {
          id: index,
          line,
          oldNumber: String(oldLine++),
          newNumber: String(newLine++),
          kind: 'context',
        },
      ]
    }
    if (!line) return []
    return [{ id: index, line, oldNumber: '', newNumber: '', kind: 'meta' }]
  })
  return (
    <details open className='group overflow-hidden rounded-xl border'>
      <summary className='bg-muted/35 flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px]'>
        <ChevronDown
          className='size-3.5 shrink-0 transition-transform group-not-open:-rotate-90'
          aria-hidden
        />
        <FileCode2
          className='text-muted-foreground size-4 shrink-0'
          aria-hidden
        />
        <span className='min-w-0 flex-1 font-medium break-all'>
          {props.path}
        </span>
        <span
          aria-label={t('Line changes')}
          className='flex shrink-0 gap-2 font-mono text-xs'
        >
          <span className='text-emerald-700 dark:text-emerald-400'>
            +{added}
          </span>
          <span className='text-red-700 dark:text-red-400'>−{removed}</span>
        </span>
      </summary>
      {!props.deleted && props.onOpenFile && (
        <div className='flex justify-end border-t px-3 py-1'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={() => props.onOpenFile?.(props.path)}
          >
            <ExternalLink className='size-3.5' aria-hidden />
            {t('Open file')}
          </Button>
        </div>
      )}
      <div
        className='max-h-[60vh] overflow-auto border-t'
        role='region'
        aria-label={props.path}
        tabIndex={0}
      >
        <pre className='min-w-max py-2 font-mono text-[13px] leading-6'>
          {rows.map((row) => (
            <span
              key={row.id}
              className={cn(
                'flex',
                row.kind === 'added' &&
                  'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200',
                row.kind === 'removed' &&
                  'bg-red-500/10 text-red-900 dark:text-red-200',
                row.kind === 'range' && 'bg-muted text-muted-foreground',
                row.kind === 'meta' && 'text-muted-foreground'
              )}
            >
              <span
                className='text-muted-foreground w-9 shrink-0 pr-1 text-right text-[11px] select-none'
                aria-hidden
              >
                {row.oldNumber}
              </span>
              <span
                className='text-muted-foreground w-9 shrink-0 border-r pr-2 text-right text-[11px] select-none'
                aria-hidden
              >
                {row.newNumber}
              </span>
              <span className='px-3'>{row.line}</span>
            </span>
          ))}
        </pre>
      </div>
    </details>
  )
}
