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
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { AsyncQuestionCard } from '../components/async-question-card'
import type { CodexItem } from '../types'

const question: CodexItem = {
  id: 'theme-question',
  type: 'agentMessage',
  delivery: 'async',
  questions: [{ title: 'Theme?', options: ['Light', 'Dark'] }],
}

const defaults = { replies: [], hasContinued: false }

describe('Asynchronous question answers', () => {
  test('typing an answer identical to an option keeps the written answer visible and submits it once', async () => {
    const user = userEvent.setup()
    const reply = vi.fn().mockResolvedValue(undefined)
    render(<AsyncQuestionCard {...defaults} item={question} onReply={reply} />)
    const answer = screen.getByRole('textbox', { name: 'Your answer: Theme?' })
    await user.type(answer, 'Dark')
    expect(answer).toHaveValue('Dark')
    expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked()
    await user.keyboard('[Enter]')
    expect(reply).toHaveBeenCalledWith('Theme?\nDark')
    expect(screen.getByText('Dark', { selector: 'dd' })).toBeVisible()
  })

  test('switching to a new question clears the previous answer and submitted state', async () => {
    const user = userEvent.setup()
    const reply = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <AsyncQuestionCard {...defaults} item={question} onReply={reply} />
    )
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    view.rerender(
      <AsyncQuestionCard
        {...defaults}
        item={{ ...question, id: 'new-question' }}
        onReply={reply}
      />
    )
    expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    expect(
      screen.queryByText('Dark', { selector: 'dd' })
    ).not.toBeInTheDocument()
  })

  test('a pending answer announces progress, prevents duplicates, and restores focus and values after rejection', async () => {
    const user = userEvent.setup()
    let rejectReply: ((reason: Error) => void) | undefined
    const reply = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectReply = reject
          })
      )
      .mockResolvedValueOnce(undefined)
    render(<AsyncQuestionCard {...defaults} item={question} onReply={reply} />)
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    const submit = screen.getByRole('button', { name: 'Submit answers' })
    await user.click(submit)
    expect(
      screen.getByRole('region', { name: 'Codex needs your input' })
    ).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Submitting...')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeDisabled()
    await user.click(submit)
    expect(reply).toHaveBeenCalledTimes(1)
    await act(async () => {
      rejectReply?.(new Error('Connection unavailable'))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Connection unavailable'
    )
    expect(submit).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await user.keyboard('[Enter]')
    expect(reply).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('Answers submitted')
  })

  test('a response from an older pending question does not resolve a newly selected question', async () => {
    const user = userEvent.setup()
    let resolveReply: (() => void) | undefined
    const reply = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve
        })
    )
    const view = render(
      <AsyncQuestionCard {...defaults} item={question} onReply={reply} />
    )
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    view.rerender(
      <AsyncQuestionCard
        {...defaults}
        item={{ ...question, id: 'next-question' }}
        onReply={reply}
      />
    )
    await act(async () => {
      resolveReply?.()
    })
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
  })

  test('Ctrl+Enter submits an option from the keyboard without moving focus to the submit button', async () => {
    const user = userEvent.setup()
    const reply = vi.fn().mockResolvedValue(undefined)
    render(<AsyncQuestionCard {...defaults} item={question} onReply={reply} />)
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus()
    await user.keyboard('[ArrowDown]')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await user.keyboard('{Control>}[Enter]{/Control}')
    expect(reply).toHaveBeenCalledWith('Theme?\nDark')
  })

  test('a continued conversation restores saved answers but removing that message hides its values', () => {
    const view = render(
      <AsyncQuestionCard
        item={question}
        onReply={vi.fn()}
        hasContinued
        replies={['Theme?\nDark']}
      />
    )
    expect(screen.getByText('Dark', { selector: 'dd' })).toBeVisible()
    view.rerender(
      <AsyncQuestionCard
        item={question}
        onReply={vi.fn()}
        hasContinued
        replies={[]}
      />
    )
    expect(
      screen.queryByText('Dark', { selector: 'dd' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Submit answers' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'This conversation has continued. Send a new message to update your answers.'
      )
    ).toBeVisible()
  })

  test('a malformed question cannot be silently omitted from the submitted reply', async () => {
    const user = userEvent.setup()
    const reply = vi.fn()
    render(
      <AsyncQuestionCard
        {...defaults}
        item={{
          ...question,
          questions: [{ title: 'Theme?', options: ['Dark'] }, { title: '' }],
        }}
        onReply={reply}
      />
    )
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(
      screen.getByRole('button', { name: 'Submit answers' })
    ).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Some questions could not be displayed. Ask Codex to send them again.'
    )
    expect(reply).not.toHaveBeenCalled()
  })
})
