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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useReducer, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { codexApi, codexError } from '../api'

type UploadState = {
  pending: number
  reserved: number
  error?: string
}

type AccountAttachments = {
  byConversation: Record<string, string[]>
  uploads: Map<string, UploadState>
}

// Keep a pending batch attached across workbench mounts. Entries are released
// when the last request settles, so a later visit restores the saved draft.
const activeUploads = new Map<string, AccountAttachments>()
const mountedAccounts = new Map<string, AccountAttachments>()
const attachmentsChanged = 'codex-attachments-changed'

function restoreAttachments(actor: string): AccountAttachments {
  let byConversation: Record<string, string[]> = {}
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(`codex-attachments:${actor}`) || '{}'
    )
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      byConversation = Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) &&
            entry[1].length <= 20 &&
            entry[1].every(
              (path) => typeof path === 'string' && path.length <= 1024
            )
        )
      )
    }
  } catch {
    /* A malformed or unavailable draft must not prevent uploads. */
  }
  return { byConversation, uploads: new Map() }
}

function persistAttachments(actor: string, account: AccountAttachments): void {
  try {
    sessionStorage.setItem(
      `codex-attachments:${actor}`,
      JSON.stringify(account.byConversation)
    )
  } catch {
    /* Storage availability must not prevent uploads. */
  }
  window.dispatchEvent(
    new CustomEvent(attachmentsChanged, { detail: { actor, account } })
  )
}

export function useCodexAttachments(
  actor: string,
  workspaceId: string | undefined,
  conversationId: string | undefined,
  maxBytes: number
) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const scope = `${workspaceId || ''}:${conversationId || ''}`
  const accounts = useRef(new Map<string, AccountAttachments>())
  const session = useRef({ actor, version: 0 })
  const mounted = useRef(true)
  const [, refresh] = useReducer((version: number) => version + 1, 0)

  // An old batch must not issue its next request with another account's cookie,
  // even if the user switches back before the in-flight request completes.
  if (session.current.actor !== actor) {
    session.current = { actor, version: session.current.version + 1 }
  }
  let account = accounts.current.get(actor)
  if (!account) {
    account =
      activeUploads.get(actor) ??
      mountedAccounts.get(actor) ??
      restoreAttachments(actor)
    accounts.current.set(actor, account)
  }
  const currentAccount = account
  useEffect(() => {
    mountedAccounts.set(actor, currentAccount)
    return () => {
      if (mountedAccounts.get(actor) === currentAccount) {
        mountedAccounts.delete(actor)
      }
    }
  }, [actor, currentAccount])
  useEffect(() => {
    mounted.current = true
    function synchronize(event: Event): void {
      const changed = (
        event as CustomEvent<{ actor: string; account: AccountAttachments }>
      ).detail
      if (!accounts.current.has(changed.actor)) return
      accounts.current.set(changed.actor, changed.account)
      refresh()
    }
    window.addEventListener(attachmentsChanged, synchronize)
    return () => {
      mounted.current = false
      window.removeEventListener(attachmentsChanged, synchronize)
    }
  }, [])

  const upload = useMutation({
    mutationFn: async (input: {
      actor: string
      version: number
      account: AccountAttachments
      state: UploadState
      files: File[]
      workspaceId: string
      scope: string
    }) => {
      let remaining = input.files.length
      try {
        for (const file of input.files) {
          if (
            !mounted.current ||
            session.current.actor !== input.actor ||
            session.current.version !== input.version
          ) {
            throw new Error(
              t('Your session changed. Reload this page to continue.')
            )
          }
          try {
            const result = await codexApi.upload(
              input.workspaceId,
              file.name,
              file
            )
            input.account.byConversation[input.scope] = [
              ...new Set([
                ...(input.account.byConversation[input.scope] ?? []),
                result.path,
              ]),
            ]
            input.state.reserved -= 1
            remaining -= 1
            // Bind persistence to the request's owner, including responses that
            // complete after navigating away or unmounting the workbench.
            persistAttachments(input.actor, input.account)
            if (mounted.current) refresh()
            void client.invalidateQueries({
              queryKey: ['codex', input.actor, input.workspaceId],
            })
          } catch (error) {
            throw new Error(`${file.name}: ${t(codexError(error))}`)
          }
        }
      } catch (error) {
        input.state.error = codexError(error)
        throw error
      } finally {
        input.state.reserved -= remaining
        input.state.pending -= 1
        if (
          [...input.account.uploads.values()].every(
            (state) => state.pending === 0
          )
        ) {
          activeUploads.delete(input.actor)
        }
        persistAttachments(input.actor, input.account)
        if (mounted.current) refresh()
      }
    },
  })

  function clearSubmitted(paths: string[]): void {
    // A send can finish after leaving and returning. Resolve the latest draft
    // before removing its captured paths so it cannot erase the next message.
    const latest =
      activeUploads.get(actor) ??
      mountedAccounts.get(actor) ??
      (mounted.current ? accounts.current.get(actor) : undefined) ??
      restoreAttachments(actor)
    latest.byConversation[scope] = (latest.byConversation[scope] ?? []).filter(
      (path) => !paths.includes(path)
    )
    accounts.current.set(actor, latest)
    persistAttachments(actor, latest)
    if (mounted.current) refresh()
  }

  return {
    uploadedFiles: currentAccount.byConversation[scope] ?? [],
    uploading: (currentAccount.uploads.get(scope)?.pending ?? 0) > 0,
    error: currentAccount.uploads.get(scope)?.error,
    uploadFiles: (
      files: File[],
      target?: { workspaceId: string; conversationId?: string }
    ): void => {
      const targetWorkspaceId = target ? target.workspaceId : workspaceId
      const targetScope = target
        ? `${target.workspaceId}:${target.conversationId || ''}`
        : scope
      if (
        !targetWorkspaceId ||
        !files.length ||
        session.current.actor !== actor
      ) {
        return
      }
      const state = currentAccount.uploads.get(targetScope) ?? {
        pending: 0,
        reserved: 0,
      }
      currentAccount.uploads.set(targetScope, state)
      const existing = currentAccount.byConversation[targetScope]?.length ?? 0
      if (files.length + existing + state.reserved > 20) {
        state.error = t('Attach up to 20 files per message.')
        refresh()
        return
      }
      if (files.some((file) => file.size > maxBytes)) {
        state.error = t('The file exceeds the upload limit.')
        refresh()
        return
      }
      state.error = undefined
      state.pending += 1
      state.reserved += files.length
      activeUploads.set(actor, currentAccount)
      refresh()
      upload.mutate({
        actor,
        version: session.current.version,
        account: currentAccount,
        state,
        files: [...files],
        workspaceId: targetWorkspaceId,
        scope: targetScope,
      })
    },
    removeFile: (path: string): void => clearSubmitted([path]),
    clearSubmitted,
  }
}
