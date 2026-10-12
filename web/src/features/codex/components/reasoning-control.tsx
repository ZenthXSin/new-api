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
import { ChevronDown, RotateCcw, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'

import { useReasoningSelection } from '../hooks/use-reasoning-selection'
import { reasoningEffortLabel } from '../lib/reasoning-effort'
import { CodexReasoningLabel } from './reasoning-label'
import { CodexReasoningVisual } from './reasoning-visual'

export function CodexReasoningControl(props: {
  efforts: string[]
  value: string
  defaultValue?: string
  modelName: string
  modelControl?: ReactNode
  disabled?: boolean
  sliderDisabled?: boolean
  onChange: (effort: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const slider = useRef<HTMLInputElement>(null)
  const efforts = useMemo(() => [...new Set(props.efforts)], [props.efforts])
  const fixed = props.sliderDisabled || efforts.length < 2
  const selection = useReasoningSelection({
    value: props.value,
    modelName: props.modelName,
    efforts,
    disabled: !!props.disabled || !!fixed,
    onChange: props.onChange,
  })
  const index = Math.max(0, efforts.indexOf(selection.value))
  const progress = index / Math.max(1, efforts.length - 1)
  const defaultValue = efforts.includes(props.defaultValue || '')
    ? props.defaultValue
    : efforts[0]

  useEffect(() => {
    if (props.disabled) setOpen(false)
  }, [props.disabled])

  return (
    <Popover
      open={open && !props.disabled}
      onOpenChange={(next) => {
        if (!next) selection.commit()
        setOpen(next)
      }}
    >
      <PopoverTrigger
        ref={trigger}
        render={<button type='button' />}
        role='combobox'
        aria-label={t('Reasoning effort')}
        aria-expanded={open && !props.disabled}
        disabled={props.disabled}
        className='codex-reasoning-trigger codex-effort-select flex min-w-0 items-center justify-center gap-1.5 rounded-full px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50'
      >
        <span className='truncate' title={props.modelName}>
          {props.modelName}
        </span>
        <span aria-hidden className='opacity-40'>
          ·
        </span>
        <span className='shrink-0'>
          {reasoningEffortLabel(selection.value)}
        </span>
        <ChevronDown aria-hidden className='size-3.5 shrink-0' />
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='end'
        sideOffset={12}
        collisionPadding={12}
        initialFocus={fixed ? undefined : slider}
        finalFocus={trigger}
        className='codex-zcode codex-chatgpt chatgpt-popover codex-reasoning-menu w-[min(256px,calc(100vw-24px))] gap-3 rounded-2xl p-3'
      >
        <div className='grid grid-cols-[24px_minmax(0,1fr)_24px] items-start gap-2'>
          <Zap className='mt-1 size-3.5 text-[#8f8f8f]' aria-hidden />
          <div className='min-w-0 text-center'>
            <PopoverTitle className='codex-reasoning-value text-sm font-medium'>
              <CodexReasoningLabel value={selection.value} />
            </PopoverTitle>
            {props.modelControl || (
              <p
                className='mt-0.5 truncate text-xs text-[#737373] dark:text-[#b4b4b4]'
                title={props.modelName}
              >
                {props.modelName}
              </p>
            )}
          </div>
          <button
            type='button'
            aria-label={t('Reset reasoning effort')}
            title={t('Reset reasoning effort')}
            disabled={
              fixed || !defaultValue || defaultValue === selection.value
            }
            className='flex size-6 items-center justify-center rounded-full text-[#8f8f8f] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-30 dark:hover:bg-white/10'
            onClick={() => {
              if (defaultValue) selection.select(defaultValue)
            }}
          >
            <RotateCcw className='size-3.5' aria-hidden />
          </button>
        </div>
        <div
          className='codex-reasoning-track relative'
          data-effort={selection.value}
          data-max={efforts.length > 1 && index === efforts.length - 1}
        >
          <CodexReasoningVisual
            progress={progress}
            effort={selection.value}
            flowing={efforts.length > 1 && index === efforts.length - 1}
          />
          <input
            ref={slider}
            type='range'
            aria-label={t('Reasoning effort')}
            aria-valuetext={reasoningEffortLabel(selection.value)}
            min={0}
            max={Math.max(0, efforts.length - 1)}
            step={1}
            value={index}
            disabled={fixed}
            className='codex-reasoning-slider relative z-10 block w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-default'
            onPointerDown={selection.beginDrag}
            onBlur={selection.commit}
            onChange={(event) => {
              const value = efforts[Number(event.target.value)]
              if (value) selection.select(value)
            }}
          />
          <div
            aria-hidden
            className='pointer-events-none absolute inset-0 z-20 flex items-center justify-between px-3'
          >
            {efforts.map((effort, position) => (
              <span
                key={effort}
                className={
                  position <= index
                    ? 'codex-reasoning-tick size-1 rounded-full bg-white/50'
                    : 'codex-reasoning-tick size-1 rounded-full bg-black/20 dark:bg-white/20'
                }
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
