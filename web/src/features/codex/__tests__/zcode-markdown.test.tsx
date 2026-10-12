import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { MessageResponse } from '../vendor/zcode/conversation/message-response'
import { buildCsvTableText } from '../vendor/zcode/conversation/table-export'

describe('ZCode Markdown rendering', () => {
  test('completed Chinese Markdown renders lists, table, math and literal shell values', () => {
    const { container } = render(
      <MessageResponse>
        {
          '# 实现说明\n\n- **第一项**\n  - 子项\n\n| 文件 | 状态 |\n| --- | --- |\n| src/main.ts | 完成 |\n\n公式 $x^2$。价格 $5-$10，变量 $HOME 与 $PATH。\n\n`./src/**/*`'
        }
      </MessageResponse>
    )
    expect(screen.getByRole('heading', { name: '实现说明' })).toBeVisible()
    expect(screen.getAllByRole('list')).toHaveLength(2)
    expect(screen.getByRole('table')).toHaveTextContent('src/main.ts')
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain(
      '价格 $5-$10，变量 $HOME 与 $PATH。'
    )
    expect(screen.getByText('./src/**/*')).toHaveProperty('tagName', 'CODE')
    expect(container.querySelector('[data-codex-markdown]')).toHaveAttribute(
      'data-streaming',
      'false'
    )
  })
  test('unfinished fenced output becomes highlighted static code when the stream completes', async () => {
    const { container, rerender } = render(
      <MessageResponse streaming>
        {'```typescript\nconst ready = '}
      </MessageResponse>
    )
    expect(container.querySelector('[data-codex-markdown]')).toHaveAttribute(
      'data-streaming',
      'true'
    )
    expect(container.textContent).toContain('const ready =')
    rerender(
      <MessageResponse>
        {'```typescript\nconst ready = true\n```'}
      </MessageResponse>
    )
    await waitFor(() =>
      expect(
        container.querySelector('.zcode-highlight .code-line')
      ).not.toBeNull()
    )
    expect(
      container.querySelector('[data-language="typescript"]')
    ).toHaveTextContent('const ready = true')
    expect(container.querySelector('[data-codex-markdown]')).toHaveAttribute(
      'data-streaming',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeEnabled()
  })
  test('code copy and wrapping operate on the exact source without Markdown fences', async () => {
    const user = userEvent.setup()
    const copy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    const code = `const long = "${'value'.repeat(40)}"`
    const { container } = render(
      <MessageResponse>{`\`\`\`typescript\n${code}\n\`\`\``}</MessageResponse>
    )
    const wrap = screen.getByRole('button', { name: 'Wrap code lines' })
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    await user.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    expect(container.querySelector('.zcode-highlight')).toHaveClass(
      'whitespace-pre-wrap'
    )
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(copy).toHaveBeenCalledWith(code)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible()
  })
  test('table copy retains Markdown columns and CSV neutralizes spreadsheet formulas', async () => {
    const user = userEvent.setup()
    const copy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    render(
      <MessageResponse>
        {'| 名称 | 内容 |\n| --- | --- |\n| 示例 | =1+1 |'}
      </MessageResponse>
    )
    await user.click(
      screen.getByRole('button', { name: 'Copy table as Markdown' })
    )
    expect(copy).toHaveBeenCalledWith(
      '| 名称 | 内容 |\n| --- | --- |\n| 示例 | =1+1 |'
    )
    expect(
      buildCsvTableText([
        ['名称', '内容'],
        ['示例', '=1+1'],
      ])
    ).toBe("\uFEFF名称,内容\r\n示例,'=1+1")
    expect(
      within(screen.getByRole('region', { name: 'Markdown table' })).getByRole(
        'table'
      )
    ).toBeVisible()
  })
  test('HTML and unsafe links remain non-executable while HTTPS links stay usable', () => {
    const { container } = render(
      <MessageResponse>
        {
          '[帮助](https://example.com/help)\n\n[危险](javascript:alert%281%29)\n\n<script>window.pwned = true</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src=x onerror=alert(1)>'
        }
      </MessageResponse>
    )
    const link = screen.getByRole('link', { name: '帮助' })
    expect(link).toHaveAttribute('href', 'https://example.com/help')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(container.querySelector('script, iframe, [onerror]')).toBeNull()
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
  })
})
