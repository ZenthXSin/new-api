/*
 * Adapted from zai-org/ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * Apache-2.0. AI Elements portions: Copyright 2023 Vercel, Inc.
 * Modified for New API: browser-only dependencies and host i18n.
 * See CONVERSATION-PROVENANCE.md for source ranges and adaptations.
 */

import type { ComponentProps } from 'react'

import { cn } from '@/features/codex/vendor/zcode/utils'

export type MarkdownBlockquoteProps = ComponentProps<'blockquote'> & {
  node?: unknown
}

export function MarkdownBlockquote({
  className,
  node: _node,
  ...props
}: MarkdownBlockquoteProps) {
  return (
    <blockquote
      className={cn(
        'my-4 border-border border-l-2 pl-3 text-foreground-subtle',
        '[&_p]:my-0 [&_p+p]:mt-2',
        className
      )}
      data-markdown-blockquote=''
      {...props}
    />
  )
}
