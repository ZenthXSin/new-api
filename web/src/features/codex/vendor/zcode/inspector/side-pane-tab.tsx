/*
 * Adapted from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/app-shell/SidePaneTabTrigger.tsx
 * Changes: native controlled tabs; remove desktop drag and context menu;
 * tab keyboard navigation and closing are owned by the New API inspector.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/features/codex/vendor/zcode/utils'

export function SidePaneTab(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    active: boolean
    icon: ReactNode
  }
) {
  const { active, icon, children, className, ...buttonProps } = props
  return (
    <button
      {...buttonProps}
      type='button'
      role='tab'
      aria-selected={active}
      data-active={active ? '' : undefined}
      data-state={active ? 'active' : 'inactive'}
      className={cn(
        'group relative inline-flex h-7 min-w-15 max-w-39 flex-[1_1_9.75rem] items-center justify-start gap-1 overflow-hidden rounded-lg border border-transparent bg-transparent px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap text-foreground-subtle transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring data-active:bg-selected data-active:text-foreground max-sm:h-10',
        !active && 'hover:bg-hover',
        className
      )}
    >
      <span className='flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap'>
        <span className='flex size-4 shrink-0 items-center justify-center'>
          {icon}
        </span>
        <span className='truncate'>{children}</span>
      </span>
    </button>
  )
}
