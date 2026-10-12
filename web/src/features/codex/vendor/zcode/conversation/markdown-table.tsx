/*
 * Adapted from ZCode, packages/ui/src/components/ai-elements/markdown-table.tsx.
 * Apache-2.0; pinned source and changes: CONVERSATION-PROVENANCE.md.
 * Browser scroll container replaces desktop virtual scrolling; export helpers,
 * table markup, cell styles and action layout are retained from upstream.
 */
import { CopyIcon, DownloadIcon } from 'lucide-react'
import { type ComponentProps, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { Button } from '../button'
import {
  buildMarkdownTableText,
  buildCsvTableText,
  type MarkdownTableRows,
} from './table-export'

type MarkdownTableNodeProp = { node?: unknown }

function readRowsFromTable(table: HTMLTableElement | null): MarkdownTableRows {
  if (!table) return []
  return [...table.querySelectorAll('tr')]
    .map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) =>
        (cell.textContent ?? '').replaceAll(/\s+/g, ' ').trim()
      )
    )
    .filter((row) => row.length > 0)
}
export function MarkdownTable({
  className,
  children,
  node: _node,
  ...props
}: ComponentProps<'table'> & MarkdownTableNodeProp) {
  const { t } = useTranslation()
  const tableRef = useRef<HTMLTableElement>(null)
  const [feedback, setFeedback] = useState('')
  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(
        buildMarkdownTableText(readRowsFromTable(tableRef.current))
      )
      setFeedback(t('Copied'))
    } catch {
      setFeedback(t('Copy failed'))
    }
  }
  function downloadCsv() {
    const blob = new Blob(
      [buildCsvTableText(readRowsFromTable(tableRef.current))],
      { type: 'text/csv;charset=utf-8' }
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'table.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return (
    <div className='zcode-markdown-table my-5 flex w-full max-w-full min-w-0 flex-col gap-1'>
      <div
        className='relative w-full max-w-full min-w-0 overflow-hidden'
        data-markdown-table-frame=''
      >
        <div
          className='focus-visible:ring-ring w-full max-w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset'
          tabIndex={0}
          role='region'
          aria-label={t('Markdown table')}
        >
          <table
            ref={tableRef}
            className={cn(
              'w-max min-w-full border-collapse text-[15px] leading-6',
              className
            )}
            {...props}
            data-streamdown='table'
          >
            {children}
          </table>
        </div>
      </div>
      <div
        className='flex items-center justify-end gap-1'
        data-markdown-table-toolbar=''
      >
        {feedback && (
          <span
            role='status'
            className='text-ui-sm text-foreground-subtle mr-auto'
          >
            {feedback}
          </span>
        )}
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='text-muted-foreground focus-visible:ring-ring rounded-md focus-visible:ring-2'
          aria-label={t('Copy table as Markdown')}
          title={t('Copy table as Markdown')}
          onClick={() => void copyMarkdown()}
        >
          <CopyIcon className='size-3.5' aria-hidden />
        </Button>
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='text-muted-foreground focus-visible:ring-ring rounded-md focus-visible:ring-2'
          aria-label={t('Download CSV')}
          title={t('Download CSV')}
          onClick={downloadCsv}
        >
          <DownloadIcon className='size-3.5' aria-hidden />
        </Button>
      </div>
    </div>
  )
}

export type MarkdownTableHeaderProps = ComponentProps<'thead'> &
  MarkdownTableNodeProp

export function MarkdownTableHeader({
  className,
  node: _node,
  ...props
}: MarkdownTableHeaderProps) {
  return <thead className={cn('', className)} {...props} />
}

export type MarkdownTableBodyProps = ComponentProps<'tbody'> &
  MarkdownTableNodeProp

export function MarkdownTableBody({
  className,
  node: _node,
  ...props
}: MarkdownTableBodyProps) {
  return <tbody className={cn('', className)} {...props} />
}

export type MarkdownTableRowProps = ComponentProps<'tr'> & MarkdownTableNodeProp

export function MarkdownTableRow({
  className,
  node: _node,
  ...props
}: MarkdownTableRowProps) {
  return (
    <tr
      className={cn('transition-colors hover:bg-hover/20', className)}
      {...props}
    />
  )
}

export type MarkdownTableHeadProps = ComponentProps<'th'> &
  MarkdownTableNodeProp

export function MarkdownTableHead({
  className,
  node: _node,
  ...props
}: MarkdownTableHeadProps) {
  return (
    <th
      className={cn(
        'border-border border-b px-3 py-3 text-left font-semibold text-foreground min-w-24 max-w-sm whitespace-normal break-words first:pl-0 last:pr-0',
        className
      )}
      {...props}
    />
  )
}

export type MarkdownTableCellProps = ComponentProps<'td'> &
  MarkdownTableNodeProp

export function MarkdownTableCell({
  className,
  node: _node,
  ...props
}: MarkdownTableCellProps) {
  return (
    <td
      className={cn(
        'border-border border-b px-3 py-3 text-foreground align-top min-w-24 max-w-sm whitespace-normal break-words first:pl-0 last:pr-0',
        className
      )}
      {...props}
    />
  )
}
