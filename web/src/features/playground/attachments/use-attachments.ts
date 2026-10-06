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
import { useTranslation } from 'react-i18next'

import type { PlaygroundAttachment } from '../types'
import { AttachmentError, prepareAttachments } from './attachment-files'

export function usePlaygroundAttachments() {
  const { t } = useTranslation()
  const [attachments, setAttachments] = useState<PlaygroundAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = useRef<PlaygroundAttachment[]>([])
  const active = useRef(true)
  const generation = useRef(0)
  const lock = useRef(false)
  useEffect(() => {
    active.current = true
    generation.current++
    return () => {
      active.current = false
    }
  }, [])
  const add = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      if (lock.current) {
        setError(
          t('Attachments are still loading. Please try again in a moment.')
        )
        return
      }
      lock.current = true
      const revision = generation.current
      setBusy(true)
      setError('')
      try {
        const prepared = await prepareAttachments(files, current.current)
        if (!active.current || generation.current !== revision) return
        current.current = [...current.current, ...prepared]
        setAttachments(current.current)
      } catch (cause) {
        if (active.current && generation.current === revision) {
          setError(
            cause instanceof AttachmentError
              ? t(cause.key, { name: cause.fileName })
              : t('The attachment could not be read. Please try again.')
          )
        }
      } finally {
        lock.current = false
        if (active.current) setBusy(false)
      }
    },
    [t]
  )
  const remove = useCallback((id: string) => {
    current.current = current.current.filter((item) => item.id !== id)
    setAttachments(current.current)
  }, [])
  const clear = useCallback(() => {
    generation.current++
    current.current = []
    setAttachments([])
    setError('')
  }, [])
  return { attachments, add, remove, clear, busy, error, setError }
}
