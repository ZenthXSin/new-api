/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import assert from 'node:assert/strict'

import { Window } from 'happy-dom'
import type React from 'react'

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

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'First token': 'First token',
        Duration: 'Duration',
        'View detailed timing': 'View detailed timing',
        'Timing details': 'Timing details',
        'Site processing': 'Site processing',
        'Upstream connection': 'Upstream connection',
        Reused: 'Reused',
        'Upstream first event': 'Upstream first event',
        'Relay processing': 'Relay processing',
        'Downstream send': 'Downstream send',
        'Total time': 'Total time',
        'Sent bytes': 'Sent bytes',
        'End status': 'End status',
        'N/A': 'N/A',
      },
    },
  },
})

const { TimingMetricsCell } = await import('../timing-metrics-cell')

type RenderedTiming = {
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
}

async function renderTiming(
  props: React.ComponentProps<typeof TimingMetricsCell>
): Promise<RenderedTiming> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <TimingMetricsCell {...props} />
      </I18nextProvider>
    )
  })

  return { container, root }
}

async function unmountTiming(rendered: RenderedTiming) {
  await act(async () => rendered.root.unmount())
  rendered.container.remove()
  document.body.querySelector('[data-slot="popover-content"]')?.remove()
}

describe('timing metrics cell', () => {
  after(() => {
    domWindow.close()
  })

  test('opens detailed timing and toggles the accessible expanded state', async () => {
    const rendered = await renderTiming({
      useTimeSec: 2.5,
      completionTokens: 120,
      frtMs: 450,
      isStream: true,
      detailedTiming: {
        site_processing_ms: 12,
        upstream_connection: {
          dns_ms: 4,
          tcp_ms: 9,
          tls_ms: 22,
        },
        upstream_first_event_ms: 450,
        relay_processing_ms: 15,
        downstream_send_ms: 8,
        total_ms: 2500,
        sent_bytes: 1024,
        end_status: 'normal',
      },
    })

    const button = rendered.container.querySelector('button')
    assert.ok(button)
    assert.equal(button.getAttribute('aria-label'), 'View detailed timing')
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    assert.match(rendered.container.textContent ?? '', /First token/)
    assert.match(rendered.container.textContent ?? '', /Duration/)

    await act(async () => button.click())
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.match(document.body.textContent ?? '', /Timing details/)
    assert.match(document.body.textContent ?? '', /Site processing/)
    assert.match(document.body.textContent ?? '', /DNS 4 ms/)
    assert.match(document.body.textContent ?? '', /Sent bytes/)

    await act(async () => button.click())
    assert.equal(button.getAttribute('aria-expanded'), 'false')

    await unmountTiming(rendered)
  })

  test('keeps the compact summary non-clickable when timing data is absent', async () => {
    const rendered = await renderTiming({
      useTimeSec: 1.2,
      completionTokens: 0,
      frtMs: 300,
      isStream: true,
    })

    assert.equal(rendered.container.querySelector('button'), null)
    assert.match(rendered.container.textContent ?? '', /First token/)
    assert.match(rendered.container.textContent ?? '', /Duration/)

    await unmountTiming(rendered)
  })
})
