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

import type { AttachmentActionId } from '../lib/input/input-tool-utils'
import { AttachmentError } from './attachment-files'
import { captureScreen } from './media-capture'

export function useAttachmentSources(options: {
  disabled: boolean
  add: (files: File[]) => Promise<void>
  setError: (error: string) => void
}) {
  const { t } = useTranslation()
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const mobileCameraInput = useRef<HTMLInputElement>(null)
  const screenCapture = useRef<AbortController | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [capturingScreen, setCapturingScreen] = useState(false)
  useEffect(() => () => screenCapture.current?.abort(), [])
  const screenshot = async () => {
    const controller = new AbortController()
    screenCapture.current = controller
    setCapturingScreen(true)
    options.setError('')
    try {
      const file = await captureScreen(controller.signal)
      if (!controller.signal.aborted) await options.add([file])
    } catch (cause) {
      if (!controller.signal.aborted) {
        options.setError(
          cause instanceof AttachmentError
            ? t(cause.key)
            : t(
                'Screen capture was cancelled or denied. You can try again or upload a screenshot.'
              )
        )
      }
    } finally {
      if (!controller.signal.aborted) setCapturingScreen(false)
      if (screenCapture.current === controller) screenCapture.current = null
    }
  }
  const handleAction = (action: AttachmentActionId) => {
    if (options.disabled || screenCapture.current) return
    options.setError('')
    if (action === 'upload-file') fileInput.current?.click()
    if (action === 'upload-photo') photoInput.current?.click()
    if (action === 'take-screenshot') void screenshot()
    if (action === 'take-photo') {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        mobileCameraInput.current?.click()
      } else setCameraOpen(true)
    }
  }
  return {
    fileInput,
    photoInput,
    mobileCameraInput,
    cameraOpen,
    setCameraOpen,
    capturingScreen,
    handleAction,
  }
}
