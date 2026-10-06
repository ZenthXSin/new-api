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
import { afterEach, describe, expect, test, vi } from 'vitest'

import { captureScreen } from '../media-capture'

afterEach(() => vi.unstubAllGlobals())
function screenFixture() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  const getDisplayMedia = vi.fn().mockResolvedValue(stream)
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(
    1920
  )
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(
    1080
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
    (callback) => callback(new Blob(['image'], { type: 'image/png' }))
  )
  return { stop, getDisplayMedia, stream }
}
describe('screen capture lifetime', () => {
  test('captures one image without audio and immediately releases all screen tracks', async () => {
    const fixture = screenFixture()
    const file = await captureScreen(new AbortController().signal)
    expect(file.type).toBe('image/png')
    expect(fixture.getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: false,
    })
    expect(fixture.stop).toHaveBeenCalled()
  })
  test('releases screen tracks if rendering the image fails', async () => {
    const fixture = screenFixture()
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(null)
    )
    await expect(captureScreen(new AbortController().signal)).rejects.toThrow()
    expect(fixture.stop).toHaveBeenCalled()
  })
  test('releases a stream granted after the input has been removed', async () => {
    const fixture = screenFixture()
    let grant!: (stream: MediaStream) => void
    fixture.getDisplayMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve
        })
    )
    const controller = new AbortController()
    const pending = captureScreen(controller.signal)
    controller.abort()
    grant(fixture.stream)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.stop).toHaveBeenCalled()
  })
  test('offers upload when screen capture is unsupported', async () => {
    vi.stubGlobal('isSecureContext', false)
    await expect(
      captureScreen(new AbortController().signal)
    ).rejects.toMatchObject({
      key: 'Screen capture is unavailable here. Upload a screenshot instead.',
    })
  })
})
