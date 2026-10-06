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
import { describe, expect, it } from 'vitest'

import { Response } from '../response'
import { renderMathBlock, renderMathInline } from '../response-renderer-blocks'

describe('response formula rendering', () => {
  it.each([
    ['dollar inline', '$x^2$', false],
    ['TeX inline', String.raw`\(x^2\)`, false],
    ['dollar display', '$$x^2$$', true],
    ['TeX display', String.raw`\[x^2\]`, true],
  ])('renders %s as accessible math', (_name, source, display) => {
    const { container } = render(<Response final>{source}</Response>)
    expect(container.querySelector('math')).not.toBeNull()
    expect(
      container.querySelector('annotation[encoding="application/x-tex"]')
    ).toHaveTextContent('x^2')
    expect(Boolean(container.querySelector('.katex-display'))).toBe(display)
  })

  it('keeps incomplete formulas readable and renders the completed streamed expression', () => {
    const source = String.raw`The result is $\frac{1}{`
    const { container, rerender } = render(
      <Response final={false}>{source}</Response>
    )
    expect(container.querySelector('math')).toBeNull()
    expect(container.textContent).toContain(String.raw`\frac{1}{`)
    rerender(<Response final>{source}</Response>)
    expect(container.textContent).toBe(source)
    expect(container.querySelector('math')).toBeNull()
    rerender(
      <Response final>{String.raw`The result is $\frac{1}{2}$.`}</Response>
    )
    expect(container.querySelector('mfrac')).not.toBeNull()
    expect(container.textContent).toContain('The result is')
  })

  it('keeps code fences and inline code literal even when they contain formula delimiters', () => {
    const source = [
      'Inline `$x^2$` and `\\(x^2\\)`.',
      '',
      '```latex',
      '$$\\frac{1}{2}$$',
      '```',
    ].join('\n')
    const { container } = render(<Response final>{source}</Response>)
    expect(container.querySelector('math')).toBeNull()
    expect(container.textContent).toContain('$x^2$')
    expect(container.textContent).toContain(String.raw`$$\frac{1}{2}$$`)
  })

  it('preserves currency and ordinary bracket text without math interpretation', () => {
    const { container } = render(
      <Response final>
        {'Price $5 and $10. Price $5–$10. Price $5,$10.\n\n[x^2]'}
      </Response>
    )
    expect(container.querySelector('math')).toBeNull()
    expect(container.textContent).toContain('Price $5 and $10.')
    expect(container.textContent).toContain('Price $5–$10. Price $5,$10.')
    expect(container.textContent).toContain('[x^2]')
  })

  it('shows an invalid formula verbatim without losing the rest of the answer', () => {
    const raw = String.raw`$\notARealCommand{x}$`
    render(
      <div>
        <p>Before</p>
        {renderMathInline(
          {
            type: 'math_inline',
            raw,
            content: String.raw`\notARealCommand{x}`,
            markup: '$',
          },
          'invalid'
        )}
        <p>After</p>
      </div>
    )
    expect(screen.getByText(raw)).toBeVisible()
    expect(screen.getByText('Before')).toBeVisible()
    expect(screen.getByText('After')).toBeVisible()
    expect(document.querySelector('math')).toBeNull()
  })

  it('does not allow formula commands to create links, images or executable markup', () => {
    const formulas = [
      String.raw`\href{javascript:alert(1)}{click}`,
      String.raw`\includegraphics{https://example.invalid/tracker}`,
      String.raw`\htmlClass{unsafe}{x}`,
      String.raw`\text{<img src=x onerror=alert(1)>}`,
    ]
    const { container } = render(
      <div>
        {formulas.map((content) =>
          renderMathInline(
            { type: 'math_inline', raw: `$${content}$`, content, markup: '$' },
            content
          )
        )}
      </div>
    )
    expect(
      container.querySelector(
        'a,img,script,iframe,object,embed,[onerror],.unsafe'
      )
    ).toBeNull()
    expect(container.textContent).toContain('click')
  })

  it('bounds recursive macro expansion and isolates definitions between formulas', () => {
    const bad = String.raw`\def\loop{\loop}\loop`
    const define = String.raw`\gdef\private{x}\private`
    const use = String.raw`\private`
    const { container } = render(
      <div>
        {[bad, define, use].map((content) =>
          renderMathInline(
            { type: 'math_inline', raw: `$${content}$`, content, markup: '$' },
            content
          )
        )}
      </div>
    )
    expect(screen.getByText(`$${bad}$`)).toBeVisible()
    expect(screen.getByText(`$${use}$`)).toBeVisible()
    expect(container.querySelectorAll('math')).toHaveLength(1)
  })

  it('contains wide display formulas in a horizontally scrollable block', () => {
    const content = String.raw`\frac{a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p}{q}`
    const { container } = render(
      <>
        {renderMathBlock(
          { type: 'math_block', raw: `$$${content}$$`, content, markup: '$$' },
          'wide'
        )}
      </>
    )
    const formula = container.querySelector('math')
    expect(formula).not.toBeNull()
    const scrollContainer = container.firstElementChild
    expect(scrollContainer).toHaveClass('max-w-full', 'overflow-x-auto')
  })
  it('retains the whole source when a single formula exceeds the rendering budget', () => {
    const content = `${'x+'.repeat(10_001)}1`
    const raw = `$$${content}$$`
    const { container } = render(
      <>
        {renderMathBlock(
          { type: 'math_block', raw, content, markup: '$$' },
          'large'
        )}
      </>
    )
    expect(container.querySelector('math')).toBeNull()
    expect(container.textContent).toBe(raw)
  })

  it('does not display a synthetic closing delimiter on a loading math node', () => {
    const content = String.raw`\frac{1}{`
    const { container } = render(
      <>
        {renderMathInline(
          {
            type: 'math_inline',
            raw: `$${content}$`,
            content,
            markup: '$',
            loading: true,
          },
          'loading'
        )}
      </>
    )
    expect(container.querySelector('math')).toBeNull()
    expect(container.textContent).toBe(`$${content}`)
  })
  it('preserves the inequality exclamation mark in the accessible math source', () => {
    const { container } = render(<Response final>$a != b$</Response>)
    expect(container.querySelector('annotation')).toHaveTextContent('a != b')
  })

  it('renders multi-line display math with aligned rows', () => {
    const source = String.raw`\[
\begin{aligned}
a &= b \\
c &= d
\end{aligned}
\]`
    const { container } = render(<Response final>{source}</Response>)
    expect(container.querySelector('math')).not.toBeNull()
    expect(container.querySelector('mtable')).not.toBeNull()
  })
})
