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
import { describe, expect, it } from 'vitest'

import { createUserMessage } from '../../../lib/message/message-utils'
import { PlaygroundChat } from '../playground-chat'

describe('playground history access', () => {
  it('lets users reveal older messages without removing recent history', async () => {
    const user = userEvent.setup()
    const messages = Array.from({ length: 25 }, (_, index) =>
      createUserMessage(`Message ${index + 1}.`)
    )
    render(<PlaygroundChat messages={messages} />)
    expect(screen.queryByText('Message 1.')).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Load earlier messages' })
    )
    expect(screen.getByText('Message 1.')).toBeInTheDocument()
    expect(screen.getByText('Message 25.')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load earlier messages' })
    ).not.toBeInTheDocument()
  })
})
