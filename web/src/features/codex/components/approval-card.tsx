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
import { ChevronRight, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { codexError } from '../api'
import type { CodexApproval, CodexApprovalAnswer } from '../types'

interface ApprovalQuestion {
  id: string
  header?: string
  question: string
  isSecret?: boolean
  options?: { label: string; description?: string }[]
}
export function ApprovalCard(props: {
  approval: CodexApproval
  onApprove: (id: string, answer: CodexApprovalAnswer) => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const locked = useRef(false)
  const input = props.approval.method === 'item/tool/requestUserInput'
  const elicitation = props.approval.method
    .toLowerCase()
    .includes('elicitation')
  const params = props.approval.params
  let command = ''
  if (typeof params.command === 'string') {
    command = params.command
  } else if (Array.isArray(params.command)) {
    command = params.command
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
  }
  const reason = [params.reason, params.message].find(
    (value): value is string => typeof value === 'string' && !!value.trim()
  )
  const cwd = typeof params.cwd === 'string' ? params.cwd : ''
  const permissions =
    params.permissions && typeof params.permissions === 'object'
      ? (params.permissions as Record<string, unknown>)
      : null
  const fileSystem =
    permissions?.fileSystem && typeof permissions.fileSystem === 'object'
      ? (permissions.fileSystem as Record<string, unknown>)
      : null
  const permissionGroups = (['read', 'write'] as const)
    .map((kind) => ({
      kind,
      paths: Array.isArray(fileSystem?.[kind])
        ? (fileSystem[kind] as unknown[]).filter(
            (value): value is string => typeof value === 'string'
          )
        : [],
    }))
    .filter((entry) => entry.paths.length)
  const questions = (
    Array.isArray(props.approval.params.questions)
      ? props.approval.params.questions
      : []
  ) as ApprovalQuestion[]
  const complete =
    questions.length > 0 &&
    questions.every((question) => !!answers[question.id]?.trim())
  async function decide(answer: CodexApprovalAnswer) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await props.onApprove(props.approval.id, answer)
    } catch (cause) {
      setError(codexError(cause))
      setBusy(false)
      locked.current = false
    }
  }
  return (
    <section
      className='min-w-0 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:p-5'
      aria-label={input ? t('Codex needs your input') : t('Approval required')}
    >
      <h3 className='flex items-center gap-2 text-sm font-medium'>
        <ShieldCheck className='size-4 text-amber-600' />
        {input ? t('Codex needs your input') : t('Approval required')}
      </h3>
      <p className='text-muted-foreground mt-2 text-sm leading-6'>
        {input
          ? t('Answer these questions to continue the task.')
          : t('Review this action before allowing Codex to continue.')}
      </p>
      {input ? (
        <form
          className='mt-4 space-y-4'
          onSubmit={(event) => {
            event.preventDefault()
            if (complete) {
              void decide({
                answers: Object.fromEntries(
                  questions.map((question) => [
                    question.id,
                    { answers: [answers[question.id].trim()] },
                  ])
                ),
              })
            }
          }}
        >
          {questions.map((question) => (
            <fieldset key={question.id} className='space-y-2' disabled={busy}>
              <legend className='mb-2 text-sm'>{question.question}</legend>
              {question.options?.map((option) => (
                <label
                  key={option.label}
                  className='bg-background hover:bg-muted/50 has-checked:border-foreground/40 flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm'
                >
                  <input
                    type='radio'
                    aria-label={option.label}
                    name={`${props.approval.id}-${question.id}`}
                    className='mt-0.5'
                    checked={answers[question.id] === option.label}
                    onChange={() =>
                      setAnswers((previous) => ({
                        ...previous,
                        [question.id]: option.label,
                      }))
                    }
                  />
                  <span>
                    <span className='font-medium'>{option.label}</span>
                    {option.description && (
                      <span className='text-muted-foreground mt-1 block'>
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <input
                type={question.isSecret ? 'password' : 'text'}
                aria-label={t('Your answer: {{question}}', {
                  question: question.question,
                })}
                placeholder={t('Write an answer')}
                className='bg-background focus-visible:ring-ring w-full rounded-lg border p-3 text-base outline-none focus-visible:ring-2 sm:text-sm'
                autoComplete='off'
                value={answers[question.id] ?? ''}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [question.id]: event.target.value,
                  }))
                }
              />
            </fieldset>
          ))}
          <Button type='submit' size='sm' disabled={busy || !complete}>
            {busy && <LoaderCircle className='size-4 animate-spin' />}
            {t('Submit answers')}
          </Button>
        </form>
      ) : (
        <>
          {reason && (
            <p className='mt-3 text-sm leading-6 break-words'>{reason}</p>
          )}
          {command && (
            <div className='bg-background mt-3 min-w-0 overflow-hidden rounded-lg border'>
              <div className='text-muted-foreground border-b px-3 py-2 text-xs font-medium'>
                {t('Command to run')}
              </div>
              <pre className='max-h-48 overflow-auto p-3 font-mono text-xs leading-6 break-all whitespace-pre-wrap'>
                {command}
              </pre>
            </div>
          )}
          {cwd && (
            <p className='text-muted-foreground mt-2 min-w-0 text-xs leading-5 break-all'>
              {t('Working directory')}: <span className='font-mono'>{cwd}</span>
            </p>
          )}
          {permissionGroups.map((entry) => (
            <div key={entry.kind} className='mt-3'>
              <p className='text-sm font-medium'>
                {t(entry.kind === 'write' ? 'Write access' : 'Read access')}
              </p>
              <ul className='mt-1 space-y-1 font-mono text-xs leading-5 break-all'>
                {entry.paths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </div>
          ))}
          <details className='group mt-3 min-w-0'>
            <summary className='text-muted-foreground hover:text-foreground focus-visible:ring-ring flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden'>
              <ChevronRight className='size-3.5 transition-transform group-open:rotate-90' />
              {t('Request details')}
            </summary>
            <pre className='bg-background mt-1 max-h-64 overflow-auto rounded-lg border p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap'>
              {JSON.stringify(props.approval.params, null, 2)}
            </pre>
          </details>
          {elicitation && (
            <p className='text-muted-foreground mt-2 text-sm leading-6'>
              {t(
                'External tool forms are not supported here. Decline to continue safely.'
              )}
            </p>
          )}
          <div className='mt-3 flex gap-2'>
            {!elicitation && (
              <Button
                type='button'
                size='sm'
                disabled={busy}
                onClick={() => void decide({ decision: 'accept' })}
              >
                {busy && <LoaderCircle className='size-4 animate-spin' />}
                {t('Allow once')}
              </Button>
            )}
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() => void decide({ decision: 'decline' })}
            >
              {t('Decline')}
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role='alert' className='text-destructive mt-3 text-sm leading-6'>
          {t(error)}
        </p>
      )}
    </section>
  )
}
