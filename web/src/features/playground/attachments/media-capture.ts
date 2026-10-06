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
import { AttachmentError } from './attachment-files'

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  name: string
): Promise<File> {
  if (!video.videoWidth || !video.videoHeight) {
    return Promise.reject(
      new AttachmentError(
        'The camera or screen is not ready. Please try again.'
      )
    )
  }
  const canvas = document.createElement('canvas')
  const scale = Math.min(
    1,
    2048 / Math.max(video.videoWidth, video.videoHeight)
  )
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) {
    return Promise.reject(
      new AttachmentError(
        'This browser could not capture the image. Please upload an image instead.'
      )
    )
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (blob) resolve(new File([blob], name, { type: 'image/png' }))
      else {
        reject(
          new AttachmentError(
            'This browser could not capture the image. Please upload an image instead.'
          )
        )
      }
    }, 'image/png')
  )
}

export async function captureScreen(signal: AbortSignal): Promise<File> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
    throw new AttachmentError(
      'Screen capture is unavailable here. Upload a screenshot instead.'
    )
  }
  let stream: MediaStream | undefined
  const video = document.createElement('video')
  const release = () => {
    stopMediaStream(stream)
    video.srcObject = null
  }
  signal.addEventListener('abort', release, { once: true })
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    await video.play()
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return await captureVideoFrame(video, `screenshot-${Date.now()}.png`)
  } finally {
    signal.removeEventListener('abort', release)
    release()
  }
}
