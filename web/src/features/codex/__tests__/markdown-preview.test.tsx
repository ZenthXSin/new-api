import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodeBlock } from '../vendor/zcode/conversation/code-block'

vi.mock('@streamdown/mermaid', () => ({
  createMermaidPlugin: () => ({
    getMermaid: () => ({
      render: async () => ({
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 2400"><script>alert(1)</script><foreignObject><div>unsafe</div></foreignObject><text x="20" y="2350">Last diagram node</text></svg>',
      }),
    }),
  }),
}))

describe('Markdown fullscreen preview', () => {
  test('a long diagram can expand inline and open its sanitized rendering with zoom controls', async () => {
    const user = userEvent.setup()
    render(
      <CodeBlock
        code={'graph TD\nA --> B'}
        language='mermaid'
        enableSyntaxHighlighting
        theme='light'
      />
    )
    await screen.findByRole('img', { name: 'Mermaid diagram' })
    const expand = screen.getByRole('button', { name: 'Expand diagram' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    await user.click(expand)
    expect(
      screen.getByRole('button', { name: 'Collapse diagram' })
    ).toHaveAttribute('aria-expanded', 'true')
    await user.click(
      screen.getByRole('button', { name: 'Open fullscreen preview' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: /Fullscreen preview/,
    })
    const image = within(dialog).getByRole('img', { name: 'Mermaid diagram' })
    expect(image.getAttribute('src')).toContain('Last%20diagram%20node')
    expect(decodeURIComponent(image.getAttribute('src') ?? '')).not.toMatch(
      /<script|foreignObject/
    )
    await user.click(within(dialog).getByRole('button', { name: 'Zoom in' }))
    expect(
      within(dialog).getByRole('button', { name: 'Fit diagram' })
    ).toBeEnabled()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(
      screen.getByRole('button', { name: 'Open fullscreen preview' })
    ).toHaveFocus()
  })

  test('plaintext fallback opens the exact full source and retains line wrapping', async () => {
    const user = userEvent.setup(),
      source = 'line\n'.repeat(150) + 'Last source line'
    render(
      <CodeBlock
        code={source}
        language='text'
        enableSyntaxHighlighting={false}
        theme='dark'
      />
    )
    await user.click(
      screen.getByRole('button', { name: 'Open fullscreen preview' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByRole('region', { name: 'Code' }).textContent
    ).toBe(source)
    await user.click(
      within(dialog).getByRole('button', { name: 'Wrap code lines' })
    )
    expect(
      within(dialog).getByRole('button', { name: 'Wrap code lines' })
    ).toHaveAttribute('aria-pressed', 'true')
    await user.click(
      within(dialog).getByRole('button', { name: 'Close preview' })
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
  })
})
