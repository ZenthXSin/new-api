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

import { Window } from 'happy-dom'

const nodeTestApi = await import('node:test')
const testGlobals = globalThis as typeof globalThis & {
  after?: typeof nodeTestApi.after
  beforeEach?: typeof nodeTestApi.beforeEach
  describe?: typeof nodeTestApi.describe
  test?: typeof nodeTestApi.test
}
const after = testGlobals.after ?? nodeTestApi.after
const beforeEach = testGlobals.beforeEach ?? nodeTestApi.beforeEach
const describe = testGlobals.describe ?? nodeTestApi.describe
const test = testGlobals.test ?? nodeTestApi.test
// 测试运行器（bun test）提供模块级 mock；静态引入类型解析不到
// `bun:test`，这里运行时获取。
const bunTestSpecifier = 'bun:test'
const { mock } = (await import(bunTestSpecifier)) as unknown as {
  mock: { module: (path: string, factory: () => unknown) => void }
}

const REGION_REMINDER_DISMISSED_KEY = 'region-reminder-dismissed'

type GeoCheckData = {
  enabled: boolean
  country_code: string
  country_name: string
  matched: boolean
  message: string
}

// 每个用例通过修改该状态控制 getGeoCheck 的返回
const geoCheckState: { current: GeoCheckData | null } = { current: null }

mock.module('@/lib/api', () => ({
  getGeoCheck: async () => geoCheckState.current,
}))

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
    domWindow.localStorage.clear()
    geoCheckState.current = null
  })

  after(() => {
    domWindow.close()
  })

  test('shows the reminder dialog with the message and an OK button when the region matches and no dismissal marker exists', async () => {
    geoCheckState.current = matchedData

    const rendered = await renderReminder()

    const content = openDialogContent()
    assert.ok(content, 'dialog should be open')
    assert.match(content.textContent ?? '', /Notice: access from your region is restricted\./)
    assert.match(content.textContent ?? '', /Region Reminder/)

    const okButton = content.querySelector('button')
    assert.ok(okButton)
    assert.match(okButton.textContent ?? '', /OK/)

    await unmountReminder(rendered)
  })

  test('clicking OK closes the dialog and persists the dismissal marker in localStorage', async () => {
    geoCheckState.current = matchedData

    const rendered = await renderReminder()

    const content = openDialogContent()
    assert.ok(content, 'dialog should be open')
    const okButton = content.querySelector('button')
    assert.ok(okButton)

    await act(async () => {
      okButton.click()
    })
    await act(async () => {})

    assert.equal(
      domWindow.localStorage.getItem(REGION_REMINDER_DISMISSED_KEY),
      '1'
    )
    assert.equal(openDialogContent(), null, 'dialog should be closed')

    await unmountReminder(rendered)
  })

  test('renders nothing when the dismissal marker already exists', async () => {
    domWindow.localStorage.setItem(REGION_REMINDER_DISMISSED_KEY, '1')
    geoCheckState.current = matchedData

    const rendered = await renderReminder()

    assert.equal(rendered.container.textContent, '')
    assert.equal(document.body.querySelector('[data-slot="dialog-content"]'), null)

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

    assert.equal(rendered.container.textContent, '')
    assert.equal(document.body.querySelector('[data-slot="dialog-content"]'), null)

    await unmountReminder(rendered)
  })

  test('renders nothing when the geo check fails', async () => {
    geoCheckState.current = null

    const rendered = await renderReminder()

    assert.equal(rendered.container.textContent, '')
    assert.equal(document.body.querySelector('[data-slot="dialog-content"]'), null)

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

    assert.equal(rendered.container.textContent, '')
    assert.equal(document.body.querySelector('[data-slot="dialog-content"]'), null)

    await unmountReminder(rendered)
  })
})
