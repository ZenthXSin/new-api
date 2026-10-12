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
import { beforeEach, describe, expect, test, vi } from 'vitest'

const REGION_REMINDER_DISMISSED_KEY = 'region-reminder-dismissed'

type GeoCheckData = {
  enabled: boolean
  country_code: string
  country_name: string
  matched: boolean
  message: string
}

// 每个用例通过修改该状态控制 getGeoCheck 的返回
const { geoCheckState } = vi.hoisted(() => ({
  geoCheckState: { current: null } as { current: GeoCheckData | null },
}))

vi.mock('@/lib/api', () => ({
  getGeoCheck: async () => geoCheckState.current,
}))

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
        'Region Reminder': 'Region Reminder',
        OK: 'OK',
      },
    },
  },
})

const { RegionReminder } = await import('@/components/region-reminder')

type RenderedReminder = {
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
}

async function renderReminder(): Promise<RenderedReminder> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <RegionReminder />
      </I18nextProvider>
    )
  })
  // 冲刷 getGeoCheck 异步链路与弹窗挂载
  await act(async () => {})

  return { container, root }
}

async function unmountReminder(rendered: RenderedReminder) {
  await act(async () => rendered.root.unmount())
  rendered.container.remove()
  document.body.querySelector('[data-slot="dialog-content"]')?.remove()
}

function openDialogContent(): Element | null {
  return document.body.querySelector('[data-slot="dialog-content"][data-open]')
}

const matchedData: GeoCheckData = {
  enabled: true,
  country_code: 'CN',
  country_name: 'China Mainland',
  matched: true,
  message: 'Notice: access from your region is restricted.',
}

describe('region reminder', () => {
  beforeEach(() => {
    localStorage.clear()
    geoCheckState.current = null
  })

  test('shows the reminder dialog with the message and an OK button when the region matches and no dismissal marker exists', async () => {
    geoCheckState.current = matchedData

    const rendered = await renderReminder()

    const content = openDialogContent()
    expect(content).not.toBeNull()
    if (content === null) return
    expect(content.textContent ?? '').toMatch(
      /Notice: access from your region is restricted\./
    )
    expect(content.textContent ?? '').toMatch(/Region Reminder/)

    const okButton = content.querySelector('button')
    expect(okButton).not.toBeNull()
    if (okButton === null) return
    expect(okButton.textContent ?? '').toMatch(/OK/)

    await unmountReminder(rendered)
  })

  test('clicking OK closes the dialog and persists the dismissal marker in localStorage', async () => {
    geoCheckState.current = matchedData

    const rendered = await renderReminder()

    const content = openDialogContent()
    expect(content).not.toBeNull()
    if (content === null) return
    const okButton = content.querySelector('button')
    expect(okButton).not.toBeNull()
    if (okButton === null) return

    await act(async () => {
      okButton.click()
    })
    await act(async () => {})

    expect(localStorage.getItem(REGION_REMINDER_DISMISSED_KEY)).toBe('1')
    expect(openDialogContent(), 'dialog should be closed').toBeNull()

    await unmountReminder(rendered)
  })

  test('renders nothing when the dismissal marker already exists', async () => {
    localStorage.setItem(REGION_REMINDER_DISMISSED_KEY, '1')
    geoCheckState.current = matchedData

    const rendered = await renderReminder()

    expect(rendered.container.textContent).toBe('')
    expect(
      document.body.querySelector('[data-slot="dialog-content"]')
    ).toBeNull()

    await unmountReminder(rendered)
  })

  test('renders nothing when the region does not match', async () => {
    geoCheckState.current = {
      enabled: true,
      country_code: 'US',
      country_name: 'United States',
      matched: false,
      message: '',
    }

    const rendered = await renderReminder()

    expect(rendered.container.textContent).toBe('')
    expect(
      document.body.querySelector('[data-slot="dialog-content"]')
    ).toBeNull()

    await unmountReminder(rendered)
  })

  test('renders nothing when the geo check fails', async () => {
    geoCheckState.current = null

    const rendered = await renderReminder()

    expect(rendered.container.textContent).toBe('')
    expect(
      document.body.querySelector('[data-slot="dialog-content"]')
    ).toBeNull()

    await unmountReminder(rendered)
  })

  test('renders nothing when the reminder is disabled', async () => {
    geoCheckState.current = {
      enabled: false,
      country_code: 'CN',
      country_name: 'China Mainland',
      matched: true,
      message: 'Notice: access from your region is restricted.',
    }

    const rendered = await renderReminder()

    expect(rendered.container.textContent).toBe('')
    expect(
      document.body.querySelector('[data-slot="dialog-content"]')
    ).toBeNull()

    await unmountReminder(rendered)
  })
})
