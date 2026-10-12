/*
 * Adapted from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/GitPaneChangeCard.tsx
 * Changes: use New API patch props and i18next; keep the upstream card/header
 * and lightweight preview; omit desktop context actions and rich diff worker.
 */
import { ChevronDown, ExternalLink, FileCode2 } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { Button } from '../button'
import { LightweightDiffPreview } from './lightweight-diff-preview'
import { parseUnifiedDiffLines } from './patch-lines'

export function GitPaneChangeCard(props: {
  path: string
  patch: string
  deleted?: boolean
  onOpenFile?: (path: string) => void
}) {
  const { t } = useTranslation()
  const [isExpanded, setExpanded] = useState(true)
  const contentId = useId()
  const preview = useMemo(
    () => parseUnifiedDiffLines(props.patch),
    [props.patch]
  )
  const filename = props.path.split('/').at(-1)
  const directory = props.path.includes('/')
    ? props.path.slice(0, props.path.lastIndexOf('/'))
    : ''
  return (
    <div
      className='border-border w-full min-w-0 border-b'
      data-zcode-git-change-card
    >
      <button
        type='button'
        aria-expanded={isExpanded}
        aria-controls={contentId}
        aria-label={props.path}
        title={props.path}
        className={cn(
          'sticky top-0 z-10 flex h-8 w-full items-center gap-3 bg-background px-3 text-left transition-colors hover:bg-surface-hover supports-[backdrop-filter]:backdrop-blur-sm max-sm:h-11 focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
          isExpanded && 'bg-surface-hover'
        )}
        onClick={() => setExpanded(!isExpanded)}
      >
        <div className='min-w-0 flex-1 overflow-hidden'>
          <div className='flex min-w-0 items-center gap-2 overflow-hidden'>
            <FileCode2
              className='text-foreground-subtle size-3.5 shrink-0'
              aria-hidden
            />
            <span className='text-ui-base text-foreground truncate'>
              {filename}
            </span>
            {directory && (
              <span className='text-ui-base text-foreground-subtlest truncate'>
                {directory}
              </span>
            )}
          </div>
        </div>
        <div className='flex shrink-0 items-center justify-end gap-3 pl-3'>
          <span
            className='text-ui-base shrink-0 whitespace-nowrap'
            aria-label={t('Line changes')}
          >
            <span className='text-diff-added'>+{preview.added}</span>
            <span className='text-diff-removed ml-2'>−{preview.removed}</span>
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-foreground-subtle transition-transform',
              isExpanded && 'rotate-180'
            )}
            aria-hidden
          />
        </div>
      </button>
      {isExpanded && (
        <div
          id={contentId}
          className='bg-background w-full min-w-0 overflow-hidden'
        >
          {!props.deleted && props.onOpenFile && (
            <div className='border-border bg-surface/30 flex justify-end border-b px-2 py-1'>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='text-foreground-subtle max-sm:h-9'
                onClick={() => props.onOpenFile?.(props.path)}
              >
                <ExternalLink className='size-3.5' aria-hidden />
                {t('Open file')}
              </Button>
            </div>
          )}
          <LightweightDiffPreview
            role='region'
            aria-label={props.path}
            tabIndex={0}
            className='max-h-[60vh] focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
            lines={preview.lines}
            lineNumbers={preview.lineNumbers}
            codePreviewSettings={{
              fontSizePx: 13,
              showLineNumbers: true,
              wrapLongLines: false,
            }}
          />
        </div>
      )}
    </div>
  )
}
