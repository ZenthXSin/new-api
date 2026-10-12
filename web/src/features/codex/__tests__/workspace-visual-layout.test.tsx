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

import { readFileSync } from 'node:fs'

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { CodexComposer } from '../components/composer'
import { status } from './fixtures'

const stylesheet = readFileSync('src/features/codex/chatgpt.css', 'utf8')
const props = {
  status,
  model: 'codex-test',
  effort: 'high',
  mode: 'code' as const,
  onModel: vi.fn(),
  onEffort: vi.fn(),
  onMode: vi.fn(),
  onSubmit: vi.fn().mockResolvedValue(undefined),
}
let style: HTMLStyleElement

beforeEach(() => {
  style = document.createElement('style')
  style.textContent = stylesheet
  document.head.append(style)
})

afterEach(() => {
  style.remove()
  document.documentElement.classList.remove('dark')
})

test('a task follow-up keeps approval and the combined model and effort control in a compact toolbar', () => {
  render(
    <div className='codex-zcode codex-chatgpt codex-web'>
      <CodexComposer {...props} compact onUploadFiles={vi.fn()} />
    </div>
  )
  const approval = screen.getByRole('combobox', { name: 'Approval mode' })
  expect(
    screen.queryByRole('combobox', { name: 'Codex model' })
  ).not.toBeInTheDocument()
  const effort = screen.getByRole('combobox', { name: 'Reasoning effort' })
  expect(approval).toBeVisible()
  expect(effort).toBeVisible()
  const toolbar = approval.closest('.codex-task-composer-toolbar')
  expect(toolbar).not.toBeNull()
  expect(toolbar).toContainElement(effort)
  expect(getComputedStyle(toolbar as HTMLElement).flexWrap).toBe('nowrap')
  expect(getComputedStyle(toolbar as HTMLElement).minWidth).toBe('0px')
  expect(effort).toHaveTextContent('Codex Test')
  expect(effort).toHaveTextContent('High')
})

test('a long draft scrolls inside the composer without allowing manual resize', () => {
  render(
    <div className='codex-zcode codex-chatgpt codex-web'>
      <CodexComposer {...props} />
    </div>
  )
  const textbox = screen.getByRole('textbox')
  fireEvent.change(textbox, {
    target: {
      value: 'Review the repository and explain each change.\n'.repeat(20),
    },
  })
  const computed = getComputedStyle(textbox)
  expect(computed.maxHeight).toBe('224px')
  expect(computed.overflowY).toBe('auto')
  expect(computed.overflowX).toBe('hidden')
  expect(computed.resize).toBe('none')
  expect(textbox).toHaveValue(
    'Review the repository and explain each change.\n'.repeat(20)
  )
})

test('the empty composer retains a disabled circular send control', () => {
  render(
    <div className='codex-zcode codex-chatgpt codex-web'>
      <CodexComposer {...props} />
    </div>
  )
  const send = screen.getByRole('button', { name: 'Start task' })
  expect(send).toBeDisabled()
  const computed = getComputedStyle(send)
  expect(computed.width).toBe('36px')
  expect(computed.height).toBe('36px')
  expect(computed.borderRadius).toBe('50%')
})

test('the approval menu inherits the dark workspace theme when opened through a portal', async () => {
  document.documentElement.classList.add('dark')
  render(
    <div className='codex-zcode codex-chatgpt codex-web'>
      <CodexComposer {...props} />
    </div>
  )
  await userEvent.click(screen.getByRole('combobox', { name: 'Approval mode' }))
  const list = await screen.findByRole('listbox', { name: 'Approval mode' })
  const popup = list.closest('.chatgpt-popover')
  expect(popup).not.toBeNull()
  const computed = getComputedStyle(popup as HTMLElement)
  expect(computed.getPropertyValue('--chatgpt-popover').trim()).toBe('#2f2f2f')
  expect(computed.colorScheme).toBe('dark')
  expect(computed.borderRadius).toBe('14px')
})
