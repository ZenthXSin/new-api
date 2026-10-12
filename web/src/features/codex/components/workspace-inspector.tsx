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
import { GitCompareArrows, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import type { CodexThread } from '../types'
import { Button } from '../vendor/zcode/button'
import { WorkspaceDiff } from './workspace-diff'
import { WorkspaceFiles } from './workspace-files'
import { WorkspaceLogs } from './workspace-logs'

export function WorkspaceInspector(props: {
  id: string
  actor: string
  running: boolean
  diffBlocked?: boolean
  readOnly?: boolean
  onBusy?: (busy: boolean) => void
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
    { id: 'diff' as const, label: t('Changes') },
    { id: 'files' as const, label: t('Files') },
    { id: 'logs' as const, label: t('Logs') },
  ]
  return (
    <section
      className='codex-workspace-inspector bg-background border-border flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:border-l'
      aria-label={t('Project inspector')}
    >
      <header className='bg-background border-border flex h-10 shrink-0 items-center gap-3 border-b px-4 max-sm:h-11 max-sm:px-2'>
        <div
          className='flex h-full min-w-0 items-stretch gap-1 overflow-x-auto'
          role='tablist'
          aria-label={t('Project panels')}
          onKeyDown={(event) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
            if (!keys.includes(event.key)) return
            event.preventDefault()
            const index = tabs.findIndex((tab) => tab.id === props.tab)
            let next =
              (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
              tabs.length
            if (event.key === 'Home') next = 0
            if (event.key === 'End') next = tabs.length - 1
            const tabList = event.currentTarget
            props.onTab(tabs[next].id)
            // A dirty editor can reject navigation. Focus the tab actually
            // selected by the parent after it has handled the request.
            requestAnimationFrame(() =>
              tabList
                .querySelector<HTMLButtonElement>('[aria-selected="true"]')
                ?.focus()
            )
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`${panelId}-${tab.id}`}
              type='button'
              role='tab'
              aria-selected={props.tab === tab.id}
              aria-controls={`${panelId}-panel`}
              tabIndex={props.tab === tab.id ? 0 : -1}
              className={cn(
                'inline-flex h-full min-w-0 shrink-0 items-center justify-center border-b-2 px-2.5 pt-0.5 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                props.tab === tab.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-foreground-subtle hover:text-foreground'
              )}
              onClick={() => props.onTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='text-foreground-subtle focus-visible:outline-ring ml-auto size-8 rounded-md focus-visible:outline-2 focus-visible:outline-offset-[-2px] max-sm:size-10'
          aria-label={t('Close project inspector')}
          title={t('Close project inspector')}
          onClick={props.onClose}
        >
          <X className='size-4' aria-hidden />
        </Button>
      </header>
      <div
        id={`${panelId}-panel`}
        className='focus-visible:outline-ring flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-offset-[-2px]'
        role='tabpanel'
        tabIndex={0}
        aria-labelledby={`${panelId}-${props.tab}`}
      >
        {props.tab === 'diff' && props.diffBlocked && (
          <div
            role='status'
            className='text-foreground-subtle flex flex-1 flex-col items-center justify-center gap-4 px-8 py-12 text-center text-sm leading-6'
          >
            <span className='bg-surface flex size-12 items-center justify-center rounded-2xl'>
              <GitCompareArrows className='size-5' aria-hidden />
            </span>
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
            readOnly={props.readOnly}
            onBusy={props.onBusy}
            showGitActions
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
            readOnly={props.readOnly}
            onBusy={props.onBusy}
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
