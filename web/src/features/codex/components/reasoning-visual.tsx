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
import { useEffect, useRef } from 'react'

import {
  createReasoningRenderer,
  type ReasoningRenderer,
} from '../lib/reasoning-renderer'

const levels: Record<string, number> = {
  low: 0,
  medium: 0.2,
  high: 0.4,
  xhigh: 0.6,
  max: 0.8,
  ultra: 1,
}

export function CodexReasoningVisual(props: {
  progress: number
  effort: string
  flowing: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ReasoningRenderer | null>(null)
  const paint = useRef({
    progress: props.progress,
    level: levels[props.effort] ?? 0.2,
    flowing: props.flowing,
    ultra: props.effort === 'ultra',
  })

  useEffect(() => {
    const element = canvas.current
    const track = element?.parentElement
    if (!element || !track) return
    renderer.current = createReasoningRenderer(element, track, paint.current)
    return () => {
      renderer.current?.dispose()
      renderer.current = null
    }
  }, [])

  useEffect(() => {
    paint.current = {
      progress: props.progress,
      level: levels[props.effort] ?? 0.2,
      flowing: props.flowing,
      ultra: props.effort === 'ultra',
    }
    renderer.current?.setTarget(paint.current)
  }, [props.progress, props.effort, props.flowing])

  return (
    <>
      <div aria-hidden className='codex-reasoning-visual'>
        <div className='codex-reasoning-fill' />
        <span className='codex-reasoning-thumb'>
          <span className='codex-reasoning-thumb-core' />
        </span>
      </div>
      <canvas ref={canvas} aria-hidden className='codex-reasoning-shader' />
      <div aria-hidden className='codex-reasoning-particles'>
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
    </>
  )
}
