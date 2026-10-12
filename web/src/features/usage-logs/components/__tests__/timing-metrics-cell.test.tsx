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
import type React from 'react'
import { describe, expect, test } from 'vitest'

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
    expect(button).not.toBeNull()
    if (button === null) return
    expect(button.getAttribute('aria-label')).toBe('View detailed timing')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(rendered.container.textContent ?? '').toMatch(/First token/)
    expect(rendered.container.textContent ?? '').toMatch(/Duration/)

    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent ?? '').toMatch(/Timing details/)
    expect(document.body.textContent ?? '').toMatch(/Site processing/)
    expect(document.body.textContent ?? '').toMatch(/DNS 4 ms/)
    expect(document.body.textContent ?? '').toMatch(/Sent bytes/)

    await act(async () => button.click())
    expect(button.getAttribute('aria-expanded')).toBe('false')

    await unmountTiming(rendered)
  })

  test('keeps the compact summary non-clickable when timing data is absent', async () => {
    const rendered = await renderTiming({
      useTimeSec: 1.2,
      completionTokens: 0,
      frtMs: 300,
      isStream: true,
    })

    expect(rendered.container.querySelector('button')).toBe(null)
    expect(rendered.container.textContent ?? '').toMatch(/First token/)
    expect(rendered.container.textContent ?? '').toMatch(/Duration/)

    await unmountTiming(rendered)
  })
})
