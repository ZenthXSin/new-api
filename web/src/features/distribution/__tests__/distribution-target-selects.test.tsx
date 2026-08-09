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
import { after, test } from 'node:test'

import { Window } from 'happy-dom'

const domWindow = new Window()
for (const key of [
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
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const) {
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
    en: { translation: { Platform: 'Platform', Architecture: 'Architecture' } },
  },
})

const { DistributionTargetSelects } =
  await import('../distribution-target-selects')

function keydown(element: Element, key: string) {
  element.dispatchEvent(
    new domWindow.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
    }) as unknown as Event
  )
}

async function selectWithKeyboard(
  dropdown: Element,
  expectedLabels: string[],
  selectedLabel: string
) {
  await act(async () => {
    ;(dropdown as HTMLElement).focus()
    keydown(dropdown, 'ArrowDown')
  })

  assert.equal(dropdown.getAttribute('aria-expanded'), 'true')
  const listboxID = dropdown.getAttribute('aria-controls')
  assert.ok(listboxID)
  const listbox = document.querySelector<HTMLElement>(`#${listboxID}`)
  assert.ok(listbox)
  const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')]
  assert.deepEqual(
    options.map((option) => option.textContent),
    expectedLabels
  )

  const selectedOption = options.find(
    (option) => option.textContent === selectedLabel
  )
  assert.ok(selectedOption)

  await act(async () => {
    selectedOption.focus()
    keydown(selectedOption, 'Enter')
  })
}

test('exposes valid targets and selects them by keyboard', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let platform: string | undefined
  let architecture: string | undefined

  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <DistributionTargetSelects
          platform='windows'
          architecture='amd64'
          onPlatformChange={(value) => {
            platform = value
          }}
          onArchitectureChange={(value) => {
            architecture = value
          }}
        />
      </I18nextProvider>
    )
  })

  const dropdowns = container.querySelectorAll('[role="combobox"]')
  assert.equal(dropdowns.length, 2)
  assert.equal(dropdowns[0]?.getAttribute('aria-label'), 'Platform')
  assert.equal(dropdowns[1]?.getAttribute('aria-label'), 'Architecture')
  assert.match(dropdowns[0]?.textContent ?? '', /Windows/)
  assert.match(dropdowns[1]?.textContent ?? '', /amd64/)

  await selectWithKeyboard(
    dropdowns[0] as Element,
    ['Windows', 'Linux', 'macOS', 'Android'],
    'Linux'
  )
  assert.equal(platform, 'linux')

  await selectWithKeyboard(
    dropdowns[1] as Element,
    ['amd64 (x86_64)', 'arm64 (AArch64)', '386 (x86)', 'ARM', 'Universal'],
    'arm64 (AArch64)'
  )
  assert.equal(architecture, 'arm64')

  await act(async () => root.unmount())
  container.remove()
})

after(() => domWindow.close())
