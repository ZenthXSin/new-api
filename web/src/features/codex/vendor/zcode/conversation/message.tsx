/*
 * Adapted from zai-org/ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * Apache-2.0. AI Elements portions: Copyright 2023 Vercel, Inc.
 * Modified for New API: browser-only dependencies and host i18n.
 * See CONVERSATION-PROVENANCE.md for source ranges and adaptations.
 */
import type { HTMLAttributes, ComponentProps } from 'react'

import { cn } from '@/features/codex/vendor/zcode/utils'

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'user' | 'assistant'
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      'is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-ui-base',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground',
      'group-[.is-assistant]:text-foreground',
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionsProps = ComponentProps<'div'>

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn('flex items-center gap-1', className)} {...props}>
    {children}
  </div>
)
