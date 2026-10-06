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
import { describe, expect, test } from 'vitest'

import { Response } from '../response'

describe('long Markdown responses', () => {
  test('keeps existing structure when a stream crosses 20,000 characters and completes', () => {
    const prefix =
      '# Long answer\n\n| Item | Value |\n| --- | --- |\n| preserved | 42 |\n\n'
    const before = prefix + 'paragraph words '.repeat(1200)
    const after = `${before}\n\n## Later section\n\n${'more words '.repeat(1000)}`
    const { container, rerender } = render(
      <Response final={false}>{before}</Response>
    )
    expect(screen.getByRole('heading', { name: 'Long answer' })).toBeVisible()
    expect(container.querySelector('table')).not.toBeNull()
    rerender(<Response final={false}>{after}</Response>)
    expect(screen.getByRole('heading', { name: 'Long answer' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Later section' })).toBeVisible()
    expect(container.querySelector('table')).not.toBeNull()
    rerender(<Response final>{after}</Response>)
    expect(screen.getByRole('heading', { name: 'Long answer' })).toBeVisible()
    expect(container.querySelector('table')).not.toBeNull()
  })

  test('renders a 100KB structured answer as Markdown without per-word animations', () => {
    const content = `# Large response\n\n${'A paragraph that remains readable. '.repeat(
      3000
    )}\n\n## Final section\n\n**Complete**`
    const { container } = render(<Response final={false}>{content}</Response>)
    expect(
      screen.getByRole('heading', { name: 'Large response' })
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Final section' })).toBeVisible()
    expect(container.querySelector('strong')?.textContent).toBe('Complete')
    expect(container.querySelectorAll('[data-stream-fade]')).toHaveLength(0)
  })
})
