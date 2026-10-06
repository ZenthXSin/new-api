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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'

import {
  MAX_CONVERSATION_FILE_BYTES,
  downloadConversation,
  exportConversationJSON,
  exportConversationMarkdown,
  parseConversationImport,
} from '../../lib/storage/conversation-transfer'
import {
  currentPlaygroundUserID,
  hasLegacyConversation,
  readLegacyConversation,
  type PlaygroundStorageStatus,
} from '../../lib/storage/storage'
import type { Message, ParameterEnabled, PlaygroundConfig } from '../../types'

type Props = {
  messages: Message[]
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  disabled?: boolean
  storageStatus: PlaygroundStorageStatus
  storageError: string | null
  onImport: (messages: Message[]) => Promise<void>
  onRetrySave: () => Promise<void>
  onClear: () => void | Promise<void>
}
export function ConversationToolbar(props: Props) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id ?? null)
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{
    messages: Message[]
    owner: number
    legacy: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const disabled = props.disabled || busy || !userID
  useEffect(() => {
    setPending(null)
    setConfirmClear(false)
    setBusy(false)
  }, [userID])
  const exportFile = (format: 'json' | 'md') => {
    if (disabled || !userID) {
      return
    }
    try {
      downloadConversation(
        format === 'json'
          ? exportConversationJSON(
              props.messages,
              props.config,
              props.parameterEnabled,
              userID
            )
          : exportConversationMarkdown(props.messages, userID),
        format
      )
    } catch {
      toast.error(t('Could not export this conversation'))
    }
  }
  const readFile = async (file: File) => {
    if (disabled || !userID) {
      return
    }
    const owner = userID
    setBusy(true)
    try {
      if (file.size > MAX_CONVERSATION_FILE_BYTES) {
        toast.error(t('Conversation files must not exceed 20 MiB'))
        return
      }
      const parsed = parseConversationImport(await file.text())
      if (currentPlaygroundUserID() === owner) {
        setPending({ messages: parsed.messages, owner, legacy: false })
      }
    } catch {
      toast.error(t('Invalid conversation file or unavailable attachments'))
    } finally {
      if (currentPlaygroundUserID() === owner) {
        setBusy(false)
      }
    }
  }
  const importLegacy = () => {
    if (disabled || !userID) {
      return
    }
    try {
      setPending({
        messages: readLegacyConversation(),
        owner: userID,
        legacy: true,
      })
    } catch {
      toast.error(t('Invalid conversation file or unavailable attachments'))
    }
  }
  const confirmImport = async () => {
    if (!pending || disabled || pending.owner !== currentPlaygroundUserID()) {
      return
    }
    setBusy(true)
    const owner = pending.owner
    try {
      await props.onImport(pending.messages)
      if (currentPlaygroundUserID() === owner) {
        setPending(null)
        toast.success(t('Conversation imported. No request was sent.'))
      }
    } catch {
      if (currentPlaygroundUserID() === owner) {
        toast.error(
          t(
            'Conversation could not be saved. Your current conversation was kept.'
          )
        )
      }
    } finally {
      if (currentPlaygroundUserID() === owner) {
        setBusy(false)
      }
    }
  }
  let statusLabel = ''
  if (props.storageStatus === 'saving') {
    statusLabel = t('Saving conversation…')
  }
  if (props.storageStatus === 'saved') {
    statusLabel = t('Saved on this browser')
  }
  let errorLabel = t(
    'Conversation is not saved. Keep this page open and export a backup.'
  )
  if (props.storageError === 'limit') {
    errorLabel = t(
      'Conversation exceeds the 2000-message or 20 MiB storage limit. Export a backup before removing messages.'
    )
  }
  if (props.storageError === 'settings') {
    errorLabel = t(
      'Settings could not be restored or saved. Review the current settings and retry saving.'
    )
  }
  return (
    <div
      className='mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-4 py-2'
      aria-label={t('Conversation tools')}
    >
      <Button
        size='sm'
        variant='ghost'
        disabled={disabled || props.messages.length === 0}
        onClick={() => exportFile('json')}
      >
        {t('Export JSON')}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={disabled || props.messages.length === 0}
        onClick={() => exportFile('md')}
      >
        {t('Export Markdown')}
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {t('Import conversation')}
      </Button>
      <input
        ref={input}
        type='file'
        className='hidden'
        accept='.json,application/json'
        aria-label={t('Import conversation file')}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            void readFile(file)
          }
        }}
      />
      {hasLegacyConversation() && (
        <Button
          size='sm'
          variant='ghost'
          disabled={disabled}
          onClick={importLegacy}
        >
          {t('Import legacy history')}
        </Button>
      )}
      <Button
        size='sm'
        variant='ghost'
        disabled={disabled || props.messages.length === 0}
        onClick={() => setConfirmClear(true)}
      >
        {t('Clear conversation')}
      </Button>
      <span className='text-muted-foreground ml-auto text-xs' role='status'>
        {statusLabel}
      </span>
      {(props.storageStatus === 'error' || props.storageError) && (
        <div
          role='alert'
          className='text-destructive flex w-full flex-wrap items-center gap-2 text-xs'
        >
          <span>{errorLabel}</span>
          <Button
            size='sm'
            variant='outline'
            disabled={busy || props.disabled}
            onClick={() => {
              void props
                .onRetrySave()
                .catch(() => toast.error(t('Conversation could not be saved')))
            }}
          >
            {t('Retry saving')}
          </Button>
        </div>
      )}
      <AlertDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPending(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Replace the current conversation?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.legacy
                ? t(
                    'Legacy history has no account owner. Import it only if it belongs to you.'
                  )
                : t(
                    'The selected file will replace this conversation. Settings stay unchanged and no model request will be sent.'
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className='text-muted-foreground text-sm'>
            {t('{{count}} messages', { count: pending?.messages.length ?? 0 })}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('Cancel')}</AlertDialogCancel>
            <Button disabled={disabled} onClick={() => void confirmImport()}>
              {t('Import conversation')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Clear this conversation?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This removes the current conversation from this browser. Export a backup first if you want to keep it.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled}
              onClick={() => {
                void Promise.resolve(props.onClear()).catch(() =>
                  toast.error(t('Conversation could not be saved'))
                )
              }}
            >
              {t('Clear conversation')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
