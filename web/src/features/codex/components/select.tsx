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
import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '../vendor/zcode/utils'

export function CodexSelect(props: {
  id?: string
  label: string
  value: string
  options: { value: string; label: string; description?: string }[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  compact?: boolean
  icon?: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (props.disabled) setOpen(false)
  }, [props.disabled])

  return (
    <Select.Root
      open={open && !props.disabled}
      onOpenChange={setOpen}
      value={props.value}
      items={props.options}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (
          !props.disabled &&
          value !== null &&
          props.options.some((option) => option.value === value)
        ) {
          props.onChange(value)
        }
      }}
    >
      <Select.Trigger
        ref={trigger}
        id={props.id}
        aria-label={props.label}
        aria-invalid={props.invalid || undefined}
        className={cn(
          'codex-select-trigger flex min-w-0 items-center gap-2 rounded-xl text-left text-[#303030] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#8e8e8e]/50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#ececec]',
          props.compact
            ? 'h-10 border border-transparent px-2.5 text-sm hover:bg-black/5 data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:data-popup-open:bg-white/10'
            : 'h-11 w-full border border-black/15 bg-transparent px-3 text-base aria-invalid:border-red-500 dark:border-white/20 sm:text-sm',
          props.className
        )}
      >
        {props.icon}
        <Select.Value className='min-w-0 flex-1 truncate'>
          {(value) =>
            props.options.find((option) => option.value === value)?.label ||
            props.placeholder ||
            props.label
          }
        </Select.Value>
        <Select.Icon>
          <ChevronDown
            className='size-3.5 shrink-0 text-[#8f8f8f]'
            aria-hidden
          />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side={props.side || 'bottom'}
          sideOffset={8}
          align='start'
          alignItemWithTrigger={false}
          collisionPadding={12}
          className='z-[80] outline-none'
        >
          <Select.Popup
            finalFocus={trigger}
            className='codex-zcode codex-chatgpt chatgpt-popover codex-select-menu max-h-[min(320px,var(--available-height))] max-w-[calc(100vw-24px)] min-w-[min(calc(100vw-24px),max(180px,var(--anchor-width)))] overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border border-black/10 bg-white p-1.5 text-[#202020] shadow-[0_8px_32px_#0000001a] outline-none dark:border-white/10 dark:bg-[#2f2f2f] dark:text-[#ececec]'
          >
            <Select.List aria-label={props.label}>
              {props.options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className='codex-select-option relative flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none select-none data-highlighted:bg-[#f5f5f5] dark:data-highlighted:bg-[#424242]'
                >
                  <Select.ItemText className='min-w-0 flex-1'>
                    <span className='block [overflow-wrap:anywhere] break-words'>
                      {option.label}
                    </span>
                    {option.description && (
                      <span className='mt-0.5 block text-xs leading-5 text-[#737373] dark:text-[#b4b4b4]'>
                        {option.description}
                      </span>
                    )}
                  </Select.ItemText>
                  <Select.ItemIndicator>
                    <Check className='size-4 shrink-0' aria-hidden />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
