import { Dialog } from '@base-ui/react/dialog'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CodeBlock } from '../vendor/zcode/conversation/code-block'
import { MessageResponse } from '../vendor/zcode/conversation/message-response'

describe('ChatGPT Markdown interactions', () => {
  test('assistant text uses a readable 16px scale without expanding the conversation width', () => {
    render(<MessageResponse>Readable assistant response.</MessageResponse>)

    const response = screen
      .getByText('Readable assistant response.')
      .closest('.zcode-markdown')
    expect(response).toHaveClass(
      'text-[16px]',
      'leading-[1.65]',
      'tracking-normal',
      'min-w-0',
      'max-w-full'
    )
  })

  test('code blocks expose a visible copy action and a keyboard-accessible scroll region', async () => {
    const user = userEvent.setup()
    const copy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    const source = `const message = "${'long source '.repeat(20)}"`
    render(
      <CodeBlock
        code={source}
        language='typescript'
        enableSyntaxHighlighting={false}
        theme='light'
      />
    )

    const copyButton = screen.getByRole('button', { name: 'Copy code' })
    expect(copyButton).toHaveTextContent('Copy code')
    const code = screen.getByRole('region', { name: 'Code' })
    expect(code).toHaveAttribute('tabindex', '0')
    expect(code).toHaveClass('overflow-x-auto', 'whitespace-pre')
    code.focus()
    expect(code).toHaveFocus()

    copyButton.focus()
    await user.keyboard('{Enter}')
    expect(copy).toHaveBeenCalledWith(source)
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveTextContent(
      'Copied'
    )
  })

  test.each([false, true])(
    'opening a modal hides background code actions from assistive technology when copied is %s',
    async (copyFirst) => {
      const user = userEvent.setup()
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
      render(
        <>
          <CodeBlock
            code='print("hello")'
            language='python'
            enableSyntaxHighlighting={false}
            theme='light'
          />
          <Dialog.Root>
            <Dialog.Trigger>Open navigation</Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop />
              <Dialog.Popup>
                <Dialog.Title>Navigation</Dialog.Title>
                <Dialog.Close>Close navigation</Dialog.Close>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )
      if (copyFirst) {
        await user.click(screen.getByRole('button', { name: 'Copy code' }))
        expect(screen.getByRole('button', { name: 'Copied' })).toBeVisible()
      }

      await user.click(screen.getByRole('button', { name: 'Open navigation' }))
      expect(
        await screen.findByRole('dialog', { name: 'Navigation' })
      ).toBeVisible()
      expect(
        screen.queryByRole('button', { name: /^(Copy code|Copied)$/ })
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Wrap code lines' })
      ).toBeNull()
    }
  )

  test('clipboard rejection shows the copy failure and leaves the source selectable', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('Clipboard permission denied')
    )
    render(
      <CodeBlock
        code='print("hello")'
        language='python'
        enableSyntaxHighlighting={false}
        theme='light'
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(screen.getByRole('status')).toHaveTextContent('Copy failed')
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeEnabled()
    expect(screen.getByRole('region', { name: 'Code' })).toHaveTextContent(
      'print("hello")'
    )
  })

  test('safe relative, fragment and email links remain actionable without opening internal links in a new tab', () => {
    const markdown =
      '[Settings](/console/settings?tab=general) [Section](#details) [Support](mailto:support@example.com)'
    render(<MessageResponse>{markdown}</MessageResponse>)

    const settings = screen.getByRole('link', { name: 'Settings' })
    expect(settings).toHaveAttribute('href', '/console/settings?tab=general')
    expect(settings).not.toHaveAttribute('target')
    expect(screen.getByRole('link', { name: 'Section' })).toHaveAttribute(
      'href',
      '#details'
    )
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute(
      'href',
      'mailto:support@example.com'
    )
  })

  test('executable URL schemes and embedded HTML cannot create active content', () => {
    const { container } = render(
      <MessageResponse>
        {
          '[Script](javascript:alert%281%29) [Inline](data:text/html;base64,PHNjcmlwdD4=) [Local](file:///etc/passwd)\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">'
        }
      </MessageResponse>
    )

    expect(screen.queryByRole('link')).toBeNull()
    expect(
      container.querySelector('script, iframe, object, [onerror]')
    ).toBeNull()
  })

  test('wide tables stay inside a keyboard-accessible horizontal scroll region', () => {
    render(
      <MessageResponse>
        {
          '| File | Description | Status |\n| --- | --- | --- |\n| src/very-long-file-name.tsx | A long description that must remain inside the conversation | Complete |'
        }
      </MessageResponse>
    )

    const region = screen.getByRole('region', { name: 'Markdown table' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveClass('max-w-full', 'min-w-0', 'overflow-x-auto')
    expect(within(region).getByRole('table')).toHaveTextContent(
      'src/very-long-file-name.tsx'
    )
    region.focus()
    expect(region).toHaveFocus()
  })
})
