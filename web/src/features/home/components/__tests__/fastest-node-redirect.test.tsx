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
import { describe, expect, test } from 'vitest'

import type { ApiInfoItem } from '@/features/dashboard/types'

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

function installServerProbeFetch() {
  let fetchCalls = 0
  const probeResolvers: Array<() => void> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls += 1
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.href
    } else {
      url = input.url
    }
    if (url.includes('/api/api-nodes/probe')) {
      return new Promise<Response>((resolve) => {
        probeResolvers.push(() =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                { url: NODE_A, latency_ms: 50, error: '' },
                { url: NODE_B, latency_ms: 100, error: '' },
              ],
            }),
          } as Response)
        )
      })
    }
    return Promise.resolve(undefined as unknown as Response)
  }) as typeof fetch
  return {
    fetchCalls: () => fetchCalls,
    resolveProbe: () => {
      for (const resolve of probeResolvers) resolve()
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

describe('fastest node redirect', () => {
  test('redirects after items swap mid-probe instead of cancelling', async () => {
    localStorage.clear()
    let replacedUrl: string | null = null
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        replace: (url: string) => {
          replacedUrl = url
        },
      },
    })
    const fetchControl = installServerProbeFetch()

    try {
      const rendered = await renderRedirect([node(NODE_A), node(NODE_B)])
      expect(fetchControl.fetchCalls()).toBe(1)

      // Simulate react-query swapping placeholder status for fresh data:
      // the items array identity changes, which re-runs the effect.
      await act(async () => {
        rendered.root.render(<FastestNodeRedirect items={[node(NODE_A), node(NODE_B)]} />)
      })
      expect(
        fetchControl.fetchCalls(),
        'probe must not restart on data swap'
      ).toBe(1)

      fetchControl.resolveProbe()
      await act(async () => {})

      expect(replacedUrl).toBe(NODE_A)
      expect(readProbeMemory()?.url).toBe(NODE_A)

      await unmountRedirect(rendered)
    } finally {
      fetchControl.restore()
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: window.location,
      })
    }
  })

  test('redirects under StrictMode double-mounting', async () => {
    localStorage.clear()
    let replacedUrl: string | null = null
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        replace: (url: string) => {
          replacedUrl = url
        },
      },
    })
    const fetchControl = installServerProbeFetch()

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
      expect(fetchControl.fetchCalls()).toBe(1)

      fetchControl.resolveProbe()
      await act(async () => {})

      expect(replacedUrl).toBe(NODE_A)
      expect(readProbeMemory()?.url).toBe(NODE_A)

      await act(async () => root.unmount())
      container.remove()
    } finally {
      fetchControl.restore()
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: window.location,
      })
    }
  })

  test('does not probe when fewer than two nodes are configured', async () => {
    localStorage.clear()
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      fetchCalls += 1
      return Promise.resolve(undefined)
    }) as unknown as typeof fetch

    try {
      const rendered = await renderRedirect([node(NODE_A)])
      expect(fetchCalls).toBe(0)
      await unmountRedirect(rendered)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('does not probe again while the cooldown memory is fresh', async () => {
    localStorage.clear()
    localStorage.setItem(
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
      expect(fetchCalls).toBe(0)
      await unmountRedirect(rendered)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})