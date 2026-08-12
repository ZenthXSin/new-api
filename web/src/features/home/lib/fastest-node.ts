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
import type { ApiInfoItem, PingStatus } from '@/features/dashboard/types'

export const FASTEST_NODE_STORAGE_KEY = 'fastest-node-redirect'
export const FASTEST_NODE_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Measure a node's latency from the browser with a HEAD request.
 * Errors are reported as a failed status instead of a rejection, matching
 * the dashboard's latency probe behavior.
 */
export async function probeNodeLatency(url: string): Promise<PingStatus> {
  try {
    const startTime = performance.now()
    await fetch(url, {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-cache',
    })
    const endTime = performance.now()
    const latency = Math.round(endTime - startTime)

    return { latency, testing: false, error: false }
  } catch {
    return { latency: null, testing: false, error: true }
  }
}

/**
 * Pick the fastest node among those hosted on a different origin than the
 * current one, probing all candidates in parallel.
 */
export async function pickFastestNode(
  items: ApiInfoItem[],
  probe: (url: string) => Promise<PingStatus> = probeNodeLatency,
  currentOrigin: string =
    typeof window === 'undefined' ? '' : window.location.origin
): Promise<ApiInfoItem | null> {
  if (items.length === 0) return null

  let currentUrl: URL | null = null
  try {
    currentUrl = new URL(currentOrigin)
  } catch {
    // Unknown origin: keep every node as a candidate; invalid URLs fail the
    // probe anyway.
  }

  const candidates = items.filter((item) => {
    if (currentUrl === null) return true
    try {
      return new URL(item.url, currentUrl).origin !== currentUrl.origin
    } catch {
      return true
    }
  })

  if (candidates.length === 0) return null

  const results = await Promise.all(
    candidates.map(async (item) => {
      let status: PingStatus
      try {
        status = await probe(item.url)
      } catch {
        status = { latency: null, testing: false, error: true }
      }
      return { item, status }
    })
  )

  let fastest: ApiInfoItem | null = null
  let fastestLatency = Number.POSITIVE_INFINITY
  for (const { item, status } of results) {
    if (status.error || status.latency === null) continue
    if (status.latency < fastestLatency) {
      fastestLatency = status.latency
      fastest = item
    }
  }
  return fastest
}

export function readProbeMemory(): { url: string; at: number } | null {
  try {
    const raw = localStorage.getItem(FASTEST_NODE_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { url?: unknown; at?: unknown }
    if (
      typeof candidate.url !== 'string' ||
      typeof candidate.at !== 'number'
    ) {
      return null
    }
    return { url: candidate.url, at: candidate.at }
  } catch {
    return null
  }
}

export function shouldProbe(now: number = Date.now()): boolean {
  const memory = readProbeMemory()
  if (!memory) return true
  return now - memory.at > FASTEST_NODE_COOLDOWN_MS
}

export function writeProbeMemory(url: string, at: number = Date.now()): void {
  localStorage.setItem(FASTEST_NODE_STORAGE_KEY, JSON.stringify({ url, at }))
}
