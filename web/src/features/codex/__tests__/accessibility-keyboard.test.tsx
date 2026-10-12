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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { CodexSelect } from '../components/select'
import { WorkspaceList } from '../components/workspace-list'
import { workspace } from './fixtures'

function MobileNavigation() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button type='button' onClick={() => setOpen(true)}>
        Open project list
      </button>
      <button type='button'>Outside action</button>
      <WorkspaceList
        workspaces={[workspace]}
        expandedWorkspaceIds={[]}
        onToggleWorkspace={vi.fn()}
        open={open}
        onClose={close}
        onNew={vi.fn()}
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />
    </>
  )
}

describe('Codex keyboard accessibility', () => {
  test('opening mobile navigation enters a named dialog and Escape restores focus to its opener', async () => {
    render(<MobileNavigation />)
    const opener = screen.getByRole('button', { name: 'Open project list' })
    opener.focus()
    await userEvent.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Codex projects' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const close = within(dialog).getByRole('button', {
      name: 'Close project list',
    })
    await waitFor(() => expect(close).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Codex projects' })
      ).not.toBeInTheDocument()
    )
    expect(opener).toHaveFocus()
  })

  test('Tab and Shift Tab remain inside the open mobile navigation at both boundaries', async () => {
    render(<MobileNavigation />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Open project list' })
    )
    const dialog = await screen.findByRole('dialog', { name: 'Codex projects' })
    const close = within(dialog).getByRole('button', {
      name: 'Close project list',
    })
    const last = within(dialog).getByRole('button', {
      name: 'Back to dashboard',
    })
    await waitFor(() => expect(close).toHaveFocus())
    await userEvent.tab({ shift: true })
    expect(last).toHaveFocus()
    await userEvent.tab()
    expect(close).toHaveFocus()
  })

  test('execution mode supports arrow selection and Escape restores the trigger without changing the selection', async () => {
    const onChange = vi.fn()
    render(
      <CodexSelect
        label='Codex mode'
        value='code'
        options={[
          { value: 'code', label: 'Code' },
          { value: 'ask', label: 'Ask' },
        ]}
        onChange={onChange}
      />
    )
    const trigger = screen.getByRole('combobox', { name: 'Codex mode' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    const selected = await screen.findByRole('option', { name: 'Code' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(selected).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}{Escape}')
    await waitFor(() =>
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    )
    expect(trigger).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}{ArrowDown}{Enter}')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('ask'))
    expect(trigger).toHaveFocus()
  })
})
