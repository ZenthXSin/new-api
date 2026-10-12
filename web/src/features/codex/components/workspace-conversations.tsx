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
  ArchiveRestore,
  Ellipsis,
  LoaderCircle,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/features/codex/vendor/zcode/utils'

import { isCodexBusy } from '../lib/events'
import type { CodexProjectConversation } from '../types'
import { Button } from '../vendor/zcode/button'

type ConversationAction = (
  workspaceId: string,
  conversation: CodexProjectConversation
) => void
interface WorkspaceConversationsProps {
  workspaceId: string
  workspaceArchived: boolean
  conversations: CodexProjectConversation[]
  selectedConversationId?: string
  searchQuery?: string
  loading?: boolean
  error?: string
  onRetry?: (workspaceId: string) => void
  actionsDisabled?: boolean
  onSelect?: (workspaceId: string, conversationId: string) => void
  onRename?: ConversationAction
  onArchive?: ConversationAction
  onDelete?: ConversationAction
}
export function WorkspaceConversations(props: WorkspaceConversationsProps) {
  const { t } = useTranslation()
  const selected = props.conversations.find(
    (conversation) => conversation.id === props.selectedConversationId
  )
  const selectedArchived = selected ? !!selected.archived : undefined
  const [archived, setArchived] = useState(selectedArchived ?? false)
  useEffect(() => {
    if (selectedArchived !== undefined) setArchived(selectedArchived)
  }, [props.selectedConversationId, selectedArchived])
  const query = props.searchQuery?.trim().toLocaleLowerCase() || ''
  const conversations = props.conversations
    .filter((conversation) => {
      if (query) return conversation.name.toLocaleLowerCase().includes(query)
      return !!conversation.archived === archived
    })
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  return (
    <div
      role='group'
      aria-label={t('Project conversations')}
      className='chatgpt-project-conversations mt-0.5 mb-1 ml-6 space-y-0.5'
    >
      {props.loading && (
        <p role='status' className='text-muted-foreground px-2 py-3 text-xs'>
          <LoaderCircle
            aria-hidden
            className='mr-2 inline-block size-3.5 animate-spin'
          />
          {t('Loading conversations...')}
        </p>
      )}
      {props.error && (
        <div className='px-2 py-2 text-xs'>
          <p role='alert' className='text-destructive break-words'>
            {t(props.error)}
          </p>
          {props.onRetry && (
            <Button
              variant='ghost'
              size='sm'
              onClick={() => props.onRetry?.(props.workspaceId)}
            >
              {t('Retry')}
            </Button>
          )}
        </div>
      )}
      {!props.loading && !props.error && conversations.length === 0 && (
        <p className='text-muted-foreground px-2 py-3 text-xs'>
          {query
            ? t('No matching conversations.')
            : t(
                archived
                  ? 'No archived conversations.'
                  : 'No conversations yet.'
              )}
        </p>
      )}
      {conversations.map((conversation) => {
        let displayName = conversation.name
        if (!conversation.customName) {
          if (displayName === 'New conversation') {
            displayName = t('New conversation')
          }
          const generatedNumber = /^Conversation (\d+)$/.exec(displayName)?.[1]
          if (generatedNumber) {
            displayName = t('Conversation {{number}}', {
              number: generatedNumber,
            })
          }
        }
        const busy = isCodexBusy(conversation.status)
        const mutationDisabled =
          props.actionsDisabled || props.workspaceArchived || busy
        return (
          <div
            key={conversation.id}
            role='group'
            aria-label={displayName}
            className={cn(
              'chatgpt-conversation-row group/conversation hover:bg-hover flex min-w-0 items-center rounded-lg transition-colors',
              conversation.id === props.selectedConversationId && 'bg-selected'
            )}
          >
            <button
              type='button'
              aria-label={displayName}
              title={displayName}
              onClick={() =>
                props.onSelect?.(props.workspaceId, conversation.id)
              }
              aria-current={
                conversation.id === props.selectedConversationId
                  ? 'page'
                  : undefined
              }
              className='chatgpt-nav-item text-foreground focus-visible:ring-ring/30 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left text-sm outline-none focus-visible:ring-2 md:min-h-8'
            >
              <span className='min-w-0 flex-1 truncate'>{displayName}</span>
              {conversation.archived && query && (
                <Archive
                  aria-label={t('Archived')}
                  className='text-muted-foreground size-3.5 shrink-0'
                />
              )}
              {busy && (
                <LoaderCircle
                  aria-label={t('Running')}
                  className='size-3.5 shrink-0 animate-spin'
                />
              )}
            </button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant='ghost'
                    size='icon-md'
                    className={cn(
                      'chatgpt-row-actions mr-1 size-9 shrink-0 rounded-lg md:size-7 md:opacity-0 md:group-hover/conversation:opacity-100 md:group-focus-within/conversation:opacity-100 md:aria-expanded:opacity-100 [@media(hover:none)]:opacity-100',
                      conversation.id === props.selectedConversationId &&
                        'md:group-hover/conversation:opacity-100'
                    )}
                  />
                }
                aria-label={t('Conversation actions for {{name}}', {
                  name: displayName,
                })}
              >
                <Ellipsis className='size-3.5' aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className='codex-zcode codex-chatgpt chatgpt-popover w-56 rounded-2xl p-1.5 shadow-lg [&_[role=menuitem]]:min-h-10 [&_[role=menuitem]]:rounded-lg [&_[role=menuitem]]:px-3'
                side='right'
                align='start'
              >
                <DropdownMenuItem
                  disabled={props.actionsDisabled || !props.onRename}
                  onSelect={() =>
                    props.onRename?.(props.workspaceId, conversation)
                  }
                >
                  <Pencil aria-hidden />
                  {t('Rename conversation')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={mutationDisabled || !props.onArchive}
                  onSelect={() =>
                    props.onArchive?.(props.workspaceId, conversation)
                  }
                >
                  {conversation.archived ? (
                    <ArchiveRestore aria-hidden />
                  ) : (
                    <Archive aria-hidden />
                  )}
                  {t(
                    conversation.archived
                      ? 'Restore conversation'
                      : 'Archive conversation'
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant='destructive'
                  disabled={mutationDisabled || !props.onDelete}
                  onSelect={() =>
                    props.onDelete?.(props.workspaceId, conversation)
                  }
                >
                  <Trash2 aria-hidden />
                  {t('Delete conversation')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })}
      {!props.loading && !props.error && !query && (
        <Button
          type='button'
          variant='ghost'
          className='text-muted-foreground h-auto min-h-11 w-full justify-start gap-2 rounded-lg px-3 text-left text-xs whitespace-normal md:min-h-8'
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          <Archive className='size-3.5' aria-hidden />
          {t(
            archived
              ? 'Show active conversations'
              : 'Show archived conversations'
          )}
        </Button>
      )}
    </div>
  )
}
