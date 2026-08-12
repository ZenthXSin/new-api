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
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import type { ApiInfoItem, PingStatus } from '@/features/dashboard/types'

import {
  FASTEST_NODE_COOLDOWN_MS,
  FASTEST_NODE_STORAGE_KEY,
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

class MemoryStorage {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

function installStorage() {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  return storage
}

const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage'
)

after(() => {
  if (originalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalStorage)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

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

  assert.equal(fastest, fastItem)
  assert.deepEqual(probedUrls, [
    'https://node-a.example.com',
    'https://node-b.example.com',
  ])
})

test('pickFastestNode returns the only candidate when it is a different origin', async () => {
  const { probe } = probeWithLatencies({ 'https://node-a.example.com': 80 })

  const fastest = await pickFastestNode([fastItem], probe, CURRENT_ORIGIN)

  assert.equal(fastest, fastItem)
})

test('pickFastestNode returns null when every probe fails', async () => {
  const { probe } = probeWithLatencies({
    'https://node-a.example.com': null,
    'https://node-b.example.com': null,
  })

  const fastest = await pickFastestNode([fastItem, slowItem], probe, CURRENT_ORIGIN)

  assert.equal(fastest, null)
})

test('pickFastestNode returns null for an empty item list without probing', async () => {
  const { probe, probedUrls } = probeWithLatencies({})

  const fastest = await pickFastestNode([], probe, CURRENT_ORIGIN)

  assert.equal(fastest, null)
  assert.deepEqual(probedUrls, [])
})

test('pickFastestNode returns null when the only node shares the current origin', async () => {
  const { probe, probedUrls } = probeWithLatencies({
    'https://current.example.com': 5,
  })

  const fastest = await pickFastestNode([sameOriginItem], probe, CURRENT_ORIGIN)

  assert.equal(fastest, null)
  assert.deepEqual(probedUrls, [])
})

test('writeProbeMemory then readProbeMemory round-trips url and timestamp', () => {
  installStorage()
  writeProbeMemory('https://node-a.example.com', 1234)

  assert.deepEqual(readProbeMemory(), {
    url: 'https://node-a.example.com',
    at: 1234,
  })
})

test('readProbeMemory returns null for unparsable or invalid stored JSON', () => {
  const storage = installStorage()
  storage.setItem(FASTEST_NODE_STORAGE_KEY, 'not-json{')
  assert.equal(readProbeMemory(), null)
  storage.setItem(FASTEST_NODE_STORAGE_KEY, JSON.stringify({ url: 42, at: 1 }))
  assert.equal(readProbeMemory(), null)
  storage.setItem(
    FASTEST_NODE_STORAGE_KEY,
    JSON.stringify({ url: 'https://node-a.example.com', at: 'now' })
  )
  assert.equal(readProbeMemory(), null)
  storage.setItem(
    FASTEST_NODE_STORAGE_KEY,
    JSON.stringify({ url: 'https://node-a.example.com' })
  )
  assert.equal(readProbeMemory(), null)
})

test('shouldProbe returns true without stored memory', () => {
  installStorage()

  assert.equal(shouldProbe(), true)
})

test('shouldProbe stays false inside the cooldown window', () => {
  installStorage()
  const at = 1_000_000
  writeProbeMemory('https://node-a.example.com', at)

  assert.equal(shouldProbe(at), false)
  assert.equal(shouldProbe(at + FASTEST_NODE_COOLDOWN_MS), false)
})

test('shouldProbe returns true once the cooldown has elapsed', () => {
  installStorage()
  const at = 1_000_000
  writeProbeMemory('https://node-a.example.com', at)

  assert.equal(shouldProbe(at + FASTEST_NODE_COOLDOWN_MS + 1), true)
})

test('shouldProbe returns true for corrupted stored JSON', () => {
  const storage = installStorage()
  storage.setItem(FASTEST_NODE_STORAGE_KEY, 'not-json{')

  assert.equal(shouldProbe(), true)
})
