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

import type { ApiInfoItem } from '@/features/dashboard/types'

import {
  fetchServerNodeProbe,
  pickFastestNode,
  shouldProbe,
  writeProbeMemory,
} from '../lib/fastest-node'

interface FastestNodeRedirectProps {
  items: ApiInfoItem[]
}

/**
 * Probe all configured API nodes on first load and redirect to the fastest
 * one when it differs from the current origin. A cooldown memory in
 * localStorage prevents node pairs from redirecting back and forth.
 */
export function FastestNodeRedirect(props: FastestNodeRedirectProps) {
  const startedRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (startedRef.current) return
    if (props.items.length < 2) return
    if (!shouldProbe()) return
    startedRef.current = true

    pickFastestNode(props.items, undefined, undefined, fetchServerNodeProbe)
      .then((node) => {
        // Only bail out on real unmount: a stale placeholder -> fresh status
        // data swap re-runs this effect, and cancelling then would swallow the
        // in-flight probe (warm visitors would never redirect).
        if (!mountedRef.current || !node) return
        writeProbeMemory(node.url)
        window.location.replace(node.url)
      })
      .catch(() => {
        // Probe failures are already folded into a null result by
        // pickFastestNode, so a rejection here only means the cooldown memory
        // could not be written; skip the redirect rather than crash the page.
      })
  }, [props.items])

  return null
}
