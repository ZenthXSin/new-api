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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import zh from '@/i18n/locales/zh.json'

import { CodexComposer } from '../components/composer'
import { CodexReasoningControl } from '../components/reasoning-control'
import { status } from './fixtures'

function Composer(props: {
  efforts?: string[]
  running?: boolean
  disabled?: boolean
  onEffort?: (effort: string) => void
}) {
  const [effort, setEffort] = useState(props.efforts?.[0] ?? 'low')
  return (
    <CodexComposer
      status={{
        ...status,
        models: [
          { id: 'codex-test', name: 'Codex Test', efforts: props.efforts },
        ],
      }}
      model='codex-test'
      effort={effort}
      mode='code'
      running={props.running}
      disabled={props.disabled}
      onModel={vi.fn()}
      onMode={vi.fn()}
      onEffort={(next) => {
        setEffort(next)
        props.onEffort?.(next)
      }}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

afterEach(async () => {
  await i18next.changeLanguage('en')
})

test('reasoning settings expose a slider containing only the model-supported efforts', async () => {
  const onEffort = vi.fn()
  render(<Composer efforts={['low', 'high', 'xhigh']} onEffort={onEffort} />)
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  const slider = screen.getByRole('slider', { name: 'Reasoning effort' })
  expect(slider).toHaveAttribute('max', '2')
  expect(slider).toHaveAttribute('aria-valuetext', 'Low')
  fireEvent.change(slider, { target: { value: '2' } })
  expect(onEffort).toHaveBeenLastCalledWith('xhigh')
  expect(slider).toHaveAttribute('aria-valuetext', 'Extra high')
  fireEvent.change(slider, { target: { value: '1' } })
  expect(onEffort).toHaveBeenLastCalledWith('high')
  expect(onEffort).not.toHaveBeenCalledWith('medium')
})

test.each([{ running: true }])(
  'unavailable reasoning settings cannot open or change effort: %j',
  (props) => {
    const onEffort = vi.fn()
    render(<Composer {...props} onEffort={onEffort} />)
    const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(onEffort).not.toHaveBeenCalled()
  }
)

test('fixed-effort models keep their model settings reachable and disable the slider', async () => {
  render(<Composer efforts={['high']} />)
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  expect(screen.getByRole('slider')).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'Codex model' })).toBeEnabled()
})

test('reasoning tiers remain English while the surrounding controls follow the selected language', async () => {
  i18next.addResourceBundle('zh', 'translation', zh.translation)
  await act(() => i18next.changeLanguage('zh'))
  render(<Composer efforts={['high', 'xhigh']} />)
  await userEvent.click(screen.getByRole('combobox', { name: '推理强度' }))
  expect(screen.getByRole('slider', { name: '推理强度' })).toHaveAttribute(
    'aria-valuetext',
    'High'
  )
  expect(screen.getByRole('combobox', { name: '推理强度' })).toHaveTextContent(
    'High'
  )
  expect(screen.getByRole('heading')).toHaveTextContent('High')
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } })
  expect(screen.getByRole('slider')).toHaveAttribute(
    'aria-valuetext',
    'Extra high'
  )
  expect(screen.getByRole('combobox', { name: '推理强度' })).toHaveTextContent(
    'Extra high'
  )
})

test('idle composers omit static footer hints and keyboard help', () => {
  render(<Composer />)
  expect(
    screen.queryByText('Codex can edit files and run commands in this project.')
  ).not.toBeInTheDocument()
  expect(
    screen.queryByText('Enter to send · Shift + Enter for a new line')
  ).not.toBeInTheDocument()
  expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-describedby')
})

test('running composers omit the drafting reminder without a dangling accessible description', () => {
  render(<Composer running />)
  expect(
    screen.queryByText('You can draft your next message while Codex works.')
  ).not.toBeInTheDocument()
  expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-describedby')
})

test('keyboard opening focuses the effort slider and Escape returns focus to the pill', async () => {
  render(<Composer efforts={['low', 'medium', 'high', 'xhigh']} />)
  const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const slider = await screen.findByRole('slider', { name: 'Reasoning effort' })
  await waitFor(() => expect(slider).toHaveFocus())
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('reset restores the model default without changing the draft', async () => {
  render(<Composer efforts={['low', 'high']} />)
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Keep my draft' },
  })
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  await userEvent.click(
    screen.getByRole('button', { name: 'Reset reasoning effort' })
  )
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
  expect(screen.getByRole('textbox')).toHaveValue('Keep my draft')
})

test('a disabled composer keeps model recovery reachable while locking reasoning changes', async () => {
  render(<Composer efforts={['low', 'high']} disabled />)
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  expect(screen.getByRole('slider')).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'Codex model' })).toBeEnabled()
})

test('the closed reasoning pill displays the selected model and updates the current effort', async () => {
  render(<Composer efforts={['low', 'medium', 'high']} />)
  const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
  expect(trigger).toHaveTextContent('Codex Test')
  expect(trigger).toHaveTextContent('Low')
  await userEvent.click(trigger)
  fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } })
  await userEvent.keyboard('{Escape}')
  expect(trigger).toHaveTextContent('Codex Test')
  expect(trigger).toHaveTextContent('High')
  expect(trigger).not.toHaveTextContent('Low')
})

test('models that support six reasoning tiers expose max and ultra without changing the model', async () => {
  const onEffort = vi.fn()
  render(
    <Composer
      efforts={['low', 'medium', 'high', 'xhigh', 'max', 'ultra']}
      onEffort={onEffort}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
  await userEvent.click(trigger)
  const slider = screen.getByRole('slider')
  expect(slider).toHaveAttribute('max', '5')
  fireEvent.change(slider, { target: { value: '5' } })
  expect(onEffort).toHaveBeenLastCalledWith('ultra')
  expect(trigger).toHaveTextContent('Codex Test')
  expect(slider).toHaveAttribute('aria-valuetext', 'Ultra')
})

test('dragging previews every tier locally and commits only the final tier on release', async () => {
  const onEffort = vi.fn()
  render(
    <Composer
      efforts={['low', 'medium', 'high', 'xhigh', 'max', 'ultra']}
      onEffort={onEffort}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
  await userEvent.click(trigger)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { pointerId: 1 })
  fireEvent.change(slider, { target: { value: '2' } })
  expect(slider).toHaveAttribute('aria-valuetext', 'High')
  expect(trigger).toHaveTextContent('High')
  fireEvent.change(slider, { target: { value: '5' } })
  expect(slider).toHaveAttribute('aria-valuetext', 'Ultra')
  expect(onEffort).not.toHaveBeenCalled()
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(onEffort).toHaveBeenCalledExactlyOnceWith('ultra')
})

test('closing the settings during a drag commits the preview before returning to the composer', async () => {
  const onEffort = vi.fn()
  render(<Composer efforts={['low', 'medium', 'high']} onEffort={onEffort} />)
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { pointerId: 1 })
  fireEvent.change(slider, { target: { value: '2' } })
  expect(onEffort).not.toHaveBeenCalled()
  await userEvent.keyboard('{Escape}')
  expect(onEffort).toHaveBeenCalledExactlyOnceWith('high')
  expect(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('High')
})

test('disabling reasoning during a drag discards the preview and prevents a release from changing the task', async () => {
  const onChange = vi.fn()
  const props = {
    efforts: ['low', 'high'],
    value: 'low',
    modelName: 'Test',
    onChange,
  }
  const view = render(<CodexReasoningControl {...props} />)
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  fireEvent.pointerDown(screen.getByRole('slider'))
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } })
  view.rerender(<CodexReasoningControl {...props} sliderDisabled />)
  fireEvent.pointerUp(window)
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Low')
  expect(screen.getByRole('slider')).toBeDisabled()
})

test('switching models during a drag discards the previous model preview', async () => {
  const onChange = vi.fn()
  const view = render(
    <CodexReasoningControl
      efforts={['low', 'ultra']}
      value='low'
      modelName='First'
      onChange={onChange}
    />
  )
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  )
  fireEvent.pointerDown(screen.getByRole('slider'))
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } })
  view.rerender(
    <CodexReasoningControl
      efforts={['medium', 'high']}
      value='medium'
      modelName='Second'
      onChange={onChange}
    />
  )
  fireEvent.pointerUp(window)
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Medium')
  expect(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveTextContent('Second')
})
