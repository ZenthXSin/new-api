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
import { afterAll, beforeEach, expect, test } from 'vitest'

import type { ApiInfoItem, PingStatus } from '@/features/dashboard/types'

import {
  FASTEST_NODE_COOLDOWN_MS,
  FASTEST_NODE_STORAGE_KEY,
  fetchServerNodeProbe,
  pickFastestNode,
  readProbeMemory,
  shouldProbe,
  writeProbeMemory,
} from '../fastest-node'

const CURRENT_ORIGIN = 'https://current.example.com'

const sameOriginItem: ApiInfoItem = {
  url: 'https://current.example.com',
  route: '/',
  description: 'current node',
  color: 'green',
}

const fastItem: ApiInfoItem = {
  url: 'https://node-a.example.com',
  route: '/',
  description: 'fast node',
  color: 'green',
}

const slowItem: ApiInfoItem = {
  url: 'https://node-b.example.com',
  route: '/',
  description: 'slow node',
  color: 'yellow',
}

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')

afterAll(() => {
  if (originalFetch) {
    Object.defineProperty(globalThis, 'fetch', originalFetch)
  } else {
    Reflect.deleteProperty(globalThis, 'fetch')
  }
})

beforeEach(() => {
  localStorage.clear()
})

function installFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
  const fetchMock = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => handler(input, init)
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: fetchMock,
  })
}

function probeWithLatencies(latencies: Record<string, number | null>) {
  const probedUrls: string[] = []
  const probe = async (url: string): Promise<PingStatus> => {
    probedUrls.push(url)
    const latency = latencies[url]
    if (latency === null) {
      return { latency: null, testing: false, error: true }
    }
    return { latency, testing: false, error: false }
  }
  return { probe, probedUrls }
}

test('pickFastestNode returns the fastest node and never probes the current origin', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://current.example.com': 5,
    'https://node-a.example.com': 30,
    'https://node-b.example.com': 120,
  })

  const fastest = await pickFastestNode(
    [fastItem, sameOriginItem, slowItem],
    probe,
    CURRENT_ORIGIN
  )

  expect(fastest).toBe(fastItem)
  expect(probedUrls).toEqual([
    'https://node-a.example.com',
    'https://node-b.example.com',
  ])
})

test('pickFastestNode returns the only candidate when it is a different origin', async () => {
  const { probe } = probeWithLatencies({ 'https://node-a.example.com': 80 })

  const fastest = await pickFastestNode([fastItem], probe, CURRENT_ORIGIN)

  expect(fastest).toBe(fastItem)
})

test('pickFastestNode returns null when every probe fails', async () => {
  const { probe } = probeWithLatencies({
    'https://node-a.example.com': null,
    'https://node-b.example.com': null,
  })

  const fastest = await pickFastestNode([fastItem, slowItem], probe, CURRENT_ORIGIN)

  expect(fastest).toBe(null)
})

test('pickFastestNode returns null for an empty item list without probing', async () => {
  const { probe, probedUrls } = probeWithLatencies({})

  const fastest = await pickFastestNode([], probe, CURRENT_ORIGIN)

  expect(fastest).toBe(null)
  expect(probedUrls).toEqual([])
})

test('pickFastestNode returns null when the only node shares the current origin', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://current.example.com': 5,
  })

  const fastest = await pickFastestNode([sameOriginItem], probe, CURRENT_ORIGIN)

  expect(fastest).toBe(null)
  expect(probedUrls).toEqual([])
})

test('writeProbeMemory then readProbeMemory round-trips url and timestamp', () => {
  writeProbeMemory('https://node-a.example.com', 1234)

  expect(readProbeMemory()).toEqual({
    url: 'https://node-a.example.com',
    at: 1234,
  })
})

test('readProbeMemory returns null for unparsable or invalid stored JSON', () => {
  localStorage.setItem(FASTEST_NODE_STORAGE_KEY, 'not-json{')
  expect(readProbeMemory()).toBe(null)
  localStorage.setItem(FASTEST_NODE_STORAGE_KEY, JSON.stringify({ url: 42, at: 1 }))
  expect(readProbeMemory()).toBe(null)
  localStorage.setItem(
    FASTEST_NODE_STORAGE_KEY,
    JSON.stringify({ url: 'https://node-a.example.com', at: 'now' })
  )
  expect(readProbeMemory()).toBe(null)
  localStorage.setItem(
    FASTEST_NODE_STORAGE_KEY,
    JSON.stringify({ url: 'https://node-a.example.com' })
  )
  expect(readProbeMemory()).toBe(null)
})

test('shouldProbe returns true without stored memory', () => {
  expect(shouldProbe()).toBe(true)
})

test('shouldProbe stays false inside the cooldown window', () => {
  const at = 1_000_000
  writeProbeMemory('https://node-a.example.com', at)

  expect(shouldProbe(at)).toBe(false)
  expect(shouldProbe(at + FASTEST_NODE_COOLDOWN_MS)).toBe(false)
})

test('shouldProbe returns true once the cooldown has elapsed', () => {
  const at = 1_000_000
  writeProbeMemory('https://node-a.example.com', at)

  expect(shouldProbe(at + FASTEST_NODE_COOLDOWN_MS + 1)).toBe(true)
})

test('shouldProbe returns true for corrupted stored JSON', () => {
  localStorage.setItem(FASTEST_NODE_STORAGE_KEY, 'not-json{')

  expect(shouldProbe()).toBe(true)
})

test('pickFastestNode prefers the server probe and never calls the browser probe when every candidate has a latency', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://node-a.example.com': 30,
    'https://node-b.example.com': 120,
  })
  const serverProbe = async () => ({
    'https://node-a.example.com': 15,
    'https://node-b.example.com': 90,
  })

  const fastest = await pickFastestNode(
    [fastItem, slowItem],
    probe,
    CURRENT_ORIGIN,
    serverProbe
  )

  expect(fastest).toBe(fastItem)
  expect(probedUrls).toEqual([])
})

test('pickFastestNode skips candidates absent from the server probe and returns the fastest measured one', async () => {
  const { probe, probedUrls } = probeWithLatencies({})
  const serverProbe = async () => ({
    // node-b absent: its server-side probe failed
    'https://node-a.example.com': 40,
  })

  const fastest = await pickFastestNode(
    [fastItem, slowItem],
    probe,
    CURRENT_ORIGIN,
    serverProbe
  )

  expect(fastest).toBe(fastItem)
  expect(probedUrls).toEqual([])
})

test('pickFastestNode falls back to browser probing when the server probe returns null', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://node-a.example.com': 30,
    'https://node-b.example.com': 120,
  })
  const serverProbe = async () => null

  const fastest = await pickFastestNode(
    [fastItem, slowItem],
    probe,
    CURRENT_ORIGIN,
    serverProbe
  )

  expect(fastest).toBe(fastItem)
  expect(probedUrls).toEqual([
    'https://node-a.example.com',
    'https://node-b.example.com',
  ])
})

test('pickFastestNode falls back to browser probing when the server probe throws', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://node-a.example.com': 30,
    'https://node-b.example.com': 120,
  })
  const serverProbe = async (): Promise<Record<string, number> | null> => {
    throw new Error('probe endpoint unreachable')
  }

  const fastest = await pickFastestNode(
    [fastItem, slowItem],
    probe,
    CURRENT_ORIGIN,
    serverProbe
  )

  expect(fastest).toBe(fastItem)
  expect(probedUrls).toEqual([
    'https://node-a.example.com',
    'https://node-b.example.com',
  ])
})

test('pickFastestNode falls back to browser probing when the server probe misses every candidate', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://node-a.example.com': 30,
    'https://node-b.example.com': 120,
  })
  const serverProbe = async () => ({
    'https://unrelated.example.com': 5,
  })

  const fastest = await pickFastestNode(
    [fastItem, slowItem],
    probe,
    CURRENT_ORIGIN,
    serverProbe
  )

  expect(fastest).toBe(fastItem)
  expect(probedUrls).toEqual([
    'https://node-a.example.com',
    'https://node-b.example.com',
  ])
})

test('fetchServerNodeProbe maps successful entries and skips errored or malformed ones', async () => {
  installFetch(async () => {
    const body = {
      success: true,
      data: [
        { url: 'https://node-a.example.com', latency_ms: 15, error: '' },
        { url: 'https://node-b.example.com', latency_ms: 90, error: 'timeout' },
        { url: 'https://node-c.example.com', latency_ms: 0, error: '' },
        { url: 'https://node-d.example.com', latency_ms: 60 },
        { url: 'https://node-e.example.com', latency_ms: 'fast', error: '' },
      ],
    }
    return new Response(JSON.stringify(body), { status: 200 })
  })

  const latencies = await fetchServerNodeProbe()

  expect(latencies).toEqual({
    'https://node-a.example.com': 15,
    'https://node-d.example.com': 60,
  })
})

test('fetchServerNodeProbe returns null when the response is not ok', async () => {
  installFetch(async () => new Response('', { status: 500 }))

  expect(await fetchServerNodeProbe()).toBe(null)
})

test('fetchServerNodeProbe returns null when no entry is usable', async () => {
  installFetch(async () => {
    const body = {
      success: true,
      data: [{ url: 'https://node-a.example.com', latency_ms: 50, error: 'down' }],
    }
    return new Response(JSON.stringify(body), { status: 200 })
  })

  expect(await fetchServerNodeProbe()).toBe(null)
})

test('fetchServerNodeProbe returns null when the fetch fails', async () => {
  installFetch(async () => {
    throw new Error('network failure')
  })

  expect(await fetchServerNodeProbe()).toBe(null)
})