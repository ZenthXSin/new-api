/*
 * Adapted from ZCode ToolCallBlocks/ToolLayout.tsx and ToolSummaryRow.tsx.
 * Apache-2.0. See CONVERSATION-PROVENANCE.md for original source ranges.
 * Native disclosure state replaces Radix; summary markup/visual hierarchy is retained.
 */
import { ChevronRightIcon } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'

import { cn } from '@/features/codex/vendor/zcode/utils'

export function ToolLayout(props: {
  icon: ReactNode
  kindLabel: ReactNode
  primaryText?: ReactNode
  secondaryText?: ReactNode
  statusNode?: ReactNode
  running?: boolean
  autoExpand?: boolean
  hidePrimaryWhenOpen?: boolean
  title?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    if (!props.running) setOpen(null)
  }, [props.running])
  const isExpanded = open ?? (!!props.running && props.autoExpand !== false)
  const contentId = useId()
  const primaryText =
    isExpanded && props.hidePrimaryWhenOpen ? undefined : props.primaryText
  return (
    <div className='flex w-full min-w-0 flex-col' data-zcode-tool-layout=''>
      <button
        type='button'
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setOpen(!isExpanded)}
        className='group/tool-summary text-ui-base focus-visible:ring-input-border-focused inline-flex min-h-8 max-w-full cursor-pointer items-center gap-2 self-start rounded-md py-1 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none'
        title={props.title}
      >
        <span className='text-foreground-subtlest [&_svg]:text-foreground-subtlest shrink-0'>
          {props.icon}
        </span>
        <span
          className={cn(
            'tool-summary-kind-label shrink-0 whitespace-nowrap font-medium',
            props.running ? 'text-foreground' : 'text-foreground-subtlest'
          )}
        >
          {props.kindLabel}
        </span>{' '}
        {(primaryText || props.secondaryText) && (
          <span className='tool-summary-content text-foreground-subtlest flex max-w-full min-w-0 items-center gap-2 overflow-hidden'>
            {primaryText && (
              <span className='min-w-0 truncate'>{primaryText}</span>
            )}
            {props.secondaryText && (
              <span className='text-ui-sm shrink-0'>{props.secondaryText}</span>
            )}
          </span>
        )}{' '}
        {props.statusNode && (
          <span className='text-ui-sm text-foreground-subtlest shrink-0'>
            {props.statusNode}
          </span>
        )}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-foreground-subtlest opacity-0 transition-[transform,opacity] duration-200 group-hover/tool-summary:opacity-100 group-focus-visible/tool-summary:opacity-100 [@media(hover:none)]:opacity-100',
            isExpanded && 'rotate-90 opacity-100'
          )}
        />
      </button>
      {isExpanded && (
        <div
          id={contentId}
          className='text-popover-foreground min-w-0 pt-2 outline-none'
        >
          {props.children}
        </div>
      )}
    </div>
  )
}
