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
import { useCallback, useState } from 'react'

import {
  appendUserMessagePair,
  applyMessageEdit,
  createRegeneratedMessages,
  removeMessageByKey,
} from '../lib'
import type { Message, PlaygroundAttachment } from '../types'

type UsePlaygroundConversationOptions = {
  messages: Message[]
  updateMessages: (
    updater: Message[] | ((prev: Message[]) => Message[])
  ) => void
  sendChat: (messages: Message[]) => void
  commitMessages?: (messages: Message[]) => Promise<void>
}

export function usePlaygroundConversation({
  messages,
  updateMessages,
  sendChat,
  commitMessages,
}: UsePlaygroundConversationOptions) {
  const [editingMessageKey, setEditingMessageKey] = useState<string | null>(
    null
  )

  const handleSendMessage = useCallback(
    async (text: string, attachments?: PlaygroundAttachment[]) => {
      const nextMessages = appendUserMessagePair(messages, text, attachments)
      if (commitMessages) {
        await commitMessages(nextMessages)
      } else {
        updateMessages(nextMessages)
      }
      sendChat(nextMessages)
    },
    [messages, updateMessages, sendChat, commitMessages]
  )

  const handleRegenerateMessage = useCallback(
    async (message: Message) => {
      const nextMessages = createRegeneratedMessages(messages, message.key)
      if (!nextMessages) return

      if (commitMessages) {
        await commitMessages(nextMessages)
      } else {
        updateMessages(nextMessages)
      }
      sendChat(nextMessages)
    },
    [messages, updateMessages, sendChat, commitMessages]
  )

  const handleEditMessage = useCallback((message: Message) => {
    setEditingMessageKey(message.key)
  }, [])

  const handleEditOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setEditingMessageKey(null)
    }
  }, [])

  const applyEdit = useCallback(
    async (
      newContent: string,
      shouldSubmit: boolean,
      attachments?: PlaygroundAttachment[]
    ) => {
      if (!editingMessageKey) return

      const editResult = applyMessageEdit(
        messages,
        editingMessageKey,
        newContent,
        shouldSubmit,
        attachments
      )
      if (!editResult) return

      if (commitMessages) {
        await commitMessages(editResult.messages)
      } else {
        updateMessages(editResult.messages)
      }
      setEditingMessageKey(null)

      if (editResult.shouldSend) {
        sendChat(editResult.messages)
      }
    },
    [editingMessageKey, messages, updateMessages, sendChat, commitMessages]
  )

  const handleDeleteMessage = useCallback(
    async (message: Message) => {
      const nextMessages = removeMessageByKey(messages, message.key)
      if (commitMessages) {
        await commitMessages(nextMessages)
      } else {
        updateMessages(nextMessages)
      }
    },
    [messages, updateMessages, commitMessages]
  )

  return {
    editingMessageKey,
    handleSendMessage,
    handleRegenerateMessage,
    handleEditMessage,
    handleEditOpenChange,
    applyEdit,
    handleDeleteMessage,
  }
}
