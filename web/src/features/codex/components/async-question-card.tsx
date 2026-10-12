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
import { Check, HelpCircle, LoaderCircle } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { codexError } from '../api'
import type { CodexItem } from '../types'
import { Button } from '../vendor/zcode/button'

interface AsyncQuestion {
  title: string
  options: string[]
}

interface AsyncQuestionCardProps {
  item: CodexItem
  replies: string[]
  hasContinued: boolean
  disabled?: boolean
  onReply?: (prompt: string) => Promise<void>
}

interface AsyncAnswer {
  option: string | null
  text: string
}

function AsyncQuestionRequest(props: AsyncQuestionCardProps) {
  const { t } = useTranslation()
  const id = useId()
  const errorId = useId()
  const progressId = useId()
  const locked = useRef(false)
  const mounted = useRef(true)
  const submitButton = useRef<HTMLButtonElement>(null)
  const [answers, setAnswers] = useState<Record<string, AsyncAnswer>>({})
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(
    null
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (error && !pending) submitButton.current?.focus()
  }, [error, pending])
  const questions = useMemo(() => {
    const result: AsyncQuestion[] = []
    if (!Array.isArray(props.item.questions)) return result
    for (const question of props.item.questions) {
      if (
        !question ||
        typeof question !== 'object' ||
        typeof question.title !== 'string' ||
        !question.title.trim()
      ) {
        continue
      }
      const options: string[] = []
      if (Array.isArray(question.options)) {
        for (const option of question.options) {
          if (
            typeof option === 'string' &&
            option.trim() &&
            !options.includes(option)
          ) {
            options.push(option)
          }
        }
      }
      if (!result.some((entry) => entry.title === question.title)) {
        result.push({ title: question.title, options: [...new Set(options)] })
      }
    }
    return result
  }, [props.item.questions])
  const persisted = useMemo(() => {
    for (const reply of props.replies) {
      const values: Record<string, string> = {}
      let cursor = 0
      for (let index = 0; index < questions.length; index++) {
        const question = questions[index]
        const marker = `${question.title}\n`
        if (!reply.startsWith(marker, cursor)) break
        const start = cursor + marker.length
        const next = questions[index + 1]
        const end = next
          ? reply.indexOf(`\n\n${next.title}\n`, start)
          : reply.length
        if (end <= start) break
        values[question.title] = reply.slice(start, end)
        cursor = next ? end + 2 : end
      }
      if (
        questions.length > 0 &&
        Object.keys(values).length === questions.length &&
        cursor === reply.length
      ) {
        return values
      }
    }
    return null
  }, [props.replies, questions])
  if (!questions.length) return null
  const invalidQuestions =
    Array.isArray(props.item.questions) &&
    questions.length !== props.item.questions.length
  const savedAnswers = props.hasContinued ? persisted : submitted
  const continued = props.hasContinued && !savedAnswers
  const disabled =
    props.disabled || pending || !props.onReply || continued || !!savedAnswers
  const answeredCount = questions.filter((question) => {
    const answer = answers[question.title]
    const value = (answer?.option ?? answer?.text ?? '').trim()
    return value.length > 0 && value.length <= 10_000
  }).length
  const complete = !invalidQuestions && answeredCount === questions.length

  async function submit(): Promise<void> {
    if (locked.current || disabled || !complete || !props.onReply) return
    locked.current = true
    setPending(true)
    setError('')
    const values = Object.fromEntries(
      questions.map((question) => [
        question.title,
        (answers[question.title].option ?? answers[question.title].text).trim(),
      ])
    )
    const prompt = questions
      .map((question) => `${question.title}\n${values[question.title]}`)
      .join('\n\n')
    try {
      await props.onReply(prompt)
      if (mounted.current) setSubmitted(values)
    } catch (cause) {
      if (mounted.current) setError(codexError(cause))
    } finally {
      if (mounted.current) {
        locked.current = false
        setPending(false)
      }
    }
  }

  return (
    <section
      className='border-border bg-background text-foreground mt-4 w-full min-w-0 overflow-hidden rounded-2xl border shadow-sm'
      aria-label={t('Codex needs your input')}
      aria-busy={pending}
      aria-describedby={error ? errorId : undefined}
    >
      <header className='border-border bg-muted/20 flex items-start gap-3 border-b p-4 sm:px-5'>
        <span className='border-border bg-background mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border'>
          <HelpCircle className='size-4' aria-hidden />
        </span>
        <div className='min-w-0'>
          <h3 className='text-sm leading-6 font-medium'>
            {t('Codex needs your input')}
          </h3>
          <p className='text-muted-foreground mt-0.5 text-xs leading-5'>
            {t('Answer these questions to continue the task.')}
          </p>
        </div>
      </header>
      {savedAnswers ? (
        <div className='space-y-4 p-4 sm:p-5'>
          <p
            role='status'
            className='text-muted-foreground flex items-center gap-2 text-sm'
          >
            <Check className='size-4' aria-hidden />
            {t('Answers submitted')}
          </p>
          <dl className='space-y-4 text-sm'>
            {questions.map((question) => (
              <div key={question.title} className='min-w-0'>
                <dt className='text-muted-foreground mb-1 leading-5 break-words'>
                  {question.title}
                </dt>
                <dd className='leading-6 break-words whitespace-pre-wrap'>
                  {savedAnswers[question.title]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <form
          className='space-y-5 p-4 sm:p-5'
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            if (event.nativeEvent.isComposing) {
              event.preventDefault()
              return
            }
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault()
              event.stopPropagation()
              if (complete && !disabled) event.currentTarget.requestSubmit()
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {invalidQuestions && (
            <p role='alert' className='text-destructive text-sm leading-6'>
              {t(
                'Some questions could not be displayed. Ask Codex to send them again.'
              )}
            </p>
          )}
          {questions.map((question, index) => (
            <fieldset
              key={question.title}
              disabled={disabled}
              className='min-w-0 space-y-2'
            >
              <legend className='mb-2 w-full text-sm leading-6 font-medium break-words'>
                {question.title}
              </legend>
              {question.options.map((option) => (
                <label
                  key={option}
                  className='border-border hover:bg-muted/50 has-checked:border-foreground/35 has-checked:bg-muted/60 has-focus-visible:ring-foreground/30 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors has-focus-visible:ring-2 has-disabled:cursor-default has-disabled:opacity-60'
                >
                  <input
                    type='radio'
                    name={`${id}-${index}`}
                    checked={answers[question.title]?.option === option}
                    onChange={() =>
                      setAnswers((previous) => ({
                        ...previous,
                        [question.title]: { option, text: '' },
                      }))
                    }
                    className='accent-foreground mt-0.5 size-4 shrink-0'
                  />
                  <span className='min-w-0 leading-5 break-words'>
                    {option}
                  </span>
                </label>
              ))}
              <label className='block space-y-2 pt-1'>
                <span className='text-muted-foreground text-xs'>
                  {question.options.length
                    ? t('Or write your own answer')
                    : t('Your answer')}
                </span>
                <input
                  aria-label={t('Your answer: {{question}}', {
                    question: question.title,
                  })}
                  placeholder={t('Write an answer')}
                  value={answers[question.title]?.text ?? ''}
                  onChange={(event) =>
                    setAnswers((previous) => ({
                      ...previous,
                      [question.title]: {
                        option: null,
                        text: event.target.value,
                      },
                    }))
                  }
                  maxLength={10_000}
                  autoComplete='off'
                  className='border-border bg-background focus-visible:ring-ring placeholder:text-muted-foreground w-full rounded-xl border px-3 py-2.5 text-base outline-none focus-visible:ring-2 disabled:opacity-60 sm:text-sm'
                />
              </label>
            </fieldset>
          ))}
          {continued ? (
            <p className='text-muted-foreground text-xs leading-5'>
              {t(
                'This conversation has continued. Send a new message to update your answers.'
              )}
            </p>
          ) : (
            <div className='border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4'>
              <div className='min-w-0 space-y-1'>
                {pending ? (
                  <p
                    role='status'
                    className='text-muted-foreground flex items-center gap-1.5 text-xs'
                  >
                    <LoaderCircle
                      className='size-3.5 animate-spin motion-reduce:animate-none'
                      aria-hidden
                    />
                    {t('Submitting...')}
                  </p>
                ) : (
                  <p
                    id={progressId}
                    aria-live='polite'
                    className='text-muted-foreground text-xs'
                  >
                    {t('{{answered}} of {{total}} answered', {
                      answered: answeredCount,
                      total: questions.length,
                    })}
                  </p>
                )}
                <p className='text-muted-foreground hidden text-[11px] sm:block'>
                  {t('Press Ctrl or ⌘ + Enter to submit')}
                </p>
              </div>
              <Button
                ref={submitButton}
                type='submit'
                disabled={disabled || !complete}
                aria-describedby={!pending ? progressId : undefined}
                aria-keyshortcuts='Control+Enter Meta+Enter'
                className='bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-foreground/30 h-9 rounded-full px-4 text-sm focus-visible:ring-2 focus-visible:ring-offset-2'
              >
                {t('Submit answers')}
              </Button>
            </div>
          )}
          {error && (
            <p
              id={errorId}
              role='alert'
              className='text-destructive text-sm leading-6 break-words'
            >
              {t(error)}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

export function AsyncQuestionCard(props: AsyncQuestionCardProps) {
  return <AsyncQuestionRequest key={props.item.id} {...props} />
}
