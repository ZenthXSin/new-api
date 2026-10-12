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
import { Collapsible } from '@base-ui/react/collapsible'
import { Dialog } from '@base-ui/react/dialog'
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Clock3,
  Cloud,
  Folder,
  FolderPlus,
  GitPullRequest,
  LoaderCircle,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  Settings,
  SquarePen,
  Terminal,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'
import { useMediaQuery } from '@/hooks/use-media-query'

import { isCodexBusy } from '../lib/events'
import type { CodexWorkspace, CodexProjectConversation } from '../types'
import { Button } from '../vendor/zcode/button'
import { WorkspaceConversations } from './workspace-conversations'

interface WorkspaceListProps {
  presentation?: 'sidebar' | 'drawer'
  tasks?: ReactNode
  onEnvironments?: () => void
  onPullRequests?: () => void
  onSettings?: () => void
  onManage?: () => void
  workspaces: CodexWorkspace[]
  conversationsByWorkspace?: Record<string, CodexProjectConversation[]>
  expandedWorkspaceIds: readonly string[]
  onToggleWorkspace: (id: string) => void
  loadingWorkspaceIds?: readonly string[]
  conversationErrors?: Record<string, string | undefined>
  onRetryConversations?: (id: string) => void
  conversationId?: string
  onConversation?: (workspaceId: string, conversationId: string) => void
  renderProjectActions?: (workspace: CodexWorkspace) => ReactNode
  conversationActionsDisabled?: boolean
  onRenameConversation?: (
    workspaceId: string,
    conversation: CodexProjectConversation
  ) => void
  onArchiveConversation?: (
    workspaceId: string,
    conversation: CodexProjectConversation
  ) => void
  onDeleteConversation?: (
    workspaceId: string,
    conversation: CodexProjectConversation
  ) => void
  onCreate?: () => void
  onConnections?: () => void
  onSearch?: () => void
  onNewChat?: () => void
  newDisabled?: boolean
  createDisabled?: boolean
  selected?: string
  open: boolean
  onClose: () => void
  onNew: (workspaceId: string) => void
  onSelect: (id: string) => void
  onBack: () => void
  loading?: boolean
  collapsed?: boolean
  onToggle?: () => void
  brand?: ReactNode
  footer?: ReactNode
}
export function WorkspaceList(props: WorkspaceListProps) {
  const { t } = useTranslation()
  const desktop = useMediaQuery('(min-width: 768px)')
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const closeButton = useRef<HTMLButtonElement>(null)
  const mobileDrawer = useRef<HTMLDivElement>(null)
  const requestedHistories = useRef(new Set<string>())
  const query = search.trim().toLocaleLowerCase()
  const selectedArchived = props.workspaces.find(
    (workspace) => workspace.id === props.selected
  )?.archived
  useEffect(() => {
    if (selectedArchived !== undefined) setArchived(!!selectedArchived)
  }, [props.selected, selectedArchived])
  const selectedWorkspace = props.workspaces.find(
    (workspace) => workspace.id === props.selected && !workspace.archived
  )
  let newChatDisabled = props.createDisabled || !props.onCreate
  if (props.onNewChat) {
    newChatDisabled = !!props.createDisabled
  } else if (selectedWorkspace) {
    newChatDisabled = props.newDisabled || isCodexBusy(selectedWorkspace.status)
  }

  useEffect(() => {
    if (!query) {
      requestedHistories.current.clear()
      return
    }
    for (const workspace of props.workspaces) {
      if (
        !!workspace.archived !== archived ||
        props.conversationsByWorkspace?.[workspace.id] ||
        props.expandedWorkspaceIds.includes(workspace.id) ||
        requestedHistories.current.has(workspace.id)
      ) {
        continue
      }
      requestedHistories.current.add(workspace.id)
      props.onToggleWorkspace(workspace.id)
    }
  }, [query, archived, props])

  const workspaces = props.workspaces
    .filter((workspace) => {
      if (!!workspace.archived !== archived) return false
      if (!query || workspace.name.toLocaleLowerCase().includes(query)) {
        return true
      }
      return props.conversationsByWorkspace?.[workspace.id]?.some(
        (conversation) => conversation.name.toLocaleLowerCase().includes(query)
      )
    })
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  const searchingHistory = !!query && !!props.loadingWorkspaceIds?.length
  const mobileDialog = !desktop || props.presentation === 'drawer'
  const collapsedRail = !!props.collapsed && desktop && !mobileDialog

  function startNewChat() {
    if (mobileDialog) props.onClose()
    if (props.onNewChat) props.onNewChat()
    else if (selectedWorkspace) props.onNew(selectedWorkspace.id)
    else props.onCreate?.()
  }

  const content = (
    <>
      <header className='chatgpt-sidebar-header flex h-14 shrink-0 items-center gap-2 px-3'>
        <div
          aria-hidden={collapsedRail || undefined}
          inert={collapsedRail || undefined}
          className='chatgpt-sidebar-brand flex min-w-0 flex-1 items-center gap-2'
        >
          {props.brand || (
            <span className='flex items-center gap-2 px-1 text-base font-medium'>
              <Terminal className='size-5' aria-hidden />
              Codex
            </span>
          )}
        </div>
        {props.onSearch && !collapsedRail && (
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='chatgpt-sidebar-search chatgpt-icon-button size-9 rounded-lg'
            aria-label={t('Search tasks')}
            title={t('Search tasks')}
            onClick={() => {
              if (mobileDialog) props.onClose()
              props.onSearch?.()
            }}
          >
            <Search className='size-4' aria-hidden />
          </Button>
        )}
        {mobileDialog ? (
          <Dialog.Close
            ref={closeButton}
            render={
              <Button
                variant='ghost'
                size='icon-md'
                className='chatgpt-icon-button ml-auto size-11 rounded-lg'
              />
            }
            aria-label={t('Close project list')}
          >
            <PanelLeftClose className='size-5' aria-hidden />
          </Dialog.Close>
        ) : (
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='chatgpt-sidebar-toggle chatgpt-icon-button hidden size-9 rounded-lg md:inline-flex'
            aria-label={t(
              props.collapsed ? 'Open project list' : 'Close project list'
            )}
            title={t(
              props.collapsed ? 'Open project list' : 'Close project list'
            )}
            onClick={props.onToggle}
          >
            {props.collapsed ? (
              <PanelLeftOpen className='size-5' />
            ) : (
              <PanelLeftClose className='size-5' />
            )}
          </Button>
        )}
      </header>
      {desktop && !mobileDialog && (
        <div
          className='chatgpt-sidebar-rail flex flex-col items-center gap-1 px-2'
          aria-hidden={!collapsedRail || undefined}
          inert={!collapsedRail || undefined}
        >
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='chatgpt-icon-button size-9 rounded-lg'
            aria-label={t('New task')}
            title={t('New task')}
            disabled={newChatDisabled}
            onClick={startNewChat}
          >
            <SquarePen className='size-5' aria-hidden />
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='chatgpt-icon-button size-9 rounded-lg'
            aria-label={t('Search tasks')}
            title={t('Search tasks')}
            disabled={!props.onSearch && !props.onToggle}
            onClick={() => {
              if (props.onSearch) props.onSearch()
              else props.onToggle?.()
            }}
          >
            <Search className='size-5' aria-hidden />
          </Button>
        </div>
      )}
      <div
        aria-hidden={collapsedRail || undefined}
        inert={collapsedRail || undefined}
        className='chatgpt-sidebar-expanded flex min-h-0 flex-1 flex-col'
      >
        <div className='space-y-0.5 px-2'>
          <Button
            type='button'
            variant='ghost'
            className='chatgpt-nav-item min-h-11 w-full justify-start gap-3 rounded-lg px-3 text-sm font-normal md:min-h-9'
            disabled={newChatDisabled}
            onClick={startNewChat}
          >
            <SquarePen className='size-5' aria-hidden />
            {t('New task')}
          </Button>
          {!props.onSearch && (
            <label className='chatgpt-search-field text-foreground hover:bg-hover focus-within:bg-hover flex min-h-11 items-center gap-3 rounded-lg px-3 md:min-h-9'>
              <Search aria-hidden className='size-5 shrink-0' />
              <input
                aria-label={t('Search projects')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && search) {
                    event.preventDefault()
                    event.stopPropagation()
                    setSearch('')
                  }
                }}
                className='placeholder:text-foreground w-full min-w-0 border-0 bg-transparent text-base outline-none md:text-sm'
                placeholder={t('Search tasks')}
              />
              {!!search && (
                <button
                  type='button'
                  aria-label={t('Clear project search')}
                  className='text-muted-foreground hover:text-foreground -mr-2 flex size-9 shrink-0 items-center justify-center rounded-lg'
                  onClick={() => setSearch('')}
                >
                  <X className='size-4' aria-hidden />
                </button>
              )}
            </label>
          )}
          <div className='chatgpt-sidebar-shortcuts space-y-0.5'>
            {props.onPullRequests && (
              <Button
                type='button'
                variant='ghost'
                className='chatgpt-nav-item min-h-11 w-full justify-start gap-2.5 rounded-lg px-3 text-sm font-normal md:min-h-8'
                title={t('Pull requests')}
                onClick={() => {
                  if (mobileDialog) props.onClose()
                  props.onPullRequests?.()
                }}
              >
                <GitPullRequest className='size-4' aria-hidden />
                <span className='max-w-full truncate'>
                  {t('Pull requests')}
                </span>
              </Button>
            )}
            {props.onEnvironments && (
              <Button
                type='button'
                variant='ghost'
                className='chatgpt-nav-item min-h-11 w-full justify-start gap-2.5 rounded-lg px-3 text-sm font-normal md:min-h-8'
                title={t('Environments')}
                onClick={() => {
                  if (mobileDialog) props.onClose()
                  props.onEnvironments?.()
                }}
              >
                <Cloud className='size-4' aria-hidden />
                <span className='max-w-full truncate'>{t('Environments')}</span>
              </Button>
            )}
            {props.onConnections && (
              <Button
                type='button'
                variant='ghost'
                className='chatgpt-nav-item min-h-11 w-full justify-start gap-2.5 rounded-lg px-3 text-sm font-normal md:min-h-8'
                title={t('Connections')}
                onClick={() => {
                  if (mobileDialog) props.onClose()
                  props.onConnections?.()
                }}
              >
                <Plug className='size-4' aria-hidden />
                <span className='max-w-full truncate'>{t('Connections')}</span>
              </Button>
            )}
          </div>
        </div>
        <nav
          aria-label={t('Project history')}
          className='chatgpt-sidebar-body min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pb-3'
        >
          <div className='chatgpt-project-heading mt-2 flex min-h-8 items-center justify-between gap-1 px-3'>
            <button
              type='button'
              className='chatgpt-section-label flex min-h-8 items-center gap-1.5 rounded-lg text-left'
              aria-expanded={projectsOpen}
              aria-controls='codex-sidebar-projects'
              onClick={() => setProjectsOpen(!projectsOpen)}
            >
              {archived ? t('Archived projects') : t('Projects')}
              <ChevronDown
                aria-hidden
                className={cn(
                  'size-3.5 transition-transform duration-200',
                  !projectsOpen && '-rotate-90'
                )}
              />
            </button>
            <div className='chatgpt-project-tools flex items-center gap-0.5'>
              {props.onManage && (
                <Button
                  type='button'
                  size='icon-md'
                  variant='ghost'
                  className='chatgpt-icon-button size-9'
                  aria-label={t('Manage projects and conversations')}
                  title={t('Manage projects and conversations')}
                  onClick={props.onManage}
                >
                  <ListChecks className='size-4' aria-hidden />
                </Button>
              )}
              <Button
                type='button'
                size='icon-md'
                variant='ghost'
                className='chatgpt-icon-button size-9'
                aria-label={t('New project')}
                title={t('New project')}
                onClick={props.onCreate}
                disabled={props.createDisabled || !props.onCreate}
              >
                <FolderPlus className='size-4' aria-hidden />
              </Button>
              <Button
                type='button'
                size='icon-md'
                variant='ghost'
                className='chatgpt-icon-button size-9'
                aria-pressed={archived}
                aria-label={t('Show archived projects')}
                title={t('Show archived projects')}
                onClick={() => setArchived(!archived)}
              >
                <Archive className='size-4' aria-hidden />
              </Button>
            </div>
          </div>
          {(props.loading || searchingHistory) && (
            <p
              role='status'
              className='text-muted-foreground flex items-center gap-2 px-3 py-4 text-xs'
            >
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
              {t(
                props.loading
                  ? 'Loading projects...'
                  : 'Loading conversations...'
              )}
            </p>
          )}
          {!props.loading && !searchingHistory && workspaces.length === 0 && (
            <div className='text-muted-foreground px-3 py-4 text-sm leading-6'>
              <p>
                {search ? t('No matching projects.') : t('No projects yet.')}
              </p>
              {!search && !archived && (
                <p className='mt-1 text-xs'>
                  {t('Start a task or import a project to begin.')}
                </p>
              )}
            </div>
          )}
          <Collapsible.Root open={projectsOpen}>
            <Collapsible.Panel
              id='codex-sidebar-projects'
              className='codex-project-history-panel'
            >
              <div className='space-y-0.5 pb-1'>
                {workspaces.map((workspace) => {
                  const expanded =
                    props.expandedWorkspaceIds.includes(workspace.id) || !!query
                  const active = workspace.id === props.selected
                  const matchingProject =
                    !!query &&
                    workspace.name.toLocaleLowerCase().includes(query)
                  return (
                    <Collapsible.Root key={workspace.id} open={expanded}>
                      <div
                        role='group'
                        aria-label={workspace.name}
                        className={cn(
                          'chatgpt-project-row group/project hover:bg-hover relative flex min-w-0 items-center rounded-lg transition-colors',
                          active && 'bg-selected'
                        )}
                      >
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-md'
                          className='size-11 shrink-0 rounded-lg md:size-8'
                          aria-label={t(
                            expanded
                              ? 'Collapse project {{name}}'
                              : 'Expand project {{name}}',
                            { name: workspace.name }
                          )}
                          aria-expanded={expanded}
                          aria-controls={`codex-project-conversations-${workspace.id}`}
                          onClick={() => {
                            if (query) setSearch('')
                            if (
                              !query ||
                              props.expandedWorkspaceIds.includes(workspace.id)
                            ) {
                              props.onToggleWorkspace(workspace.id)
                            }
                          }}
                        >
                          <span className='relative flex size-5 items-center justify-center'>
                            {expanded ? (
                              <FolderOpen
                                aria-hidden
                                className='text-muted-foreground size-4 transition-opacity group-focus-within/project:opacity-0 group-hover/project:opacity-0'
                              />
                            ) : (
                              <Folder
                                aria-hidden
                                className='text-muted-foreground size-4 transition-opacity group-focus-within/project:opacity-0 group-hover/project:opacity-0'
                              />
                            )}
                            <ChevronRight
                              aria-hidden
                              className={cn(
                                'absolute size-4 opacity-0 transition-transform group-hover/project:opacity-100 group-focus-within/project:opacity-100',
                                expanded && 'rotate-90'
                              )}
                            />
                          </span>
                        </Button>
                        <button
                          type='button'
                          aria-label={workspace.name}
                          title={workspace.name}
                          aria-current={active ? 'page' : undefined}
                          className='text-foreground focus-visible:ring-ring/30 flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-lg pr-2 text-left text-sm outline-none focus-visible:ring-2 md:min-h-8'
                          onClick={() => props.onSelect(workspace.id)}
                        >
                          <span className='min-w-0 flex-1 truncate'>
                            {workspace.name}
                          </span>
                          <WorkspaceState status={workspace.status} />
                        </button>
                        <div
                          className={cn(
                            'chatgpt-row-actions flex shrink-0 items-center gap-0.5 pr-1 md:opacity-0 md:group-hover/project:opacity-100 md:group-focus-within/project:opacity-100 md:has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100 [&_button]:size-9 md:[&_button]:size-7'
                          )}
                        >
                          {props.renderProjectActions?.(workspace)}
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-md'
                            aria-label={t('New conversation in {{name}}', {
                              name: workspace.name,
                            })}
                            title={t('New conversation')}
                            disabled={
                              props.newDisabled ||
                              workspace.archived ||
                              isCodexBusy(workspace.status)
                            }
                            onClick={() => props.onNew(workspace.id)}
                          >
                            <Plus className='size-4' aria-hidden />
                          </Button>
                        </div>
                      </div>
                      <Collapsible.Panel
                        className='codex-project-history-panel'
                        id={`codex-project-conversations-${workspace.id}`}
                      >
                        <WorkspaceConversations
                          workspaceId={workspace.id}
                          workspaceArchived={workspace.archived}
                          conversations={
                            props.conversationsByWorkspace?.[workspace.id] ?? []
                          }
                          selectedConversationId={
                            active ? props.conversationId : undefined
                          }
                          searchQuery={matchingProject ? undefined : query}
                          loading={props.loadingWorkspaceIds?.includes(
                            workspace.id
                          )}
                          error={props.conversationErrors?.[workspace.id]}
                          onRetry={props.onRetryConversations}
                          actionsDisabled={props.conversationActionsDisabled}
                          onSelect={props.onConversation}
                          onRename={props.onRenameConversation}
                          onArchive={props.onArchiveConversation}
                          onDelete={props.onDeleteConversation}
                        />
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  )
                })}
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
          {props.tasks}
        </nav>
        <div className='chatgpt-sidebar-footer flex shrink-0 items-center gap-1 px-2 py-1.5 pb-[max(6px,env(safe-area-inset-bottom))]'>
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='chatgpt-icon-button size-9 shrink-0 rounded-lg'
            aria-label={t('Back to dashboard')}
            title={t('Back to dashboard')}
            onClick={props.onBack}
          >
            <ArrowLeft className='size-4' aria-hidden />
          </Button>
          {props.onSettings && !props.footer && (
            <Button
              type='button'
              variant='ghost'
              className='chatgpt-nav-item min-h-11 w-full justify-start gap-3 px-3 text-sm'
              onClick={() => {
                if (mobileDialog) props.onClose()
                props.onSettings?.()
              }}
            >
              <Settings className='size-5' aria-hidden />
              {t('Settings')}
            </Button>
          )}
          <div className='min-w-0 flex-1'>{props.footer}</div>
        </div>
      </div>
    </>
  )

  if (mobileDialog) {
    return (
      <Dialog.Root
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose()
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className='codex-chatgpt codex-sidebar-backdrop fixed inset-0 z-40 bg-black/40' />
          <Dialog.Popup
            ref={mobileDrawer}
            aria-label={t('Codex projects')}
            aria-modal='true'
            initialFocus={() => {
              const focused = document.activeElement
              if (
                focused instanceof HTMLElement &&
                mobileDrawer.current?.contains(focused)
              ) {
                return false
              }
              return closeButton.current
            }}
            className='codex-zcode codex-chatgpt chatgpt-sidebar chatgpt-sidebar-drawer bg-sidebar fixed inset-y-0 left-0 z-50 flex w-[min(320px,86vw)] flex-col outline-none'
          >
            {content}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  if (!desktop || props.presentation === 'drawer') return null

  return (
    <aside
      aria-label={t('Codex projects')}
      data-collapsed={props.collapsed || undefined}
      className={cn(
        'chatgpt-sidebar bg-sidebar hidden shrink-0 flex-col overflow-hidden md:relative md:flex',
        props.collapsed ? 'md:w-14' : 'md:w-[300px]'
      )}
    >
      {content}
    </aside>
  )
}
export function ProjectTime(props: { value: string | number }) {
  const { i18n } = useTranslation()
  const date = new Date(props.value)
  const elapsed = Math.max(0, Date.now() - date.getTime())
  if (!Number.isFinite(elapsed)) return null
  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let count = Math.floor(elapsed / 60_000)
  if (count >= 1440) {
    unit = 'day'
    count = Math.floor(count / 1440)
  } else if (count >= 60) {
    unit = 'hour'
    count = Math.floor(count / 60)
  }
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const locale =
    ({ zhCN: 'zh-CN', zhTW: 'zh-TW' } as Record<string, string>)[language] ||
    language
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(locale)}
      className='shrink-0 tabular-nums'
    >
      {new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto',
        style: 'narrow',
      }).format(-count, unit)}
    </time>
  )
}
function WorkspaceState(props: { status: string }) {
  const { t } = useTranslation()
  if (props.status === 'running' || props.status === 'starting') {
    return (
      <LoaderCircle
        className='text-foreground size-3.5 shrink-0 animate-spin'
        aria-label={t('Running')}
      />
    )
  }
  if (props.status === 'waiting_approval') {
    return (
      <Clock3
        className='size-3.5 shrink-0 text-amber-600'
        aria-label={t('Waiting for approval')}
      />
    )
  }
  if (props.status === 'error') {
    return (
      <span
        className='bg-destructive size-1.5 shrink-0 rounded-full'
        aria-label={t('Failed')}
      />
    )
  }
  return null
}
