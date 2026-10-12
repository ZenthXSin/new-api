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
import { Command } from 'cmdk'
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'

import type { CodexCatalog, CodexStatus } from '../types'
import { cn } from '../vendor/zcode/utils'
import { CodexSelect } from './select'

export function CodexModelSelector(props: {
  catalog?: CodexCatalog
  status?: CodexStatus
  model: string
  group?: string
  disabled?: boolean
  loading?: boolean
  error?: boolean
  onRetry?: () => void
  onSelect: (model: string, group: string) => void
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [filterGroup, setFilterGroup] = useState('')
  const [search, setSearch] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.disabled) setOpen(false)
  }, [props.disabled])
  const groups = useMemo<CodexCatalog['groups']>(
    () =>
      props.catalog?.groups ?? [
        {
          id: props.group || '',
          name: props.group || t('Available models'),
          description: '',
          ratio: null,
          models:
            props.status?.models.map((model) => ({
              ...model,
              name: model.name || model.id,
              supported: true,
            })) ?? [],
        },
      ],
    [props.catalog, props.group, props.status, t]
  )
  const currentGroup =
    groups.find((group) => group.id === props.group) ??
    groups.find((group) =>
      group.models.some((model) => model.id === props.model)
    )
  const currentModel = currentGroup?.models.find(
    (model) => model.id === props.model
  )
  const visible = groups.filter(
    (group) => !filterGroup || filterGroup === group.id
  )

  return (
    <Popover
      open={open && !props.disabled}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setSearch('')
          setFilterGroup('')
        }
      }}
    >
      <PopoverTrigger
        ref={trigger}
        render={<button type='button' />}
        role='combobox'
        aria-label={t('Codex model')}
        aria-expanded={open && !props.disabled}
        disabled={props.disabled}
        className={cn(
          'codex-composer-select codex-model-trigger flex h-10 max-w-[min(15rem,100%)] min-w-0 shrink items-center gap-1.5 rounded-xl px-2.5 text-left text-sm font-medium text-[#303030] outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#8e8e8e]/50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#ececec] dark:hover:bg-white/10 sm:max-w-[min(18rem,100%)]',
          props.className
        )}
      >
        <span className='min-w-0 truncate'>
          {currentModel?.name || props.model || t('Select a model')}
        </span>
        <ChevronDown aria-hidden className='size-4 shrink-0 text-[#8f8f8f]' />
      </PopoverTrigger>
      <PopoverContent
        className='codex-zcode codex-chatgpt chatgpt-popover codex-model-menu max-h-[min(520px,calc(100dvh-24px),var(--available-height))] w-[min(344px,calc(100vw-24px))] gap-0 overflow-hidden rounded-2xl border border-black/10 bg-white p-0 text-[#202020] shadow-[0_8px_32px_#0000001a] ring-0 dark:border-white/10 dark:bg-[#2f2f2f] dark:text-[#ececec]'
        side={props.side || 'top'}
        align={props.align || 'start'}
        sideOffset={8}
        collisionPadding={12}
        initialFocus={searchInput}
        finalFocus={trigger}
      >
        <Command
          label={t('Search all models')}
          defaultValue={`${currentGroup?.id || ''} ${props.model}`}
          loop
          className='flex min-h-0 flex-col'
        >
          <div className='px-3 pt-3'>
            <PopoverTitle className='px-1 pb-2 text-xs font-medium text-[#737373] dark:text-[#b4b4b4]'>
              {t('Available models')}
            </PopoverTitle>
            <div className='flex h-10 items-center gap-2 rounded-lg bg-[#f5f5f5] px-3 dark:bg-[#212121]'>
              <Search aria-hidden className='size-4 shrink-0 text-[#8f8f8f]' />
              <Command.Input
                ref={searchInput}
                aria-label={t('Search all models')}
                placeholder={t('Search models or groups')}
                value={search}
                onValueChange={setSearch}
                className='h-full w-full min-w-0 bg-transparent text-base outline-none placeholder:text-[#707070] sm:text-sm dark:placeholder:text-[#b4b4b4]'
              />
            </div>
            {groups.length > 1 && (
              <div
                className='mt-1 flex min-w-0 items-center gap-2 px-1 text-xs text-[#737373] dark:text-[#b4b4b4]'
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' && event.key !== 'Tab') {
                    event.stopPropagation()
                  }
                }}
              >
                <span>{t('Group')}</span>
                <CodexSelect
                  compact
                  label={t('Model group')}
                  value={filterGroup}
                  options={[
                    { value: '', label: t('All groups') },
                    ...groups.map((group) => ({
                      value: group.id,
                      label: group.name,
                    })),
                  ]}
                  onChange={setFilterGroup}
                  className='ml-auto max-w-[75%]'
                />
              </div>
            )}
          </div>
          <Command.List
            label={t('Available models')}
            aria-busy={props.loading || undefined}
            className='max-h-[min(360px,50dvh,var(--available-height))] min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain p-2 outline-none'
          >
            {props.loading && !props.error && (
              <div
                role='status'
                className='flex items-center justify-center gap-2 px-4 py-8 text-sm text-[#737373] dark:text-[#b4b4b4]'
              >
                <LoaderCircle
                  aria-hidden
                  className='size-4 animate-spin motion-reduce:animate-none'
                />
                {t('Loading models…')}
              </div>
            )}
            {props.error && (
              <div
                role='alert'
                className='space-y-3 px-4 py-6 text-center text-sm'
              >
                <p className='text-[#737373] dark:text-[#b4b4b4]'>
                  {t(
                    'Models could not be loaded. Try again before starting a task.'
                  )}
                </p>
                {props.onRetry && (
                  <button
                    type='button'
                    onClick={props.onRetry}
                    className='rounded-full border border-black/15 px-4 py-2 font-medium outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#8e8e8e]/50 dark:border-white/20 dark:hover:bg-white/10'
                  >
                    {t('Retry')}
                  </button>
                )}
              </div>
            )}
            {!props.loading && !props.error && (
              <>
                <Command.Empty className='px-4 py-8 text-center text-sm text-[#737373] dark:text-[#b4b4b4]'>
                  {t('No matching models')}
                </Command.Empty>
                {visible.map((group) => (
                  <Command.Group
                    key={group.id}
                    heading={groups.length > 1 ? group.name : undefined}
                    className='[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[#737373] dark:[&_[cmdk-group-heading]]:text-[#b4b4b4] [&+[cmdk-group]]:mt-2'
                  >
                    {group.models.map((model) => {
                      const selected =
                        model.id === props.model &&
                        group.id === currentGroup?.id
                      return (
                        <Command.Item
                          key={model.id}
                          value={`${group.id} ${model.id}`}
                          keywords={[model.name, group.name]}
                          disabled={!model.supported}
                          data-checked={selected}
                          onSelect={() => {
                            if (!model.supported || props.disabled) return
                            props.onSelect(model.id, group.id)
                            setOpen(false)
                          }}
                          className='flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 outline-none select-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-45 data-[selected=true]:bg-[#f5f5f5] dark:data-[selected=true]:bg-[#424242]'
                        >
                          <span className='min-w-0 flex-1'>
                            <span className='block text-sm font-medium [overflow-wrap:anywhere] break-words'>
                              {model.name || model.id}
                            </span>
                            {!model.supported && (
                              <span className='mt-1 block text-xs leading-4 text-[#737373] dark:text-[#b4b4b4]'>
                                {t(
                                  model.reason ||
                                    'This model does not support coding tasks.'
                                )}
                              </span>
                            )}
                          </span>
                          {selected && (
                            <Check aria-hidden className='size-4 shrink-0' />
                          )}
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                ))}
              </>
            )}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
