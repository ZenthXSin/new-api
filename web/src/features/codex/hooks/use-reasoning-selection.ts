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

// Keep drag previews inside the settings; the conversation only receives a selection.
export function useReasoningSelection(props: {
  value: string
  modelName: string
  efforts: string[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const pending = useRef<string | null>(null)
  const dragging = useRef(false)
  const effortKey = props.efforts.join(',')
  const onChange = props.onChange

  useEffect(() => {
    dragging.current = false
    pending.current = null
    setPreview(null)
  }, [props.value, props.modelName, effortKey, props.disabled])

  const commit = useCallback(() => {
    const next = pending.current
    dragging.current = false
    pending.current = null
    setPreview(null)
    if (
      next &&
      !props.disabled &&
      props.efforts.includes(next) &&
      next !== props.value
    ) {
      onChange(next)
    }
  }, [props.disabled, props.efforts, onChange, props.value])

  useEffect(() => {
    const finish = () => {
      if (dragging.current) commit()
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
  }, [commit])

  return {
    value: preview ?? props.value,
    commit,
    beginDrag: () => {
      if (!props.disabled) dragging.current = true
    },
    select: (next: string) => {
      if (props.disabled || !props.efforts.includes(next)) return
      if (dragging.current) {
        pending.current = next
        setPreview(next)
      } else if (next !== props.value) {
        props.onChange(next)
      }
    },
  }
}
