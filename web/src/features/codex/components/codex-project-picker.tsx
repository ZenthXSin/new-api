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
import {
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  LoaderCircle,
  Plus,
  Search,
  Server,
  Settings2,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'

import type { CodexRepository, CodexWorkspace } from '../types'

const pickerItemClassName =
  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none select-none data-[selected=true]:bg-black/5 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 dark:data-[selected=true]:bg-white/10'

function ContextPicker(props: {
  label: string
  searchLabel: string
  icon: ReactNode
  value: ReactNode
  selectedValue?: string
  resetKey?: string
  disabled?: boolean
  children: (close: () => void) => ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.disabled) setOpen(false)
  }, [props.disabled])

  return (
    <Popover
      open={open && !props.disabled}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSearch('')
      }}
    >
      <PopoverTrigger
        ref={trigger}
        render={<button type='button' />}
        role='combobox'
        aria-label={t(props.label)}
        disabled={props.disabled}
        className='codex-context-picker flex h-9 max-w-52 min-w-0 shrink items-center gap-2 rounded-lg px-2 text-sm text-[#303030] transition-colors outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#8e8e8e]/50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#ececec] dark:hover:bg-white/10'
      >
        {props.icon}
        <span className='min-w-0 truncate'>{props.value}</span>
        <ChevronDown
          aria-hidden
          className='text-muted-foreground size-3.5 shrink-0'
        />
      </PopoverTrigger>
      <PopoverContent
        className='codex-zcode codex-chatgpt chatgpt-popover max-h-[min(520px,calc(100dvh-24px),var(--available-height))] w-[min(320px,calc(100vw-24px))] gap-0 overflow-hidden rounded-2xl p-0'
        side='top'
        align='start'
        sideOffset={8}
        collisionPadding={12}
        initialFocus={input}
        finalFocus={trigger}
      >
        <Command
          key={props.resetKey}
          label={t(props.searchLabel)}
          defaultValue={props.selectedValue}
          loop
          className='flex min-h-0 flex-col'
        >
          <PopoverTitle className='text-muted-foreground px-4 pt-3 pb-2 text-xs font-medium'>
            {t(props.label)}
          </PopoverTitle>
          <div className='mx-2 flex h-10 shrink-0 items-center gap-2 rounded-lg bg-black/5 px-3 dark:bg-white/5'>
            <Search
              aria-hidden
              className='text-muted-foreground size-4 shrink-0'
            />
            <Command.Input
              ref={input}
              value={search}
              onValueChange={setSearch}
              placeholder={t(props.searchLabel)}
              className='h-full w-full min-w-0 bg-transparent text-base outline-none placeholder:text-[#707070] sm:text-sm dark:placeholder:text-[#b4b4b4]'
            />
          </div>
          <Command.List
            label={t(props.label)}
            className='max-h-[min(360px,50dvh)] min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain p-2'
          >
            {props.children(() => setOpen(false))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function CodexProjectPicker(props: {
  workspaces: CodexWorkspace[]
  selected?: string
  onSelect: (id?: string) => void
  onCreate: () => void
  onConnections?: () => void
  disabled?: boolean
  loading?: boolean
}) {
  const { t } = useTranslation()
  const workspaces = props.workspaces.filter((workspace) => !workspace.archived)
  const selected = workspaces.find(
    (workspace) => workspace.id === props.selected
  )

  return (
    <ContextPicker
      label={t('Choose project')}
      searchLabel={t('Search projects')}
      icon={
        selected?.remote ? (
          <Server aria-hidden className='size-4 shrink-0' />
        ) : (
          <Folder aria-hidden className='size-4 shrink-0' />
        )
      }
      value={selected?.name || t('Choose project')}
      selectedValue={props.selected || 'blank-workspace'}
      disabled={props.disabled}
    >
      {(close) => (
        <>
          {!props.loading && (
            <Command.Empty className='text-muted-foreground px-3 py-5 text-center text-sm'>
              {t('No matching projects')}
            </Command.Empty>
          )}
          {props.loading && (
            <p
              role='status'
              className='text-muted-foreground flex items-center justify-center gap-2 px-3 py-5 text-sm'
            >
              <LoaderCircle
                aria-hidden
                className='size-4 animate-spin motion-reduce:animate-none'
              />
              {t('Loading projects…')}
            </p>
          )}
          {!props.loading &&
            workspaces.map((workspace) => (
              <Command.Item
                key={workspace.id}
                value={workspace.id}
                keywords={[
                  workspace.name,
                  workspace.remote?.host || '',
                  workspace.remote?.path || '',
                ]}
                data-checked={workspace.id === props.selected}
                className={pickerItemClassName}
                onSelect={() => {
                  if (props.disabled) return
                  props.onSelect(workspace.id)
                  close()
                }}
              >
                {workspace.remote ? (
                  <Server aria-hidden className='size-4 shrink-0' />
                ) : (
                  <Folder aria-hidden className='size-4 shrink-0' />
                )}
                <span className='min-w-0 flex-1 [overflow-wrap:anywhere] break-words'>
                  <span className='block'>{workspace.name}</span>
                  {workspace.remote && (
                    <span className='text-muted-foreground mt-0.5 block text-xs'>
                      {workspace.remote.username}@{workspace.remote.host}:
                      {workspace.remote.path}
                    </span>
                  )}
                </span>
                {workspace.id === props.selected && (
                  <Check aria-hidden className='size-4 shrink-0' />
                )}
              </Command.Item>
            ))}
          <Command.Item
            value='blank-workspace'
            keywords={[t('Blank workspace')]}
            className={pickerItemClassName}
            onSelect={() => {
              if (props.disabled) return
              props.onSelect(undefined)
              close()
            }}
          >
            <Folder aria-hidden className='size-4 shrink-0' />
            <span className='min-w-0 flex-1'>{t('Blank workspace')}</span>
            {!props.selected && (
              <Check aria-hidden className='size-4 shrink-0' />
            )}
          </Command.Item>
          <Command.Item
            value='new-project'
            keywords={[t('New project')]}
            className={pickerItemClassName}
            onSelect={() => {
              if (props.disabled) return
              close()
              props.onCreate()
            }}
          >
            <Plus aria-hidden className='size-4 shrink-0' />
            {t('New project')}
          </Command.Item>
          {props.onConnections && (
            <Command.Item
              value='connections'
              keywords={[t('Connections')]}
              className={pickerItemClassName}
              onSelect={() => {
                if (props.disabled) return
                close()
                props.onConnections?.()
              }}
            >
              <Settings2 aria-hidden className='size-4 shrink-0' />
              {t('Connections')}
            </Command.Item>
          )}
        </>
      )}
    </ContextPicker>
  )
}

export function CodexBranchPicker(props: {
  repository?: CodexRepository
  loading?: boolean
  error?: boolean | string
  onRetry?: () => void
  onSelect: (branch: string, remote?: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const repository = props.repository
  let label = repository?.branch || t('Select branch')
  if (repository?.detached) {
    label = repository.head?.slice(0, 7) || t('Detached HEAD')
  }
  let checkoutExplanation = ''
  if (repository?.dirty) {
    checkoutExplanation = t(
      'Commit or stash your changes before switching branches.'
    )
  } else if (repository?.checkoutSupported === false) {
    if (repository.checkoutReason === 'submodules') {
      checkoutExplanation = t(
        'Switch branches locally for repositories with submodules.'
      )
    } else if (repository.checkoutReason === 'operation_in_progress') {
      checkoutExplanation = t(
        'Finish the Git operation before switching branches.'
      )
    } else {
      checkoutExplanation = t(
        'Branch switching is unavailable for this repository.'
      )
    }
  }
  const available = repository?.available && !props.error && !props.loading
  const branches = repository?.branches || []
  const sections = [
    {
      name: t('Local branches'),
      branches: branches.filter((branch) => !branch.remote),
    },
    {
      name: t('Remote branches'),
      branches: branches.filter((branch) => branch.remote),
    },
  ]

  return (
    <ContextPicker
      label={t('Select branch')}
      searchLabel={t('Search branches')}
      icon={<GitBranch aria-hidden className='size-4 shrink-0' />}
      value={label}
      selectedValue={branches.find((branch) => branch.current)?.ref}
      resetKey={String(props.error || props.loading || '')}
      disabled={props.disabled}
    >
      {(close) => (
        <>
          {props.loading && (
            <p
              role='status'
              className='text-muted-foreground flex items-center justify-center gap-2 px-3 py-5 text-sm'
            >
              <LoaderCircle
                aria-hidden
                className='size-4 animate-spin motion-reduce:animate-none'
              />
              {t('Loading branches…')}
            </p>
          )}
          {props.error && (
            <div
              role='alert'
              className='text-muted-foreground space-y-2 px-3 py-5 text-sm'
            >
              <p>
                {typeof props.error === 'string'
                  ? t(props.error)
                  : t('Branches could not be loaded.')}
              </p>
              {props.onRetry && (
                <button
                  type='button'
                  onClick={props.onRetry}
                  className='border-border text-foreground focus-visible:ring-ring rounded-full border px-4 py-2 text-sm outline-none hover:bg-black/5 focus-visible:ring-2 dark:hover:bg-white/10'
                >
                  {t('Retry')}
                </button>
              )}
            </div>
          )}
          {!props.error && !props.loading && !repository?.available && (
            <p
              role='status'
              className='text-muted-foreground px-3 py-5 text-sm'
            >
              {repository
                ? t('This project is not a Git repository.')
                : t('Choose a project to view branches.')}
            </p>
          )}
          {available && (
            <>
              {checkoutExplanation && (
                <p
                  role='status'
                  className='text-muted-foreground px-3 py-3 text-xs leading-5'
                >
                  {checkoutExplanation}
                </p>
              )}
              {repository.detached && (
                <p className='text-muted-foreground px-3 py-2 text-xs'>
                  {t('Detached HEAD')}
                </p>
              )}
              <Command.Empty className='text-muted-foreground px-3 py-5 text-center text-sm'>
                {t('No matching branches')}
              </Command.Empty>
              {sections.map(
                (section) =>
                  section.branches.length > 0 && (
                    <Command.Group
                      key={section.name}
                      heading={section.name}
                      className='[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium'
                    >
                      {section.branches.map((branch) => (
                        <Command.Item
                          key={branch.ref}
                          value={branch.ref}
                          keywords={[branch.name, branch.remote || '']}
                          disabled={!!checkoutExplanation || branch.current}
                          data-checked={branch.current}
                          className={pickerItemClassName}
                          onSelect={() => {
                            if (
                              props.disabled ||
                              !!checkoutExplanation ||
                              branch.current
                            ) {
                              return
                            }
                            props.onSelect(
                              branch.name,
                              branch.remote || undefined
                            )
                            close()
                          }}
                        >
                          <GitBranch aria-hidden className='size-4 shrink-0' />
                          <span className='min-w-0 flex-1 [overflow-wrap:anywhere] break-words'>
                            {branch.remote
                              ? `${branch.remote}/${branch.name}`
                              : branch.name}
                          </span>
                          {branch.current && (
                            <Check aria-hidden className='size-4 shrink-0' />
                          )}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )
              )}
              {repository.branchesTruncated && (
                <p
                  role='status'
                  className='text-muted-foreground px-3 py-2 text-xs'
                >
                  {t('Some branches are not shown.')}
                </p>
              )}
            </>
          )}
        </>
      )}
    </ContextPicker>
  )
}
