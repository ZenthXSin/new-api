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
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'

import { CodexEffortSelector } from '../components/effort-selector'
import { CodexModelSelector } from '../components/model-selector'
import { CodexSelect } from '../components/select'
import type { CodexCatalog } from '../types'
import { status } from './fixtures'

const catalog: CodexCatalog = {
  defaultGroup: 'standard',
  defaultModel: 'coding-one',
  groups: [
    {
      id: 'standard',
      name: 'Standard',
      description: '',
      ratio: 1,
      models: [
        { id: 'coding-one', name: 'Coding One', supported: true },
        { id: 'images', name: 'Images', supported: false },
        { id: 'coding-two', name: 'Coding Two', supported: true },
      ],
    },
    {
      id: 'team',
      name: 'Team',
      description: '',
      ratio: 2,
      models: [{ id: 'coding-one', name: 'Coding One', supported: true }],
    },
  ],
}

function EffortMenu(props: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('low')
  return (
    <CodexEffortSelector
      efforts={['low', 'high', 'xhigh']}
      value={value}
      onChange={(next) => {
        setValue(next)
        props.onChange(next)
      }}
    />
  )
}

test('keyboard search skips unsupported models and returns focus after choosing a model', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      group='standard'
      onSelect={onSelect}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Codex model' })
  trigger.focus()
  await user.keyboard('{Enter}')
  const search = screen.getByRole('combobox', { name: 'Search all models' })
  await waitFor(() => expect(search).toHaveFocus())
  expect(screen.getByRole('option', { name: /Images/ })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  await user.keyboard('{ArrowDown}{Enter}')
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('coding-two', 'standard')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('Escape closes search without changing the selection and the next opening resets search', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      group='standard'
      onSelect={onSelect}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Codex model' })
  await user.click(trigger)
  await user.type(
    screen.getByRole('combobox', { name: 'Search all models' }),
    'missing'
  )
  expect(screen.getByText('No matching models')).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(onSelect).not.toHaveBeenCalled()
  await user.keyboard('{Enter}')
  expect(
    screen.getByRole('combobox', { name: 'Search all models' })
  ).toHaveValue('')
  expect(screen.getByRole('option', { name: 'Coding Two' })).toBeVisible()
})

test('loading hides stale catalog choices until the current catalog is ready', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const view = render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      loading
      onSelect={onSelect}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Codex model' }))
  expect(screen.getByRole('status')).toHaveTextContent('Loading models…')
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  view.rerender(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      onSelect={onSelect}
    />
  )
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Coding Two' })).toBeVisible()
})

test('keyboard group filtering preserves the group when the same model belongs to multiple groups', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      group='standard'
      onSelect={onSelect}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Codex model' }))
  const filter = screen.getByRole('combobox', { name: 'Model group' })
  filter.focus()
  await user.keyboard('{Enter}{End}{Enter}')
  expect(onSelect).not.toHaveBeenCalled()
  expect(filter).toHaveTextContent('Team')
  expect(
    screen.queryByRole('option', { name: 'Coding Two' })
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('option', { name: 'Coding One' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('coding-one', 'team')
})

test('Escape closes the group filter before the model menu and restores each trigger', async () => {
  const user = userEvent.setup()
  render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      onSelect={vi.fn()}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Codex model' })
  await user.click(trigger)
  const filter = screen.getByRole('combobox', { name: 'Model group' })
  await user.click(filter)
  await user.keyboard('{Escape}')
  expect(filter).toHaveAttribute('aria-expanded', 'false')
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await waitFor(() => expect(filter).toHaveFocus())
  await user.keyboard('{Escape}')
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await waitFor(() => expect(trigger).toHaveFocus())
})

test('unsupported models ignore pointer selection while the catalog stays open', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      onSelect={onSelect}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Codex model' })
  await user.click(trigger)
  await user.click(screen.getByRole('option', { name: /Images/ }))
  expect(onSelect).not.toHaveBeenCalled()
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
})

test('status-only catalogs retain the model id and group when no catalog endpoint is available', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <CodexModelSelector
      status={status}
      model='codex-test'
      group='legacy'
      onSelect={onSelect}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Codex model' }))
  await user.click(screen.getByRole('option', { name: 'Codex Test' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('codex-test', 'legacy')
})

test('disabled model triggers cannot expose a catalog or dispatch a selection', () => {
  const onSelect = vi.fn()
  render(
    <CodexModelSelector
      catalog={catalog}
      model='coding-one'
      disabled
      onSelect={onSelect}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Codex model' })
  expect(trigger).toBeDisabled()
  fireEvent.click(trigger)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
})

test('effort keyboard navigation selects only a supplied effort and restores focus', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<EffortMenu onChange={onChange} />)
  const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
  trigger.focus()
  await user.keyboard('{Enter}')
  const list = screen.getByRole('listbox', { name: 'Reasoning effort' })
  expect(
    within(list)
      .getAllByRole('option')
      .map((option) => option.textContent)
  ).toEqual(['Low', 'High', 'Extra high'])
  await user.keyboard('{End}{Enter}')
  expect(onChange).toHaveBeenCalledExactlyOnceWith('xhigh')
  expect(trigger).toHaveTextContent('Extra high')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('an effort that becomes disabled closes its open menu without dispatching a change', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const view = render(
    <CodexEffortSelector
      efforts={['low', 'high']}
      value='low'
      onChange={onChange}
    />
  )
  await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }))
  view.rerender(
    <CodexEffortSelector
      efforts={['low', 'high']}
      value='low'
      disabled
      onChange={onChange}
    />
  )
  expect(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  ).toHaveAttribute('aria-expanded', 'false')
  expect(
    screen.queryByRole('listbox', { name: 'Reasoning effort' })
  ).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
})

test('Escape leaves the current effort unchanged and returns to its trigger', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<EffortMenu onChange={onChange} />)
  const trigger = screen.getByRole('combobox', { name: 'Reasoning effort' })
  await user.click(trigger)
  await user.keyboard('{ArrowDown}{Escape}')
  expect(onChange).not.toHaveBeenCalled()
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(trigger).toHaveTextContent('Low')
})

test.each([
  { efforts: [] },
  { efforts: ['high'] },
  { efforts: ['high', 'high'] },
])('zero or one distinct effort disables the menu: %j', ({ efforts }) => {
  const onChange = vi.fn()
  render(
    <CodexEffortSelector efforts={efforts} value='high' onChange={onChange} />
  )
  expect(
    screen.getByRole('combobox', { name: 'Reasoning effort' })
  ).toBeDisabled()
})

test('the generic selector exposes invalid state and wraps long options inside a bounded scrolling menu', async () => {
  const user = userEvent.setup()
  const label =
    'Long model group name that remains readable on a narrow mobile screen'
  render(
    <CodexSelect
      label='Group'
      value='long'
      invalid
      options={[{ value: 'long', label }]}
      onChange={vi.fn()}
    />
  )
  const trigger = screen.getByRole('combobox', { name: 'Group' })
  expect(trigger).toHaveAttribute('aria-invalid', 'true')
  await user.click(trigger)
  const option = screen.getByRole('option', { name: label })
  expect(option).toHaveAttribute('aria-selected', 'true')
  expect(within(option).getByText(label)).toHaveClass('break-words')
  const popup = screen.getByRole('listbox', { name: 'Group' }).parentElement
  expect(popup).toHaveClass(
    'max-w-[calc(100vw-24px)]',
    'overflow-y-auto',
    'overflow-x-hidden'
  )
})
