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
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { PlaygroundParameterPanel } from '../playground-parameter-panel'

function ParameterFixture() {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [enabled, setEnabled] = useState(DEFAULT_PARAMETER_ENABLED)
  return (
    <PlaygroundParameterPanel
      config={config}
      parameterEnabled={enabled}
      onConfigChange={(key, value) =>
        setConfig((previous) => ({ ...previous, [key]: value }))
      }
      onParameterEnabledChange={(key, value) =>
        setEnabled((previous) => ({ ...previous, [key]: value }))
      }
    />
  )
}

describe('playground advanced parameter controls', () => {
  it('allows stream selection, persistent instructions and resetting options', async () => {
    const user = userEvent.setup()
    render(<ParameterFixture />)
    await user.click(screen.getByRole('button', { name: 'Parameters' }))
    const stream = await screen.findByRole('switch', {
      name: 'Stream response',
    })
    expect(stream).toBeChecked()
    await user.click(stream)
    expect(stream).not.toBeChecked()
    await user.type(
      screen.getByRole('textbox', { name: 'System instructions' }),
      'Be concise'
    )
    expect(
      screen.getByRole('textbox', { name: 'System instructions' })
    ).toHaveValue('Be concise')
    await user.click(screen.getByRole('button', { name: 'Reset parameters' }))
    expect(stream).toBeChecked()
    expect(
      screen.getByRole('textbox', { name: 'System instructions' })
    ).toHaveValue('')
  })
})
