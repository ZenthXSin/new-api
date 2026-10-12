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
  AlertCircle,
  ChevronDown,
  Download,
  ExternalLink,
  FileCode2,
  GitCompareArrows,
  ListFilter,
  WrapText,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { codexApi, codexError, downloadCodexFile } from '../api'
import { parseWorkspaceChanges } from '../lib/workspace-review'
import { Button } from '../vendor/zcode/button'
import { LightweightDiffPreview } from '../vendor/zcode/inspector/lightweight-diff-preview'
import { parseUnifiedDiffLines } from '../vendor/zcode/inspector/patch-lines'
import { GitActionsPanel } from './git-actions-panel'

export function WorkspaceDiff(props: {
  id: string
  actor: string
  running: boolean
  onOpenFile: (path: string) => void
  readOnly?: boolean
  onBusy?: (busy: boolean) => void
  showGitActions?: boolean
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['codex', props.actor, props.id, 'diff'],
    queryFn: ({ signal }) => codexApi.diff(props.id, signal),
    refetchInterval: props.running ? 5000 : false,
  })
  const chunks = useMemo(() => parseWorkspaceChanges(query.data), [query.data])
  const [viewed, setViewed] = useState<Record<string, string>>({})
  const [wrapLines, setWrapLines] = useState(false)
  const [fileFilter, setFileFilter] = useState('')
  const [showFileList, setShowFileList] = useState(false)
  const cards = useRef(new Map<string, HTMLElement>())
  const reviewedCount = chunks.filter(
    (chunk) => viewed[chunk.path] === chunk.patch
  ).length
  const visibleChunks = chunks.filter((chunk) =>
    chunk.path.toLocaleLowerCase().includes(fileFilter.toLocaleLowerCase())
  )
  const totals = chunks.reduce(
    (count, chunk) => {
      const parsed = parseUnifiedDiffLines(chunk.patch)
      return {
        added: count.added + parsed.added,
        removed: count.removed + parsed.removed,
      }
    },
    { added: 0, removed: 0 }
  )
  return (
    <>
      <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
        <div className='border-border flex min-h-18 shrink-0 items-center gap-2 border-b px-5 py-3 max-sm:px-4'>
          <div className='min-w-0 flex-1'>
            <p className='text-foreground flex items-center gap-2 text-sm font-medium'>
              {t('Changed files')}
              <span className='bg-surface text-foreground-subtle rounded-md px-1.5 py-0.5 text-xs font-normal tabular-nums'>
                {chunks.length}
              </span>
            </p>
            <p className='text-foreground-subtle mt-1 text-xs leading-5'>
              {t('Changes from the initial project')}
            </p>
          </div>
          {chunks.length > 0 && (
            <span
              className='flex shrink-0 gap-2 font-mono text-xs tabular-nums'
              aria-label={t('Line changes')}
            >
              <span className='text-diff-added'>+{totals.added}</span>
              <span className='text-diff-removed'>−{totals.removed}</span>
            </span>
          )}
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='text-foreground-subtle focus-visible:outline-ring size-9 rounded-full focus-visible:outline-2 max-sm:size-11'
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
            variant='ghost'
            size='icon-md'
            className='text-foreground-subtle focus-visible:outline-ring size-9 rounded-full focus-visible:outline-2 max-sm:size-11'
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
        {chunks.length > 0 && (
          <div className='border-border bg-background shrink-0 border-b px-4 py-2'>
            <div className='flex items-center gap-2'>
              <Button
                variant='ghost'
                className='focus-visible:outline-ring h-8 gap-2 rounded-md px-2 text-xs focus-visible:outline-2'
                aria-expanded={showFileList}
                aria-label={t('Show changed files')}
                onClick={() => setShowFileList(!showFileList)}
              >
                <ListFilter className='size-3.5' aria-hidden />
                {t('Files')}
              </Button>
              <span className='text-foreground-subtle text-xs'>
                {t('{{viewed}} of {{total}} viewed', {
                  viewed: reviewedCount,
                  total: chunks.length,
                })}
              </span>
              <Button
                variant='ghost'
                className='focus-visible:outline-ring ml-auto size-8 rounded-md focus-visible:outline-2'
                aria-label={t('Wrap diff lines')}
                title={t('Wrap diff lines')}
                aria-pressed={wrapLines}
                onClick={() => setWrapLines(!wrapLines)}
              >
                <WrapText className='size-4' aria-hidden />
              </Button>
            </div>
            {showFileList && (
              <nav
                aria-label={t('Changed file list')}
                className='mt-2 space-y-2 pb-1'
              >
                <input
                  type='search'
                  aria-label={t('Filter changed files')}
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder={t('Filter changed files')}
                  className='border-border bg-background focus-visible:outline-ring h-9 w-full rounded-lg border px-3 text-xs focus-visible:outline-2'
                />
                <ul className='max-h-44 space-y-0.5 overflow-auto'>
                  {visibleChunks.map((chunk) => (
                    <li key={chunk.path}>
                      <button
                        type='button'
                        className='hover:bg-hover focus-visible:outline-ring flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs focus-visible:outline-2'
                        aria-label={t('Go to {{path}}', { path: chunk.path })}
                        onClick={() => {
                          const card = cards.current.get(chunk.path)
                          card?.scrollIntoView({
                            block: 'start',
                            behavior: 'smooth',
                          })
                          card?.focus({ preventScroll: true })
                        }}
                      >
                        <span className='min-w-0 flex-1 truncate'>
                          {chunk.path}
                        </span>
                        <span className='text-foreground-subtle font-mono'>
                          {chunk.status}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {!visibleChunks.length && (
                  <p className='text-foreground-subtle px-2 py-3 text-xs'>
                    {t('No matching files.')}
                  </p>
                )}
              </nav>
            )}
          </div>
        )}
        {query.isError && (
          <div
            role='alert'
            className='border-destructive/20 bg-destructive/5 text-destructive mx-4 my-4 flex items-start gap-3 rounded-2xl border p-4 text-sm leading-6'
          >
            <AlertCircle className='mt-1 size-4 shrink-0' aria-hidden />
            <p className='min-w-0 flex-1 break-words'>
              {t(codexError(query.error))}
            </p>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-8 rounded-full px-3'
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t('Retry')}
            </Button>
          </div>
        )}
        {query.isLoading && (
          <div
            role='status'
            className='text-foreground-subtle flex flex-1 flex-col items-center justify-center gap-4 px-8 py-12 text-sm'
          >
            <LoaderCircle className='size-5 animate-spin' aria-hidden />
            {t('Loading changes...')}
          </div>
        )}
        {!query.isLoading && !query.isError && chunks.length === 0 && (
          <div
            role='status'
            className='text-foreground-subtle flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center text-sm leading-6'
          >
            <span className='bg-surface mb-1 flex size-12 items-center justify-center rounded-2xl'>
              <GitCompareArrows className='size-5' aria-hidden />
            </span>
            <p className='text-foreground font-medium'>
              {t('No changes yet.')}
            </p>
            <p className='max-w-xs'>
              {t(
                'File changes will appear here after you or Codex edit the project.'
              )}
            </p>
          </div>
        )}
        {query.data?.truncated && (
          <p
            role='status'
            className='mx-4 mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-5'
          >
            {t(
              'This diff is truncated. Export the project to inspect all changes.'
            )}
          </p>
        )}
        {chunks.length > 0 && (
          <div className='min-h-0 min-w-0 flex-1 space-y-4 overflow-auto p-4'>
            {chunks.map((chunk) => (
              <WorkspaceChangeCard
                key={chunk.path}
                path={chunk.path}
                patch={chunk.patch}
                onOpenFile={props.onOpenFile}
                deleted={chunk.deleted}
                status={chunk.status}
                viewed={viewed[chunk.path] === chunk.patch}
                onViewed={(checked) =>
                  setViewed((current) => {
                    const next = { ...current }
                    if (checked) next[chunk.path] = chunk.patch
                    else delete next[chunk.path]
                    return next
                  })
                }
                wrapLines={wrapLines}
                cardRef={(element) => {
                  if (element) cards.current.set(chunk.path, element)
                  else cards.current.delete(chunk.path)
                }}
              />
            ))}
          </div>
        )}
      </div>
      {props.showGitActions && (
        <GitActionsPanel
          id={props.id}
          actor={props.actor}
          running={props.running}
          readOnly={props.readOnly}
          onBusy={props.onBusy}
        />
      )}
    </>
  )
}

function WorkspaceChangeCard(props: {
  path: string
  patch: string
  deleted: boolean
  status: string
  viewed: boolean
  onViewed: (checked: boolean) => void
  wrapLines: boolean
  cardRef: (element: HTMLElement | null) => void
  onOpenFile?: (path: string) => void
}) {
  const { t } = useTranslation()
  const contentId = useId()
  const [expanded, setExpanded] = useState(true)
  const preview = useMemo(
    () => parseUnifiedDiffLines(props.patch),
    [props.patch]
  )
  const filename = props.path.split('/').at(-1)
  const directory = props.path.includes('/')
    ? props.path.slice(0, props.path.lastIndexOf('/'))
    : ''
  return (
    <article
      ref={props.cardRef}
      tabIndex={-1}
      aria-label={t('Changes in {{path}}', {
        path: props.path,
        interpolation: { escapeValue: false },
      })}
      className='border-border bg-background focus-visible:outline-ring min-w-0 overflow-hidden rounded-xl border focus-visible:outline-2'
    >
      <div className='bg-surface/45 flex min-w-0 items-center gap-1 pr-2'>
        <button
          type='button'
          aria-label={props.path}
          aria-expanded={expanded}
          aria-controls={contentId}
          title={props.path}
          className='hover:bg-hover focus-visible:outline-ring flex min-h-13 min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown
            className={cn(
              'text-foreground-subtle size-3.5 shrink-0 transition-transform',
              !expanded && '-rotate-90'
            )}
            aria-hidden
          />
          <FileCode2
            className='text-foreground-subtle size-4 shrink-0'
            aria-hidden
          />
          <span className='min-w-0 flex-1'>
            <span className='text-foreground block truncate text-[13px] font-medium'>
              {filename}
            </span>
            {directory && (
              <span className='text-foreground-subtle mt-0.5 block truncate text-xs'>
                {directory}
              </span>
            )}
          </span>
          <span
            className='flex shrink-0 gap-2 font-mono text-xs tabular-nums'
            aria-label={t('Line changes')}
          >
            <span className='text-diff-added'>+{preview.added}</span>
            <span className='text-diff-removed'>−{preview.removed}</span>
          </span>
        </button>
        <label className='text-foreground-subtle flex shrink-0 cursor-pointer items-center gap-1.5 px-2 text-xs'>
          <input
            type='checkbox'
            checked={props.viewed}
            aria-label={t('Mark {{path}} as viewed', {
              path: props.path,
              interpolation: { escapeValue: false },
            })}
            onChange={(event) => props.onViewed(event.target.checked)}
          />
          <span className='max-sm:sr-only'>{t('Viewed')}</span>
        </label>
        {!props.deleted && props.onOpenFile && (
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='text-foreground-subtle focus-visible:outline-ring size-8 rounded-full focus-visible:outline-2 max-sm:size-11'
            aria-label={t('Open file')}
            title={t('Open file')}
            onClick={() => props.onOpenFile?.(props.path)}
          >
            <ExternalLink className='size-3.5' aria-hidden />
          </Button>
        )}
      </div>
      {expanded && !!props.patch && (
        <LightweightDiffPreview
          id={contentId}
          role='region'
          aria-label={props.path}
          tabIndex={0}
          className='border-border focus-visible:outline-ring max-h-[60vh] border-t py-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
          lines={preview.lines}
          lineNumbers={preview.lineNumbers}
          codePreviewSettings={{
            fontSizePx: 12,
            showLineNumbers: true,
            wrapLongLines: props.wrapLines,
          }}
        />
      )}
      {expanded && !props.patch && (
        <p className='text-foreground-subtle border-border border-t px-4 py-5 text-xs leading-5'>
          {t(
            'No text preview is available for this change. Open the file or download the project to inspect it.'
          )}
        </p>
      )}
    </article>
  )
}
