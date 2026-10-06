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
import { FileCode2, GitCompareArrows, Terminal, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import type { CodexThread } from '../types'
import { WorkspaceDiff } from './workspace-diff'
import { WorkspaceFiles } from './workspace-files'
import { WorkspaceLogs } from './workspace-logs'

export function WorkspaceInspector(props: {
  id: string
  actor: string
  running: boolean
  diffBlocked?: boolean
  thread: CodexThread | null
  tab: 'files' | 'diff' | 'logs'
  onTab: (tab: 'files' | 'diff' | 'logs') => void
  onClose: () => void
  onDirty?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const panelId = useId()
  const [fileToOpen, setFileToOpen] = useState<string | null>(null)
  const tabs = [
    { id: 'diff' as const, label: t('Changes'), icon: GitCompareArrows },
    { id: 'files' as const, label: t('Files'), icon: FileCode2 },
    { id: 'logs' as const, label: t('Logs'), icon: Terminal },
  ]
  return (
    <section
      className='bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:border-l'
      aria-label={t('Project inspector')}
    >
      <div className='flex h-14 shrink-0 items-center gap-2 border-b px-3'>
        <div
          className='flex min-w-0 flex-1 items-center gap-1'
          role='tablist'
          aria-label={t('Project panels')}
          onKeyDown={(event) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
            if (!keys.includes(event.key)) return
            event.preventDefault()
            const index = tabs.findIndex((tab) => tab.id === props.tab)
            let next =
              (index + (event.key === 'ArrowRight' ? 1 : 2)) % tabs.length
            if (event.key === 'Home') next = 0
            if (event.key === 'End') next = tabs.length - 1
            const tabList = event.currentTarget
            props.onTab(tabs[next].id)
            requestAnimationFrame(() =>
              tabList
                .querySelector<HTMLButtonElement>('[aria-selected="true"]')
                ?.focus()
            )
          }}
        >
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              id={`${panelId}-${tab.id}`}
              type='button'
              role='tab'
              aria-selected={props.tab === tab.id}
              aria-controls={`${panelId}-panel`}
              tabIndex={props.tab === tab.id ? 0 : -1}
              variant='ghost'
              size='sm'
              className={cn(
                'h-9 rounded-lg px-3 text-sm',
                props.tab === tab.id && 'bg-muted font-semibold'
              )}
              onClick={() => props.onTab(tab.id)}
            >
              <tab.icon className='size-4' aria-hidden />
              {tab.label}
            </Button>
          ))}
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          aria-label={t('Close project inspector')}
          onClick={props.onClose}
        >
          <X className='size-4' aria-hidden />
        </Button>
      </div>
      <div
        id={`${panelId}-panel`}
        className='flex min-h-0 min-w-0 flex-1 flex-col'
        role='tabpanel'
        aria-labelledby={`${panelId}-${props.tab}`}
      >
        {props.tab === 'diff' && props.diffBlocked && (
          <div
            role='status'
            className='text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm'
          >
            <GitCompareArrows className='size-7' aria-hidden />
            <p className='max-w-xs'>
              {t(
                'Changes will be available when your environment is ready and no other project or read-only task is running.'
              )}
            </p>
          </div>
        )}
        {props.tab === 'diff' && !props.diffBlocked && (
          <WorkspaceDiff
            id={props.id}
            actor={props.actor}
            running={props.running}
            onOpenFile={(path) => {
              setFileToOpen(path)
              props.onTab('files')
            }}
          />
        )}
        {props.tab === 'files' && (
          <WorkspaceFiles
            id={props.id}
            actor={props.actor}
            running={props.running}
            onDirty={props.onDirty}
            initialPath={fileToOpen}
            onPathConsumed={() => setFileToOpen(null)}
          />
        )}
        {props.tab === 'logs' && <WorkspaceLogs thread={props.thread} />}
      </div>
    </section>
  )
}
