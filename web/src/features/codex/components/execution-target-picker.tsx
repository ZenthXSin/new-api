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
import { Menu } from '@base-ui/react/menu'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  Cloud,
  Container,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  Settings2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { codexError } from '../api'
import { cloudApi, cloudEnvironmentQueryKey } from '../cloud-api'
import type { ExecutionTarget } from '../cloud-types'
import { cn } from '../vendor/zcode/utils'

export type { ExecutionTarget } from '../cloud-types'

export function ExecutionTargetPicker(props: {
  actor?: string
  value: ExecutionTarget
  onChange: (value: ExecutionTarget) => void
  onManageEnvironments: () => void
  onCreateEnvironment: () => void
  disabled?: boolean
  allowHost?: boolean
}) {
  const { t } = useTranslation()
  const [targetOpen, setTargetOpen] = useState(false)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const environments = useQuery({
    queryKey: cloudEnvironmentQueryKey(props.actor),
    queryFn: ({ signal }) => cloudApi.list(signal),
    enabled:
      !props.disabled && (props.value.type === 'cloud' || environmentOpen),
    staleTime: 15_000,
    retry: false,
  })
  const published = (environments.data?.environments ?? []).filter(
    (environment) =>
      environment.publishedVersion !== null && environment.published !== null
  )
  const selected = published.find(
    (environment) => environment.id === props.value.environmentId
  )
  const targets: {
    type: ExecutionTarget['type']
    label: string
    description: string
    icon: typeof Server
  }[] = [
    {
      type: 'cloud' as const,
      label: t('Cloud'),
      description: t('Published environments on this site'),
      icon: Cloud,
    },
    {
      type: 'docker' as const,
      label: 'Docker',
      description: t('Your personal Docker environment'),
      icon: Container,
    },
    {
      type: 'ssh' as const,
      label: 'SSH',
      description: t('A connected remote server'),
      icon: Server,
    },
  ]
  if (props.allowHost) {
    targets.push({
      type: 'host',
      label: t('Host'),
      description: t('Run directly on the server (administrators only)'),
      icon: Server,
    })
  }
  const target =
    targets.find((entry) => entry.type === props.value.type) ?? targets[0]
  const TargetIcon = target.icon
  const itemClass =
    'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none data-highlighted:bg-muted'

  return (
    <div className='codex-execution-target-picker flex min-w-0 flex-wrap items-center gap-1.5'>
      <Menu.Root
        open={targetOpen && !props.disabled}
        onOpenChange={setTargetOpen}
      >
        <Menu.Trigger
          disabled={props.disabled}
          aria-label={t('Work in')}
          className='codex-execution-target-trigger hover:bg-muted focus-visible:ring-ring flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm outline-none focus-visible:ring-2 disabled:opacity-50'
        >
          <TargetIcon className='text-muted-foreground size-4' aria-hidden />
          <span>{target.label}</span>
          <ChevronDown className='text-muted-foreground size-3.5' aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            sideOffset={8}
            align='start'
            collisionPadding={12}
            className='z-[85]'
          >
            <Menu.Popup className='codex-zcode codex-chatgpt chatgpt-popover codex-execution-target-menu bg-popover text-popover-foreground w-72 max-w-[calc(100vw-24px)] rounded-2xl border p-1.5 shadow-lg outline-none'>
              <Menu.Group>
                <Menu.GroupLabel className='text-muted-foreground px-3 py-2 text-xs'>
                  {t('Work in')}
                </Menu.GroupLabel>
                {targets.map((entry) => {
                  const Icon = entry.icon
                  return (
                    <Menu.Item
                      key={entry.type}
                      className={itemClass}
                      onClick={() => props.onChange({ type: entry.type })}
                    >
                      <Icon className='size-4 shrink-0' aria-hidden />
                      <span className='min-w-0 flex-1'>
                        <span className='block'>{entry.label}</span>
                        <span className='text-muted-foreground block text-xs leading-5'>
                          {entry.description}
                        </span>
                      </span>
                      {props.value.type === entry.type && (
                        <Check className='size-4' aria-hidden />
                      )}
                    </Menu.Item>
                  )
                })}
              </Menu.Group>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {props.value.type === 'cloud' && (
        <Menu.Root
          open={environmentOpen && !props.disabled}
          onOpenChange={setEnvironmentOpen}
        >
          <Menu.Trigger
            disabled={props.disabled}
            aria-label={t('Select environment')}
            className={cn(
              'codex-execution-target-trigger hover:bg-muted focus-visible:ring-ring flex h-9 min-w-0 max-w-64 items-center gap-2 rounded-lg px-2.5 text-sm outline-none focus-visible:ring-2 disabled:opacity-50',
              !selected && 'text-muted-foreground'
            )}
          >
            <span className='truncate'>
              {selected?.name || t('Select environment')}
            </span>
            <ChevronDown
              className='text-muted-foreground size-3.5 shrink-0'
              aria-hidden
            />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              sideOffset={8}
              align='start'
              collisionPadding={12}
              className='z-[85]'
            >
              <Menu.Popup className='codex-zcode codex-chatgpt chatgpt-popover codex-execution-target-menu bg-popover text-popover-foreground w-80 max-w-[calc(100vw-24px)] rounded-2xl border p-1.5 shadow-lg outline-none'>
                <Menu.Group>
                  <Menu.GroupLabel className='text-muted-foreground px-3 py-2 text-xs'>
                    {t('Published environments')}
                  </Menu.GroupLabel>
                  <div className='max-h-64 overflow-y-auto overscroll-contain'>
                    {environments.isPending && (
                      <p
                        role='status'
                        className='text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm'
                      >
                        <LoaderCircle
                          className='size-4 animate-spin'
                          aria-hidden
                        />
                        {t('Loading environments...')}
                      </p>
                    )}
                    {environments.isError && (
                      <p
                        role='alert'
                        className='text-destructive px-3 py-2 text-sm'
                      >
                        {t(codexError(environments.error))}
                      </p>
                    )}
                    {environments.isError && (
                      <Menu.Item
                        className={itemClass}
                        onClick={() => void environments.refetch()}
                      >
                        <RefreshCw className='size-4' aria-hidden />
                        {t('Retry')}
                      </Menu.Item>
                    )}
                    {!environments.isPending &&
                      !environments.isError &&
                      published.length === 0 && (
                        <p className='text-muted-foreground px-3 py-4 text-sm'>
                          {t('Publish an environment to start a cloud task.')}
                        </p>
                      )}
                    {published.map((environment) => (
                      <Menu.Item
                        key={environment.id}
                        className={itemClass}
                        onClick={() =>
                          props.onChange({
                            type: 'cloud',
                            environmentId: environment.id,
                          })
                        }
                      >
                        <Cloud className='size-4 shrink-0' aria-hidden />
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate'>
                            {environment.name}
                          </span>
                          <span className='text-muted-foreground block text-xs'>
                            {t('Version {{version}}', {
                              version: environment.publishedVersion,
                            })}
                          </span>
                        </span>
                        {props.value.environmentId === environment.id && (
                          <Check className='size-4' aria-hidden />
                        )}
                      </Menu.Item>
                    ))}
                  </div>
                </Menu.Group>
                <Menu.Separator className='bg-border my-1 h-px' />
                <Menu.Item
                  className={itemClass}
                  onClick={props.onCreateEnvironment}
                >
                  <Plus className='size-4' aria-hidden />
                  {t('Create environment')}
                </Menu.Item>
                <Menu.Item
                  className={itemClass}
                  onClick={props.onManageEnvironments}
                >
                  <Settings2 className='size-4' aria-hidden />
                  {t('Manage environments')}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  )
}
