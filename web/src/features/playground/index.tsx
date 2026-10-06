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

import { useAuthStore } from '@/stores/auth-store'

import { ConversationToolbar } from './components/chat/conversation-toolbar'
import { PlaygroundChat } from './components/chat/playground-chat'
import { PlaygroundInput } from './components/input/playground-input'
import {
  useChatHandler,
  usePlaygroundConversation,
  usePlaygroundOptions,
  usePlaygroundState,
} from './hooks'
import { completeAssistantMessage } from './lib/message/message-streaming-utils'
import type { Message, PlaygroundAttachment } from './types'

export function Playground() {
  const userId = useAuthStore((state) => state.auth.user?.id)
  const sessionId = useAuthStore((state) => state.auth.session?.sid)
  return <PlaygroundSession key={`${userId}:${sessionId}`} />
}

function PlaygroundSession() {
  const { t } = useTranslation()
  const state = usePlaygroundState()
  const [mutating, setMutating] = useState(false)
  const actionLock = useRef(false)
  const mounted = useRef(true)
  const actor = useRef({
    id: useAuthStore.getState().auth.user?.id,
    sid: useAuthStore.getState().auth.session?.sid,
  })
  function isCurrentActor() {
    const auth = useAuthStore.getState().auth
    return (
      auth.user?.id === actor.current.id &&
      auth.session?.sid === actor.current.sid
    )
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const {
    isLoadingModels,
    isSelectionValid,
    availableModels,
    availableGroups,
  } = usePlaygroundOptions({
    currentGroup: state.config.group,
    currentModel: state.config.model,
    setGroups: state.setGroups,
    setModels: state.setModels,
    updateConfig: state.updateConfig,
  })
  const ready = isSelectionValid && !state.isLoadingMessages
  const readyRef = useRef(ready)
  readyRef.current = ready
  const selection = useRef({
    model: state.config.model,
    group: state.config.group,
  })
  selection.current = { model: state.config.model, group: state.config.group }

  const { sendChat, stopGeneration, isGenerating } = useChatHandler({
    config: state.config,
    parameterEnabled: state.parameterEnabled,
    onMessageUpdate: state.updateMessages,
  })
  const conversation = usePlaygroundConversation({
    messages: state.messages,
    updateMessages: state.updateMessages,
    commitMessages: state.commitMessages,
    sendChat: (messages) => {
      if (
        !mounted.current ||
        !isCurrentActor() ||
        !readyRef.current ||
        selection.current.model !== state.config.model ||
        selection.current.group !== state.config.group
      ) {
        const message = t(
          'The request was not sent because the session or model selection changed.'
        )
        const pending = messages.at(-1)
        if (
          mounted.current &&
          isCurrentActor() &&
          pending?.from === 'assistant'
        ) {
          state.updateMessages((current) =>
            current.map((item) =>
              item.key === pending.key
                ? {
                    ...completeAssistantMessage(item),
                    status: 'error',
                    errorMessage: message,
                    errorCode: 'not_sent',
                  }
                : item
            )
          )
        }
        throw new Error(message)
      }
      sendChat(messages)
    },
  })

  async function runAction(work: () => Promise<void>, needsModel = false) {
    if (!mounted.current || !isCurrentActor()) {
      throw new Error(t('The session changed. Please send the message again.'))
    }
    if (actionLock.current || isGenerating || state.isLoadingMessages) {
      throw new Error(t('Please wait for the current operation to finish.'))
    }
    if (needsModel && !readyRef.current) {
      throw new Error(t('Select an available model and group before sending.'))
    }
    actionLock.current = true
    setMutating(true)
    try {
      await work()
    } finally {
      actionLock.current = false
      if (mounted.current) setMutating(false)
    }
  }

  function reportAction(work: () => Promise<void>, needsModel = false) {
    void runAction(work, needsModel).catch((error: unknown) => {
      toast.error(
        error instanceof Error &&
          !['account', 'invalid', 'limit', 'unavailable'].includes(
            error.message
          )
          ? t(error.message)
          : t('The conversation could not be updated. Please try again.')
      )
    })
  }

  function handleSend(text: string, attachments?: PlaygroundAttachment[]) {
    return runAction(
      () => conversation.handleSendMessage(text, attachments),
      true
    )
  }

  async function clearConversation() {
    await runAction(state.clearMessages)
    conversation.handleEditOpenChange(false)
  }

  async function importConversation(messages: Message[]) {
    await runAction(() => state.commitMessages(messages))
    conversation.handleEditOpenChange(false)
  }

  return (
    <div className='relative flex size-full min-h-0 flex-col overflow-hidden'>
      <ConversationToolbar
        messages={state.messages}
        config={state.config}
        parameterEnabled={state.parameterEnabled}
        storageStatus={state.storageStatus}
        storageError={state.storageError}
        onImport={importConversation}
        onRetrySave={state.retrySave}
        onClear={clearConversation}
        disabled={isGenerating || mutating || state.isLoadingMessages}
      />
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        <PlaygroundChat
          messages={state.messages}
          isLoadingMessages={state.isLoadingMessages}
          onRegenerateMessage={(message) =>
            reportAction(
              () => conversation.handleRegenerateMessage(message),
              true
            )
          }
          onEditMessage={conversation.handleEditMessage}
          onDeleteMessage={(message) =>
            reportAction(() =>
              state.commitMessages(
                state.messages.filter((item) => item.key !== message.key)
              )
            )
          }
          onSelectPrompt={(text) =>
            reportAction(() => conversation.handleSendMessage(text), true)
          }
          isGenerating={isGenerating || mutating}
          editingKey={conversation.editingMessageKey}
          onCancelEdit={conversation.handleEditOpenChange}
          onSaveEdit={(content) =>
            reportAction(() => conversation.applyEdit(content, false))
          }
          onSaveEditAndSubmit={(content) =>
            reportAction(() => conversation.applyEdit(content, true), true)
          }
        />
      </div>
      <div className='mx-auto w-full max-w-4xl'>
        <PlaygroundInput
          config={state.config}
          disabled={isGenerating || mutating || state.isLoadingMessages}
          groups={availableGroups}
          groupValue={state.config.group}
          isGenerating={isGenerating}
          isModelLoading={isLoadingModels}
          modelValue={state.config.model}
          models={availableModels}
          onGroupChange={(value) => state.updateConfig('group', value)}
          onConfigChange={state.updateConfig}
          onClearMessages={clearConversation}
          onModelChange={(value) => state.updateConfig('model', value)}
          onParameterEnabledChange={state.updateParameterEnabled}
          onStop={stopGeneration}
          onSubmit={handleSend}
          parameterEnabled={state.parameterEnabled}
          hasMessages={state.messages.length > 0}
        />
      </div>
    </div>
  )
}
