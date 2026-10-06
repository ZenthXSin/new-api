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
import { useAuthStore } from '@/stores/auth-store'

import { STORAGE_KEYS } from '../../constants'
import type { Message, ParameterEnabled, PlaygroundConfig } from '../../types'
import {
  MAX_STORED_MESSAGES_BYTES,
  MAX_STORED_MESSAGES,
  STORAGE_VERSION,
  messagesSchema,
  parameterEnabledSchema,
  playgroundConfigSchema,
} from './storage-schema'

const DATABASE_NAME = 'new-api-playground'
const STORE_NAME = 'conversations'
const pendingWrites = new Map<string, Promise<void>>()
export type PlaygroundStorageStatus = 'loading' | 'saving' | 'saved' | 'error'
export class PlaygroundStorageError extends Error {
  constructor(
    public readonly code: 'unavailable' | 'limit' | 'invalid' | 'account'
  ) {
    super(code)
    this.name = 'PlaygroundStorageError'
  }
}
export function currentPlaygroundUserID(): number | null {
  return useAuthStore.getState().auth.user?.id ?? null
}
function ownerID(userID: number | null = currentPlaygroundUserID()): number {
  if (!Number.isSafeInteger(userID) || !userID || userID < 1) {
    throw new PlaygroundStorageError('account')
  }
  return userID
}
function scopedKey(kind: string, userID?: number | null): string {
  return `playground_v2:${ownerID(userID)}:${kind}`
}
function readSettings(kind: string, userID?: number | null): unknown {
  const value = localStorage.getItem(scopedKey(kind, userID))
  if (!value) {
    return {}
  }
  return JSON.parse(value) as unknown
}
export function loadConfig(userID?: number | null): Partial<PlaygroundConfig> {
  const value = readSettings('config', userID)
  // Previous versions allowed max_tokens=0; retain all other valid settings.
  if (
    value &&
    typeof value === 'object' &&
    'max_tokens' in value &&
    value.max_tokens === 0
  ) {
    value.max_tokens = 4096
  }
  return playgroundConfigSchema.parse(value)
}
export function saveConfig(
  config: Partial<PlaygroundConfig>,
  userID?: number | null
): void {
  localStorage.setItem(
    scopedKey('config', userID),
    JSON.stringify(playgroundConfigSchema.parse(config))
  )
}
export function loadParameterEnabled(
  userID?: number | null
): Partial<ParameterEnabled> {
  return parameterEnabledSchema.parse(readSettings('parameters', userID))
}
export function saveParameterEnabled(
  parameters: Partial<ParameterEnabled>,
  userID?: number | null
): void {
  localStorage.setItem(
    scopedKey('parameters', userID),
    JSON.stringify(parameterEnabledSchema.parse(parameters))
  )
}

export function validateConversationMessages(messages: unknown): Message[] {
  if (Array.isArray(messages) && messages.length > MAX_STORED_MESSAGES) {
    throw new PlaygroundStorageError('limit')
  }
  const result = messagesSchema.safeParse(messages)
  if (!result.success) {
    throw new PlaygroundStorageError('invalid')
  }
  if (
    new TextEncoder().encode(JSON.stringify(result.data)).byteLength >
    MAX_STORED_MESSAGES_BYTES
  ) {
    throw new PlaygroundStorageError('limit')
  }
  return result.data
}
export function restoreConversationMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (
      message.from !== 'assistant' ||
      !['loading', 'streaming'].includes(message.status ?? '')
    ) {
      return message
    }
    // Preserve exactly the partial answer/reasoning already received. A browser
    // restart cannot turn an interrupted generation into a successful response.
    return {
      ...message,
      status: 'error',
      errorCode: 'interrupted',
      isReasoningStreaming: false,
      isReasoningComplete: true,
      isContentComplete: true,
    }
  })
}
async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new PlaygroundStorageError('unavailable')
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    let rejected = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onerror = () => {
      rejected = true
      reject(new PlaygroundStorageError('unavailable'))
    }
    request.onblocked = () => {
      rejected = true
      reject(new PlaygroundStorageError('unavailable'))
    }
    request.onsuccess = () => {
      if (rejected) {
        request.result.close()
        return
      }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}
export async function loadMessages(
  userID?: number | null
): Promise<Message[] | null> {
  const key = scopedKey('messages', userID)
  await pendingWrites.get(key)?.catch(() => undefined)
  const db = await openDatabase()
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new PlaygroundStorageError('unavailable'))
      transaction.onabort = () =>
        reject(new PlaygroundStorageError('unavailable'))
    })
    if (value === undefined) {
      return null
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== STORAGE_VERSION ||
      !('data' in value)
    ) {
      throw new PlaygroundStorageError('invalid')
    }
    return restoreConversationMessages(validateConversationMessages(value.data))
  } finally {
    db.close()
  }
}
export function saveMessages(
  messages: Message[],
  userID?: number | null
): Promise<void> {
  let key: string
  let data: Message[]
  try {
    key = scopedKey('messages', userID)
    data = validateConversationMessages(messages)
  } catch (error) {
    return Promise.reject(error)
  }
  const work = (pendingWrites.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const db = await openDatabase()
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, 'readwrite')
          transaction
            .objectStore(STORE_NAME)
            .put({ version: STORAGE_VERSION, data }, key)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () =>
            reject(new PlaygroundStorageError('unavailable'))
          transaction.onabort = () =>
            reject(new PlaygroundStorageError('unavailable'))
        })
      } finally {
        db.close()
      }
    })
  pendingWrites.set(key, work)
  void work.then(
    () => {
      if (pendingWrites.get(key) === work) {
        pendingWrites.delete(key)
      }
    },
    () => {
      if (pendingWrites.get(key) === work) {
        pendingWrites.delete(key)
      }
    }
  )
  return work
}
export function hasLegacyConversation(): boolean {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEYS.MESSAGES))
  } catch {
    return false
  }
}
export function readLegacyConversation(): Message[] {
  const raw = localStorage.getItem(STORAGE_KEYS.MESSAGES)
  if (!raw) {
    return []
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_STORED_MESSAGES_BYTES) {
    throw new PlaygroundStorageError('limit')
  }
  const value: unknown = JSON.parse(raw)
  const data =
    value && typeof value === 'object' && 'data' in value ? value.data : value
  return restoreConversationMessages(validateConversationMessages(data))
}
export async function clearPlaygroundData(
  userID?: number | null
): Promise<void> {
  const id = ownerID(userID)
  await saveMessages([], id)
  localStorage.removeItem(scopedKey('config', id))
  localStorage.removeItem(scopedKey('parameters', id))
}
