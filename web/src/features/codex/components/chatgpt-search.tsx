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
import {
  Archive,
  Folder,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

import type { CodexProjectConversation, CodexWorkspace } from '../types'

export interface CodexSearchResult {
  id: string
  workspaceId: string
  workspaceName: string
  conversationId?: string
  conversationName: string
  workspaceArchived: boolean
  conversationArchived: boolean
  matchType: 'project' | 'conversation' | 'message'
  snippet: string
  turnId?: string
  role?: 'user' | 'assistant'
  updatedAt: number
}

export interface ChatGPTSearchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaces: CodexWorkspace[]
  conversationsByWorkspace: Record<string, CodexProjectConversation[]>
  onSelect: (
    workspaceId: string,
    conversationId?: string,
    turnId?: string
  ) => void
  loading?: boolean
  remoteResults?: CodexSearchResult[]
  onQueryChange?: (query: string) => void
  hasMore?: boolean
  error?: string
  onRetry?: () => void
  initialQuery?: string
}

export function ChatGPTSearch(props: ChatGPTSearchProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState(
    props.open ? (props.initialQuery ?? '') : ''
  )
  const [selectedResult, setSelectedResult] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const wasOpen = useRef(false)
  const onQueryChange = props.onQueryChange

  useEffect(() => {
    if (!props.open) {
      setQuery('')
      setSelectedResult('')
    } else if (!wasOpen.current) {
      const initialQuery = props.initialQuery ?? ''
      setQuery(initialQuery)
      setSelectedResult('')
      if (initialQuery) onQueryChange?.(initialQuery)
    }
    wasOpen.current = props.open
  }, [props.open, props.initialQuery, onQueryChange])

  const conversations = useMemo(
    () =>
      props.workspaces
        .flatMap((workspace) =>
          (props.conversationsByWorkspace[workspace.id] ?? []).map(
            (conversation) => {
              let title = conversation.name
              if (!conversation.customName) {
                if (title === 'New conversation') title = t('New task')
                const number = /^Conversation (\d+)$/.exec(title)?.[1]
                if (number) title = t('Conversation {{number}}', { number })
              }
              return { workspace, conversation, title }
            }
          )
        )
        .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt),
    [props.workspaces, props.conversationsByWorkspace, t]
  )
  const search = query.trim().normalize('NFKC').toLocaleLowerCase()
  const remoteSearch =
    !!search && (props.remoteResults !== undefined || !!props.onQueryChange)
  const remoteResults = props.remoteResults ?? []
  const remoteError = remoteSearch ? props.error : undefined
  const results = conversations.filter((result) =>
    `${result.title} ${result.workspace.name}`
      .normalize('NFKC')
      .toLocaleLowerCase()
      .includes(search)
  )
  const projects = props.workspaces.filter(
    (workspace) =>
      (search || conversations.length === 0) &&
      workspace.name.normalize('NFKC').toLocaleLowerCase().includes(search)
  )
  const hasResults = remoteSearch
    ? remoteResults.length > 0
    : results.length > 0 || projects.length > 0
  const searchDescription =
    props.onQueryChange || props.remoteResults !== undefined
      ? t(
          'Search task titles, messages, and projects, including archived tasks.'
        )
      : t('Searches loaded task titles and project names.')
  const selectableIds = remoteSearch
    ? remoteResults.map((result) => result.id)
    : [
        ...results.map(
          (result) => `task:${result.workspace.id}:${result.conversation.id}`
        ),
        ...projects.map((workspace) => `project:${workspace.id}`),
      ]
  let activeResult = ''
  if (!remoteError && !(remoteSearch && props.loading)) {
    activeResult = selectableIds.includes(selectedResult)
      ? selectedResult
      : (selectableIds[0] ?? '')
  }

  function changeOpen(open: boolean): void {
    if (!open) {
      setQuery('')
      setSelectedResult('')
      props.onQueryChange?.('')
    }
    props.onOpenChange(open)
  }

  function select(
    workspaceId: string,
    conversationId?: string,
    turnId?: string
  ): void {
    if (remoteSearch && (props.loading || remoteError)) return
    changeOpen(false)
    if (turnId) props.onSelect(workspaceId, conversationId, turnId)
    else props.onSelect(workspaceId, conversationId)
  }

  return (
    <Dialog open={props.open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        className='codex-zcode codex-chatgpt codex-web chatgpt-dialog codex-task-search-dialog bg-popover text-foreground top-[10%] flex max-h-[80dvh] w-[calc(100%-1.5rem)] -translate-y-0 flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:top-[16%] sm:max-w-[680px]'
      >
        <DialogTitle className='sr-only'>{t('Search tasks')}</DialogTitle>
        <DialogDescription className='sr-only'>
          {searchDescription}
        </DialogDescription>
        <Command
          key={String(props.open)}
          shouldFilter={false}
          loop
          value={activeResult}
          onValueChange={setSelectedResult}
          label={t('Search tasks')}
          className='min-h-0 rounded-none! bg-transparent p-0 text-inherit'
        >
          <div className='border-border flex shrink-0 items-center gap-1 border-b p-3 [&_[data-slot=command-input-wrapper]]:min-w-0 [&_[data-slot=command-input-wrapper]]:flex-1 [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group]]:h-11! [&_[data-slot=input-group]]:rounded-none! [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:ring-0!'>
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={(value) => {
                setQuery(value)
                setSelectedResult('')
                props.onQueryChange?.(value)
              }}
              placeholder={t('Search tasks')}
              aria-label={t('Search tasks')}
              className='placeholder:text-muted-foreground text-base'
            />
            {query && (
              <button
                type='button'
                onClick={() => {
                  setQuery('')
                  setSelectedResult('')
                  props.onQueryChange?.('')
                  inputRef.current?.focus()
                }}
                aria-label={t('Clear search')}
                className='text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2'
              >
                <X aria-hidden className='size-4' />
              </button>
            )}
            <DialogClose
              aria-label={t('Close search')}
              className='text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring ml-1 flex min-h-8 shrink-0 items-center justify-center rounded-md px-2 outline-none focus-visible:ring-2'
            >
              <kbd
                aria-hidden
                className='border-border rounded border px-1.5 py-0.5 font-sans text-[11px]'
              >
                Esc
              </kbd>
            </DialogClose>
          </div>
          <CommandList
            label={t('Search results')}
            aria-busy={props.loading || undefined}
            className='max-h-[min(55dvh,480px)] min-h-40 min-w-0 scroll-py-2 overscroll-contain p-2'
          >
            {props.loading && (
              <div
                role='status'
                className='text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm'
              >
                <LoaderCircle aria-hidden className='size-4 animate-spin' />
                {t('Loading tasks...')}
              </div>
            )}
            {remoteError && (
              <div className='px-3 py-5'>
                <p role='alert' className='text-destructive text-sm'>
                  {remoteError}
                </p>
                {props.onRetry && (
                  <button
                    type='button'
                    onClick={props.onRetry}
                    disabled={props.loading}
                    className='bg-muted hover:bg-accent focus-visible:ring-ring mt-3 flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm outline-none focus-visible:ring-2 disabled:opacity-50'
                  >
                    <RotateCcw aria-hidden className='size-3.5' />
                    {t('Retry')}
                  </button>
                )}
              </div>
            )}
            {!props.loading && !remoteError && !hasResults && (
              <div
                role='status'
                className='flex min-h-40 flex-col items-center justify-center gap-2 px-6 py-8 text-center'
              >
                <ListChecks
                  aria-hidden
                  className='text-muted-foreground mb-1 size-6'
                />
                <p className='text-sm font-medium'>
                  {t(search ? 'No tasks found' : 'No tasks yet.')}
                </p>
                {search && (
                  <p className='text-muted-foreground max-w-sm text-sm'>
                    {remoteSearch
                      ? t('Try a different word or phrase.')
                      : t('Try a different task title or project name.')}
                  </p>
                )}
              </div>
            )}
            {remoteSearch && !remoteError && remoteResults.length > 0 && (
              <CommandGroup
                heading={t('Search results')}
                className='text-inherit'
              >
                {remoteResults.map((result) => (
                  <CommandItem
                    key={result.id}
                    value={result.id}
                    disabled={props.loading}
                    onSelect={() =>
                      select(
                        result.workspaceId,
                        result.conversationId,
                        result.turnId
                      )
                    }
                    className='data-selected:bg-accent min-h-16 cursor-pointer gap-3 rounded-lg! px-3 py-3 text-inherit data-selected:text-inherit [&>svg:last-child]:hidden'
                  >
                    {result.matchType === 'project' ? (
                      <Folder
                        aria-hidden
                        className='text-muted-foreground size-4'
                      />
                    ) : (
                      <MessageSquare
                        aria-hidden
                        className='text-muted-foreground size-4'
                      />
                    )}
                    <span className='min-w-0 flex-1'>
                      <span
                        className='block truncate text-sm font-medium'
                        title={result.conversationName || result.workspaceName}
                      >
                        {result.conversationName || result.workspaceName}
                      </span>
                      <span className='text-muted-foreground mt-1 block truncate text-xs'>
                        {result.matchType === 'project'
                          ? t('Project')
                          : result.workspaceName}
                      </span>
                      {result.matchType === 'message' && result.snippet && (
                        <span className='text-muted-foreground mt-1.5 line-clamp-2 text-sm break-words'>
                          <span className='sr-only'>
                            {t('Message excerpt')}:{' '}
                          </span>
                          {result.snippet}
                        </span>
                      )}
                    </span>
                    {(result.workspaceArchived ||
                      result.conversationArchived) && (
                      <span className='text-muted-foreground flex shrink-0 items-center gap-1 text-xs'>
                        <Archive aria-hidden className='size-3.5' />
                        {t('Archived')}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!remoteSearch && results.length > 0 && (
              <CommandGroup
                heading={t(search ? 'Tasks' : 'Recent tasks')}
                className='text-inherit **:[[cmdk-group-heading]]:pb-2'
              >
                {results.map((result) => (
                  <CommandItem
                    key={`${result.workspace.id}:${result.conversation.id}`}
                    value={`task:${result.workspace.id}:${result.conversation.id}`}
                    onSelect={() =>
                      select(result.workspace.id, result.conversation.id)
                    }
                    className='data-selected:bg-accent min-h-16 cursor-pointer gap-3 rounded-lg! px-3 py-3 text-inherit data-selected:text-inherit [&>svg:last-child]:hidden'
                  >
                    <ListChecks
                      aria-hidden
                      className='text-muted-foreground size-4'
                    />
                    <span className='min-w-0 flex-1'>
                      <span
                        className='block truncate text-sm font-medium'
                        title={result.title}
                      >
                        {result.title}
                      </span>
                      <span className='text-muted-foreground mt-1 block truncate text-xs'>
                        {result.workspace.name}
                      </span>
                    </span>
                    {(result.conversation.archived ||
                      result.workspace.archived) && (
                      <span className='text-muted-foreground flex shrink-0 items-center gap-1 text-xs'>
                        <Archive aria-hidden className='size-3.5' />
                        {t('Archived')}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!remoteSearch && projects.length > 0 && (
              <CommandGroup heading={t('Projects')} className='text-inherit'>
                {projects.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    value={`project:${workspace.id}`}
                    onSelect={() => select(workspace.id)}
                    className='data-selected:bg-accent min-h-12 cursor-pointer gap-3 rounded-lg! px-3 py-3 text-inherit data-selected:text-inherit [&>svg:last-child]:hidden'
                  >
                    <Folder
                      aria-hidden
                      className='text-muted-foreground size-4'
                    />
                    <span className='min-w-0 flex-1 truncate'>
                      {workspace.name}
                    </span>
                    {workspace.archived && (
                      <span className='text-muted-foreground text-xs'>
                        {t('Archived')}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {remoteSearch &&
              !remoteError &&
              props.hasMore &&
              !props.loading && (
                <p
                  role='status'
                  className='text-muted-foreground px-4 py-3 text-sm'
                >
                  {t(
                    'More matches are available. Refine your search to see more specific results.'
                  )}
                </p>
              )}
          </CommandList>
          <div className='border-border text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-t px-5 py-3 text-xs'>
            <p className='w-full leading-5'>
              {remoteSearch
                ? t(
                    'Message matches show excerpts. Open a task to read the full conversation.'
                  )
                : searchDescription}
            </p>
            <span className='hidden items-center gap-2 sm:flex'>
              <kbd
                aria-hidden
                className='border-border rounded border px-1.5 font-sans'
              >
                ↑ ↓
              </kbd>
              {t('Navigate results')}
            </span>
            <span className='hidden items-center gap-2 sm:flex'>
              <kbd
                aria-hidden
                className='border-border rounded border px-1.5 font-sans'
              >
                ↵
              </kbd>
              {t('Open selected task')}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
