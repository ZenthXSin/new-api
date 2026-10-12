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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'

import { CodexComposer } from '../components/composer'
import type { CodexMode, CodexTurnInput } from '../types'
import { status } from './fixtures'

test.each(['auto', 'full-access'] as const)(
  'selecting %s sends that permission mode with the task',
  async (mode) => {
    const submit = vi
      .fn<(input: CodexTurnInput) => Promise<void>>()
      .mockResolvedValue(undefined)
    function Composer() {
      const [value, setValue] = useState<CodexMode>('code')
      return (
        <CodexComposer
          status={status}
          model='codex-test'
          effort='high'
          mode={value}
          onMode={setValue}
          onModel={vi.fn()}
          onEffort={vi.fn()}
          onSubmit={submit}
        />
      )
    }
    render(<Composer />)
    await userEvent.click(
      screen.getByRole('combobox', { name: 'Approval mode' })
    )
    await userEvent.click(
      screen.getByRole('option', {
        name: mode === 'auto' ? /^Auto approve/ : /^Full access/,
      })
    )
    await userEvent.type(screen.getByRole('textbox'), 'Update the project')
    await userEvent.click(screen.getByRole('button', { name: 'Start task' }))
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ mode }))
  }
)
