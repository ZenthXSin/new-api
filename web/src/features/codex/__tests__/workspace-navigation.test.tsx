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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { describe, expect, test, vi } from 'vitest'

import { ProjectTime, WorkspaceList } from '../components/workspace-list'
import { workspace } from './fixtures'

const props = {
  workspaces: [
    workspace,
    { ...workspace, id: 'old', name: 'Archived project', archived: true },
  ],
  open: true,
  onClose: vi.fn(),
  onNew: vi.fn(),
  onSelect: vi.fn(),
  onBack: vi.fn(),
}
describe('Codex project navigation', () => {
  test('Chinese project timestamps render with the site language code', async () => {
    const previous = i18next.language
    try {
      await i18next.changeLanguage('zhCN')
      render(<ProjectTime value={Date.now() - 3600_000} />)
      expect(screen.getByText(/1.*小时/)).toHaveAttribute('datetime')
    } finally {
      await i18next.changeLanguage(previous)
    }
  })
  test('running projects are grouped separately and recent projects show update times', () => {
    render(
      <WorkspaceList
        {...props}
        workspaces={[
          {
            ...workspace,
            id: 'active',
            name: 'API service',
            status: 'running',
            updatedAt: Date.now(),
          },
          { ...workspace, updatedAt: Date.now() - 3600_000 },
        ]}
      />
    )
    expect(
      within(screen.getByRole('region', { name: 'In progress' })).getByRole(
        'button',
        { name: /API service/ }
      )
    ).toBeVisible()
    expect(
      within(screen.getByRole('region', { name: 'Recent projects' })).getByRole(
        'button',
        { name: /Website project/ }
      )
    ).toBeVisible()
    expect(screen.getByText('1h ago')).toHaveAttribute('datetime')
  })
  test('clearing a project search restores the list and keyboard Escape closes the mobile drawer', async () => {
    const onClose = vi.fn()
    render(<WorkspaceList {...props} onClose={onClose} />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search projects' }),
      'missing'
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear project search' })
    )
    expect(
      screen.getByRole('textbox', { name: 'Search projects' })
    ).toHaveValue('')
    expect(
      screen.getByRole('button', { name: /Website project/ })
    ).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })
  test('the selected project is accessible and archived projects are separated', async () => {
    render(<WorkspaceList {...props} selected={workspace.id} />)
    expect(
      screen.getByRole('button', { name: /Website project/ })
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.queryByRole('button', { name: /Archived project/ })
    ).not.toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Show archived projects' })
    )
    expect(
      screen.getByRole('button', { name: 'Show archived projects' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: /Archived project/ })
    ).toBeVisible()
  })
  test('search filters names and displays an explicit no-match state', async () => {
    render(<WorkspaceList {...props} />)
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Search projects' }),
      'unknown'
    )
    expect(screen.getByText('No matching projects.')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: /Website project/ })
    ).not.toBeInTheDocument()
  })
})
