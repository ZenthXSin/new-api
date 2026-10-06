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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { CameraDialog } from '../camera-dialog'

afterEach(() => vi.unstubAllGlobals())
function cameraFixture() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  const getUserMedia = vi.fn().mockResolvedValue(stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  return { stop, stream, getUserMedia }
}
describe('camera attachment lifecycle', () => {
  test('stops all camera tracks when the dialog closes', async () => {
    const fixture = cameraFixture()
    const close = vi.fn()
    const view = render(
      <CameraDialog onCapture={vi.fn()} onClose={close} onFallback={vi.fn()} />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Capture photo' })
      ).toBeEnabled()
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(fixture.stop).toHaveBeenCalled()
    view.unmount()
  })
  test('stops a camera granted after the dialog is unmounted', async () => {
    const fixture = cameraFixture()
    let grant!: (stream: MediaStream) => void
    fixture.getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve
        })
    )
    const view = render(
      <CameraDialog
        onCapture={vi.fn()}
        onClose={vi.fn()}
        onFallback={vi.fn()}
      />
    )
    view.unmount()
    await act(async () => grant(fixture.stream))
    expect(fixture.stop).toHaveBeenCalled()
  })
  test('offers choosing a photo when camera permission is denied', async () => {
    const fixture = cameraFixture()
    fixture.getUserMedia.mockRejectedValue(
      new DOMException('Denied', 'NotAllowedError')
    )
    const fallback = vi.fn()
    render(
      <CameraDialog
        onCapture={vi.fn()}
        onClose={vi.fn()}
        onFallback={fallback}
      />
    )
    await screen.findByText(
      'Camera access failed. Allow camera access or choose a photo instead.'
    )
    expect(screen.getByRole('button', { name: 'Capture photo' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a photo' }))
    expect(fallback).toHaveBeenCalled()
  })
  test('stops the camera immediately after one photo before adding the attachment', async () => {
    const fixture = cameraFixture()
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(
      640
    )
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(
      480
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob(['photo'], { type: 'image/png' }))
    )
    const capture = vi.fn().mockImplementation(async (file: File) => {
      expect(fixture.stop).toHaveBeenCalled()
      expect(file.type).toBe('image/png')
    })
    const close = vi.fn()
    render(
      <CameraDialog onCapture={capture} onClose={close} onFallback={vi.fn()} />
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Capture photo' })
      ).toBeEnabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Capture photo' }))
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(close).toHaveBeenCalled()
  })
})
