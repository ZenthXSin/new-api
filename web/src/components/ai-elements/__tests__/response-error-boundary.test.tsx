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
import { describe, expect, test, vi } from 'vitest'

import { ResponseErrorBoundary } from '../response-error-boundary'

function UnavailableRenderer(): never {
  throw new Error('Local renderer failure')
}

describe('Markdown rendering isolation', () => {
  test('keeps original newlines and literal markup if a child cannot render, then recovers on the next update', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const original = '# Original\n\n<script>literal</script>'
    const { container, rerender } = render(
      <ResponseErrorBoundary content={original} final={false}>
        <UnavailableRenderer />
      </ResponseErrorBoundary>
    )
    expect(container.textContent).toBe(original)
    expect(container.querySelector('script')).toBeNull()
    expect(container.firstElementChild).toHaveClass('whitespace-pre-wrap')
    rerender(
      <ResponseErrorBoundary content={`${original}\nMore`} final={false}>
        <p>Recovered response</p>
      </ResponseErrorBoundary>
    )
    expect(screen.getByText('Recovered response')).toBeVisible()
  })

  test('retries parsing when the stream becomes final even if its text has not changed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <ResponseErrorBoundary content='partial' final={false}>
        <UnavailableRenderer />
      </ResponseErrorBoundary>
    )
    expect(screen.getByText('partial')).toBeVisible()
    rerender(
      <ResponseErrorBoundary content='partial' final>
        <p>Complete response</p>
      </ResponseErrorBoundary>
    )
    expect(screen.getByText('Complete response')).toBeVisible()
  })
})
