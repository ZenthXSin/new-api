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

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { captureVideoFrame, stopMediaStream } from './media-capture'

export function CameraDialog(props: {
  onClose: () => void
  onCapture: (file: File) => Promise<void>
  onFallback: () => void
}) {
  const { t } = useTranslation()
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const active = useRef(true)
  const [ready, setReady] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    active.current = true
    let acquired: MediaStream | undefined
    let disposed = false
    void (async () => {
      try {
        acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (disposed || !active.current) {
          stopMediaStream(acquired)
          return
        }
        stream.current = acquired
        if (!video.current) {
          stopMediaStream(acquired)
          return
        }
        video.current.srcObject = acquired
        await video.current.play()
        if (!disposed) setReady(true)
      } catch {
        stopMediaStream(acquired)
        if (!disposed) {
          setError(
            t(
              'Camera access failed. Allow camera access or choose a photo instead.'
            )
          )
        }
      }
    })()
    return () => {
      disposed = true
      active.current = false
      stopMediaStream(acquired)
      stream.current = null
    }
  }, [t])
  const close = () => {
    active.current = false
    stopMediaStream(stream.current)
    props.onClose()
  }
  const capture = async () => {
    if (!video.current || capturing) return
    setCapturing(true)
    try {
      const file = await captureVideoFrame(
        video.current,
        `photo-${Date.now()}.png`
      )
      stopMediaStream(stream.current)
      if (!active.current) return
      await props.onCapture(file)
      if (active.current) close()
    } catch {
      if (active.current) {
        setCapturing(false)
        setError(t('The camera or screen is not ready. Please try again.'))
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Take photo')}</DialogTitle>
          <DialogDescription>
            {t(
              'Preview the photo before adding it. The camera turns off when you capture or close this window.'
            )}
          </DialogDescription>
        </DialogHeader>
        <video
          ref={video}
          muted
          playsInline
          aria-label={t('Camera preview')}
          className='aspect-video w-full rounded-lg bg-black object-contain'
        />
        {!ready && !error && <p role='status'>{t('Opening camera…')}</p>}
        {error && (
          <Alert variant='destructive'>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type='button'
            variant='outline'
            onClick={() => {
              close()
              props.onFallback()
            }}
          >
            {t('Choose a photo')}
          </Button>
          <Button
            type='button'
            onClick={() => void capture()}
            disabled={!ready || capturing || Boolean(error)}
          >
            {t('Capture photo')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
