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

import type { ApiInfoItem } from '@/features/dashboard/types'
import { Window } from 'happy-dom'

const nodeTestApi = await import('node:test')
const testGlobals = globalThis as typeof globalThis & {
  after?: typeof nodeTestApi.after
  describe?: typeof nodeTestApi.describe
  test?: typeof nodeTestApi.test
}
const after = testGlobals.after ?? nodeTestApi.after
const describe = testGlobals.describe ?? nodeTestApi.describe
const test = testGlobals.test ?? nodeTestApi.test

const domWindow = new Window()
const domGlobals = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'SVGElement',
  'Node',
  'Element',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const

for (const key of domGlobals) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: domWindow[key],
  })
}

const originalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage'
)
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: domWindow.localStorage,
})

const { act } = await import('react')
const { StrictMode } = await import('react')
const { createRoot } = await import('react-dom/client')
const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

const { FastestNodeRedirect } = await import('../fastest-node-redirect')
const { FASTEST_NODE_STORAGE_KEY, readProbeMemory } = await import(
  '../../lib/fastest-node'
)

type RenderedRedirect = {
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
}

async function renderRedirect(items: ApiInfoItem[]): Promise<RenderedRedirect> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<FastestNodeRedirect items={items} />)
  })

  return { container, root }
}

async function unmountRedirect(rendered: RenderedRedirect) {
  await act(async () => rendered.root.unmount())
  rendered.container.remove()
}

function node(url: string): ApiInfoItem {
  return { url, route: 'route', description: 'desc', color: 'blue' }
}

const NODE_A = 'https://node-a.example.com'
const NODE_B = 'https://node-b.example.com'

function installControllableFetch() {
  let fetchCalls = 0
  const resolvers: Array<() => void> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    new Promise<void>((resolve) => {
      fetchCalls += 1
      resolvers.push(resolve)
    })) as unknown as typeof fetch
  return {
    fetchCalls: () => fetchCalls,
    resolveAll: () => {
      for (const resolve of resolvers) resolve()
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

describe('fastest node redirect', () => {
  after(() => {
    domWindow.close()
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage)
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  test('redirects after items swap mid-probe instead of cancelling', async () => {
    domWindow.localStorage.clear()
    let replacedUrl: string | null = null
    domWindow.location.replace = ((url: string) => {
      replacedUrl = url
    }) as typeof domWindow.location.replace
    const fetchControl = installControllableFetch()

    try {
      const rendered = await renderRedirect([node(NODE_A), node(NODE_B)])
      assert.equal(fetchControl.fetchCalls(), 2)

      // Simulate react-query swapping placeholder status for fresh data:
      // the items array identity changes, which re-runs the effect.
      await act(async () => {
        rendered.root.render(<FastestNodeRedirect items={[node(NODE_A), node(NODE_B)]} />)
      })
      assert.equal(fetchControl.fetchCalls(), 2, 'probe must not restart on data swap')

      fetchControl.resolveAll()
      await act(async () => {})

      assert.ok(
        replacedUrl === NODE_A || replacedUrl === NODE_B,
        `expected redirect to a probed node, got ${replacedUrl}`
      )
      assert.equal(readProbeMemory()?.url, replacedUrl)

      await unmountRedirect(rendered)
    } finally {
      fetchControl.restore()
    }
  })

  test('redirects under StrictMode double-mounting', async () => {
    domWindow.localStorage.clear()
    let replacedUrl: string | null = null
    domWindow.location.replace = ((url: string) => {
      replacedUrl = url
    }) as typeof domWindow.location.replace
    const fetchControl = installControllableFetch()

    try {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)

      await act(async () => {
        root.render(
          <StrictMode>
            <FastestNodeRedirect items={[node(NODE_A), node(NODE_B)]} />
          </StrictMode>
        )
      })

      // StrictMode runs the mount effect twice but the probe must start once.
      assert.equal(fetchControl.fetchCalls(), 2)

      fetchControl.resolveAll()
      await act(async () => {})

      assert.ok(
        replacedUrl === NODE_A || replacedUrl === NODE_B,
        `expected redirect to a probed node, got ${replacedUrl}`
      )
      assert.equal(readProbeMemory()?.url, replacedUrl)

      await act(async () => root.unmount())
      container.remove()
    } finally {
      fetchControl.restore()
    }
  })

  test('does not probe when fewer than two nodes are configured', async () => {
    domWindow.localStorage.clear()
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      fetchCalls += 1
      return Promise.resolve(undefined)
    }) as unknown as typeof fetch

    try {
      const rendered = await renderRedirect([node(NODE_A)])
      assert.equal(fetchCalls, 0)
      await unmountRedirect(rendered)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('does not probe again while the cooldown memory is fresh', async () => {
    domWindow.localStorage.clear()
    domWindow.localStorage.setItem(
      FASTEST_NODE_STORAGE_KEY,
      JSON.stringify({ url: NODE_A, at: Date.now() })
    )
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      fetchCalls += 1
      return Promise.resolve(undefined)
    }) as unknown as typeof fetch

    try {
      const rendered = await renderRedirect([node(NODE_A), node(NODE_B)])
      assert.equal(fetchCalls, 0)
      await unmountRedirect(rendered)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
