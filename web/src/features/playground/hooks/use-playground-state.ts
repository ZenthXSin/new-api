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
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAuthStore } from '@/stores/auth-store'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../constants'
import {
  applyMessageStateUpdate,
  type MessageStateUpdater,
} from '../lib/state/playground-state-utils'
import {
  currentPlaygroundUserID,
  loadConfig,
  loadMessages,
  loadParameterEnabled,
  PlaygroundStorageError,
  saveConfig,
  saveMessages,
  saveParameterEnabled,
  validateConversationMessages,
  type PlaygroundStorageStatus,
} from '../lib/storage/storage'
import type {
  Message,
  PlaygroundConfig,
  ParameterEnabled,
  ModelOption,
  GroupOption,
} from '../types'

export function usePlaygroundState() {
  const userID = useAuthStore((state) => state.auth.user?.id ?? null)
  const [owner, setOwner] = useState<number | null>(null)
  const [config, setConfig] = useState<PlaygroundConfig>(DEFAULT_CONFIG)
  const [parameterEnabled, setParameterEnabled] = useState<ParameterEnabled>(
    DEFAULT_PARAMETER_ENABLED
  )
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoadingMessages, setIsLoadingMessages] = useState(true)
  const [storageStatus, setStorageStatus] =
    useState<PlaygroundStorageStatus>('loading')
  const [storageError, setStorageError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [groups, setGroups] = useState<GroupOption[]>([])
  const latestMessages = useRef<Message[]>([])
  const generation = useRef(0)
  const loaded = useRef(false)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeQueue = useRef<Promise<void>>(Promise.resolve())
  const revision = useRef(0)

  const persist = useCallback(
    (snapshot: Message[], id: number, epoch: number): Promise<void> => {
      const change = ++revision.current
      dirty.current = true
      setStorageStatus('saving')
      const work = saveMessages(snapshot, id)
      writeQueue.current = work
      return work.then(
        () => {
          if (generation.current === epoch && revision.current === change) {
            dirty.current = false
            setStorageStatus('saved')
            setStorageError(null)
          }
        },
        (error) => {
          if (generation.current === epoch) {
            setStorageStatus('error')
            setStorageError(
              error instanceof PlaygroundStorageError
                ? error.code
                : 'unavailable'
            )
          }
          throw error
        }
      )
    },
    []
  )

  const restoreMessages = useCallback(async (id: number, epoch: number) => {
    setIsLoadingMessages(true)
    setStorageStatus('loading')
    try {
      await writeQueue.current.catch(() => undefined)
      const stored = await loadMessages(id)
      if (generation.current !== epoch || currentPlaygroundUserID() !== id) {
        return
      }
      const restored = stored ?? []
      latestMessages.current = restored
      loaded.current = true
      setMessages(restored)
      setIsLoadingMessages(false)
      setStorageStatus('saved')
      setStorageError(null)
    } catch (error) {
      if (generation.current !== epoch) {
        return
      }
      // Never replace an inaccessible stored conversation with an empty one.
      loaded.current = false
      setIsLoadingMessages(false)
      setStorageStatus('error')
      setStorageError(
        error instanceof PlaygroundStorageError ? error.code : 'unavailable'
      )
      throw error
    }
  }, [])

  useEffect(() => {
    const epoch = ++generation.current
    loaded.current = false
    dirty.current = false
    latestMessages.current = []
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setOwner(userID)
    setMessages([])
    setConfig(DEFAULT_CONFIG)
    setParameterEnabled(DEFAULT_PARAMETER_ENABLED)
    setModels([])
    setGroups([])
    setIsLoadingMessages(true)
    setStorageStatus('loading')
    setStorageError(null)
    setSettingsError(false)
    if (!userID) {
      setIsLoadingMessages(false)
      return
    }
    try {
      setConfig({ ...DEFAULT_CONFIG, ...loadConfig(userID) })
      setParameterEnabled({
        ...DEFAULT_PARAMETER_ENABLED,
        ...loadParameterEnabled(userID),
      })
    } catch {
      setSettingsError(true)
    }
    void restoreMessages(userID, epoch).catch(() => undefined)
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
        if (loaded.current && dirty.current) {
          void persist(latestMessages.current, userID, epoch).catch(
            () => undefined
          )
        }
      }
      generation.current = epoch + 1
    }
  }, [userID, restoreMessages, persist])

  const commitMessages = useCallback(
    async (next: Message[]) => {
      if (!userID || currentPlaygroundUserID() !== userID || !loaded.current) {
        throw new PlaygroundStorageError('account')
      }
      let snapshot: Message[]
      try {
        snapshot = validateConversationMessages(next)
      } catch (error) {
        setStorageError(
          error instanceof PlaygroundStorageError ? error.code : 'invalid'
        )
        throw error
      }
      const epoch = generation.current
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      await persist(snapshot, userID, epoch)
      if (
        generation.current !== epoch ||
        currentPlaygroundUserID() !== userID
      ) {
        throw new PlaygroundStorageError('account')
      }
      latestMessages.current = snapshot
      setMessages(snapshot)
    },
    [userID, persist]
  )
  const updateMessages = useCallback(
    (updater: MessageStateUpdater) => {
      if (!userID || currentPlaygroundUserID() !== userID || !loaded.current) {
        return
      }
      const next = applyMessageStateUpdate(latestMessages.current, updater)
      latestMessages.current = next
      // A newer streamed token makes any earlier in-flight save stale.
      revision.current++
      setMessages(next)
      dirty.current = true
      setStorageStatus('saving')
      if (timer.current === null) {
        const epoch = generation.current
        timer.current = setTimeout(() => {
          timer.current = null
          void persist(latestMessages.current, userID, epoch).catch(
            () => undefined
          )
        }, 300)
      }
    },
    [userID, persist]
  )
  const retrySave = useCallback(async () => {
    if (!userID || currentPlaygroundUserID() !== userID) {
      throw new PlaygroundStorageError('account')
    }
    if (!loaded.current) {
      await restoreMessages(userID, generation.current)
      return
    }
    try {
      saveConfig(config, userID)
      saveParameterEnabled(parameterEnabled, userID)
      setSettingsError(false)
    } catch (error) {
      setSettingsError(true)
      throw error
    }
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    await persist(latestMessages.current, userID, generation.current)
  }, [userID, persist, restoreMessages, config, parameterEnabled])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    const flush = () => {
      if (userID && loaded.current && dirty.current && timer.current !== null) {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
        void persist(latestMessages.current, userID, generation.current).catch(
          () => undefined
        )
      }
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener('pagehide', flush)
    }
  }, [userID, persist])
  const updateConfig = useCallback(
    <K extends keyof PlaygroundConfig>(key: K, value: PlaygroundConfig[K]) => {
      if (!userID || currentPlaygroundUserID() !== userID) {
        return
      }
      setConfig((previous) => {
        const next = { ...previous, [key]: value }
        try {
          saveConfig(next, userID)
          setSettingsError(false)
        } catch {
          setSettingsError(true)
        }
        return next
      })
    },
    [userID]
  )
  const updateParameterEnabled = useCallback(
    (key: keyof ParameterEnabled, value: boolean) => {
      if (!userID || currentPlaygroundUserID() !== userID) {
        return
      }
      setParameterEnabled((previous) => {
        const next = { ...previous, [key]: value }
        try {
          saveParameterEnabled(next, userID)
          setSettingsError(false)
        } catch {
          setSettingsError(true)
        }
        return next
      })
    },
    [userID]
  )
  const clearMessages = useCallback(() => commitMessages([]), [commitMessages])
  const resetConfig = useCallback(() => {
    if (!userID || currentPlaygroundUserID() !== userID) {
      return
    }
    setConfig(DEFAULT_CONFIG)
    setParameterEnabled(DEFAULT_PARAMETER_ENABLED)
    try {
      saveConfig(DEFAULT_CONFIG, userID)
      saveParameterEnabled(DEFAULT_PARAMETER_ENABLED, userID)
      setSettingsError(false)
    } catch {
      setSettingsError(true)
    }
  }, [userID])
  return {
    config: owner === userID ? config : DEFAULT_CONFIG,
    parameterEnabled:
      owner === userID ? parameterEnabled : DEFAULT_PARAMETER_ENABLED,
    messages: owner === userID ? messages : [],
    isLoadingMessages: isLoadingMessages || owner !== userID,
    models: owner === userID ? models : [],
    groups: owner === userID ? groups : [],
    setModels,
    setGroups,
    updateConfig,
    updateParameterEnabled,
    updateMessages,
    commitMessages,
    clearMessages,
    resetConfig,
    storageStatus,
    storageError: storageError ?? (settingsError ? 'settings' : null),
    retrySave,
  }
}
