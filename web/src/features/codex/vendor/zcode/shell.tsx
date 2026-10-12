/*
 * Adapted from ZCode (Apache-2.0), commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * WorkspaceSidebar/WorkspacePurposeSection.tsx: section presentation, without desktop sorting.
 * WorkspaceSidebarItem.tsx: workspace row presentation, with New API callbacks.
 * v4/ConversationDraftEmptyState.tsx: timed greeting and centered layout; neutral code mark.
 * See THIRD_PARTY.md and LICENSE. Modified for New API, 2026-10-06.
 */
import { ChevronDown, ChevronRight, CodeXml } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

export function WorkspacePurposeSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <section aria-label={title} className='group/purpose-section relative'>
      <div className='flex h-7 min-w-0 items-center'>
        <button
          type='button'
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className='text-ui-base text-foreground-subtlest hover:text-foreground focus-visible:text-foreground focus-visible:ring-ring/30 flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left font-medium transition-colors outline-none focus-visible:ring-2'
        >
          <span className='min-w-0 truncate'>{title}</span>
          {open ? (
            <ChevronDown
              aria-hidden
              className='size-3.5 shrink-0 opacity-0 transition-opacity group-focus-within/purpose-section:opacity-100 group-hover/purpose-section:opacity-100 [@media(hover:none)]:opacity-100'
            />
          ) : (
            <ChevronRight aria-hidden className='size-3.5 shrink-0' />
          )}
        </button>
        {action}
      </div>
      {open && children}
    </section>
  )
}

export function WorkspaceSidebarItem({
  title,
  active,
  icon,
  trailing,
  action,
  onSelect,
}: {
  title: string
  active: boolean
  icon: ReactNode
  trailing?: ReactNode
  action?: ReactNode
  onSelect: () => void
}) {
  return (
    <div className='group/project relative min-w-0'>
      <button
        type='button'
        title={title}
        aria-label={title}
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className={cn(
          'group flex h-9 w-full min-w-0 items-center gap-2 rounded-lg pl-2.5 pr-2 text-left text-ui-base text-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/30',
          active && 'bg-selected',
          action && 'pr-10'
        )}
      >
        <span className='relative flex size-4 shrink-0 items-center justify-center'>
          {icon}
        </span>
        <span className='min-w-0 flex-1 truncate'>{title}</span>
        <span className='text-ui-xs text-foreground-subtlest shrink-0'>
          {trailing}
        </span>
      </button>
      {action && <div className='absolute top-0.5 right-0.5'>{action}</div>}
    </div>
  )
}

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const
function getGreeting(date: Date) {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'Good morning. What shall we build?'
  if (hour >= 12 && hour < 18) return 'Good afternoon. What shall we build?'
  return 'Good evening. What shall we build?'
}
function getNextGreetingDelay(date: Date) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date)
    boundary.setHours(hour, 0, 0, 0)
    return boundary
  })
  const tomorrow = new Date(date)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0)
  const next =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ??
    tomorrow
  return Math.max(1, next.getTime() - date.getTime())
}
export function ConversationDraftEmptyState() {
  const { t } = useTranslation()
  const [date, setDate] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDate(new Date()),
      getNextGreetingDelay(date)
    )
    return () => window.clearTimeout(timer)
  }, [date])
  return (
    <div className='text-foreground relative isolate mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 sm:mb-8'>
      <CodeXml
        aria-hidden
        className='text-foreground pointer-events-none absolute top-1/2 left-1/2 -z-10 size-44 -translate-x-1/2 -translate-y-1/2 opacity-[0.035]'
        strokeWidth={0.5}
      />
      <h2 className='relative w-full px-4 text-center text-[clamp(20px,2.4vw,30px)] leading-tight font-medium tracking-tight'>
        {t(getGreeting(date))}
      </h2>
    </div>
  )
}
