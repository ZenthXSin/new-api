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
import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'

import { Button } from '../button'

function DiagramCanvas(props: { svg: string }) {
  const { t } = useTranslation()
  const viewport = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<'fit' | 'custom'>('fit')
  const [zoom, setZoom] = useState(1)
  const [bounds, setBounds] = useState({ width: 800, height: 600 })
  const image = useMemo(() => {
    const root = new DOMParser().parseFromString(
      props.svg,
      'image/svg+xml'
    ).documentElement
    const box = (root.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    let width =
      box[2] || Number.parseFloat(root.getAttribute('width') ?? '') || 1000
    let height =
      box[3] || Number.parseFloat(root.getAttribute('height') ?? '') || 700
    if (!Number.isFinite(width) || width <= 0) width = 1000
    if (!Number.isFinite(height) || height <= 0) height = 700
    return {
      width,
      height,
      url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(props.svg),
    }
  }, [props.svg])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () =>
      setBounds({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fit = Math.min(
    1,
    Math.max(32, bounds.width - 32) / image.width,
    Math.max(32, bounds.height - 32) / image.height
  )
  const scale = mode === 'fit' ? fit : zoom
  const changeZoom = (factor: number) => {
    setZoom(Math.min(8, Math.max(0.05, scale * factor)))
    setMode('custom')
  }
  return (
    <>
      <div className='flex shrink-0 items-center justify-center gap-2 border-b px-3 py-2'>
        <Button
          variant='ghost'
          size='icon-md'
          aria-label={t('Zoom out')}
          onClick={() => changeZoom(1 / 1.25)}
        >
          <MinusIcon aria-hidden />
        </Button>
        <span
          className='min-w-12 text-center text-xs tabular-nums'
          aria-live='polite'
        >
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant='ghost'
          size='icon-md'
          aria-label={t('Zoom in')}
          onClick={() => changeZoom(1.25)}
        >
          <PlusIcon aria-hidden />
        </Button>
        <Button
          variant='ghost'
          size='sm'
          aria-pressed={mode === 'fit'}
          onClick={() => setMode('fit')}
        >
          <MaximizeIcon aria-hidden />
          {t('Fit diagram')}
        </Button>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => {
            setZoom(1)
            setMode('custom')
          }}
        >
          {t('Actual size')}
        </Button>
      </div>
      <div
        ref={viewport}
        className='min-h-0 flex-1 overflow-auto overscroll-contain'
        role='region'
        aria-label={t('Diagram canvas')}
        tabIndex={0}
      >
        <div className='grid min-h-full w-max min-w-full place-items-center p-4'>
          <img
            src={image.url}
            alt={t('Mermaid diagram')}
            className='max-w-none select-none'
            style={{ width: image.width * scale, height: image.height * scale }}
            draggable={false}
          />
        </div>
      </div>
    </>
  )
}

export function CodePreview(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: RefObject<HTMLButtonElement | null>
  svg: string | null
  language: string
  children: ReactNode
  controls: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        finalFocus={props.returnFocus}
        className='data-open:zoom-in-100 data-closed:zoom-out-100 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 motion-reduce:animate-none sm:max-w-none'
      >
        <div className='flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3'>
          <DialogTitle className='min-w-0 truncate text-sm'>
            {t('Fullscreen preview')} · {props.language || 'text'}
          </DialogTitle>
          <div className='flex shrink-0 items-center gap-1'>
            {!props.svg && props.controls}
            <DialogClose
              render={
                <Button
                  variant='ghost'
                  size='icon-md'
                  aria-label={t('Close preview')}
                />
              }
            >
              <XIcon aria-hidden />
            </DialogClose>
          </div>
        </div>
        {props.svg ? (
          <DiagramCanvas svg={props.svg} />
        ) : (
          <div className='min-h-0 flex-1 overflow-auto overscroll-contain'>
            {props.children}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
