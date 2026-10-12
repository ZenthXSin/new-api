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
import {
  Check,
  ChevronRight,
  FilePenLine,
  Globe2,
  HelpCircle,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Permission surface and answer rows adapted from ZCode PermissionDialog.tsx.
// See ../vendor/zcode/conversation/CONVERSATION-PROVENANCE.md.
import { codexError } from '../api'
import type { CodexApproval, CodexApprovalAnswer, CodexItem } from '../types'
import { Button } from '../vendor/zcode/button'

interface ApprovalQuestion {
  id: string
  header?: string
  question: string
  isSecret?: boolean
  isOther?: boolean
  multiSelect?: boolean
  options?: { label: string; description?: string }[]
}

interface QuestionAnswer {
  selected: string[]
  text: string
}

interface ApprovalCardProps {
  approval: CodexApproval
  item?: CodexItem
  onApprove: (id: string, answer: CodexApprovalAnswer) => Promise<void>
}

function parseApprovalQuestions(value: unknown): ApprovalQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: ApprovalQuestion[] = []
  for (const question of value) {
    if (!question || typeof question !== 'object') continue
    if (typeof question.id !== 'string' || !question.id.trim()) continue
    if (typeof question.question !== 'string' || !question.question.trim()) {
      continue
    }
    if (questions.some((entry) => entry.id === question.id)) continue
    const options: NonNullable<ApprovalQuestion['options']> = []
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        if (
          !option ||
          typeof option !== 'object' ||
          typeof option.label !== 'string' ||
          !option.label.trim()
        ) {
          continue
        }
        if (options.some((entry) => entry.label === option.label)) continue
        options.push({
          label: option.label,
          description:
            typeof option.description === 'string'
              ? option.description
              : undefined,
        })
      }
    }
    questions.push({
      id: question.id,
      question: question.question,
      header: typeof question.header === 'string' ? question.header : undefined,
      isSecret: question.isSecret === true,
      isOther: question.isOther !== false,
      multiSelect: question.multiSelect === true,
      options,
    })
  }
  return questions
}

function ApprovalQuestionField(props: {
  approvalId: string
  question: ApprovalQuestion
  answer: QuestionAnswer
  disabled: boolean
  onChange: (answer: QuestionAnswer) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const question = props.question
  const customAnswer = question.isSecret
    ? props.answer.text
    : props.answer.text.trim()
  const answerCount = new Set([
    ...props.answer.selected,
    ...(customAnswer ? [customAnswer] : []),
  ]).size
  const overLimit = answerCount > 20
  return (
    <fieldset className='min-w-0 space-y-2' disabled={props.disabled}>
      <legend className='mb-2 w-full text-sm leading-6 font-medium break-words'>
        {question.header && (
          <span className='text-muted-foreground mb-1 block text-xs font-normal'>
            {question.header}
          </span>
        )}
        {question.question}
      </legend>
      {question.multiSelect && (
        <p className='text-muted-foreground text-xs'>
          {t('Select all that apply')}
        </p>
      )}
      {question.options?.map((option, index) => {
        const checked = props.answer.selected.includes(option.label)
        return (
          <label
            key={option.label}
            className='border-border hover:bg-muted/50 has-checked:border-foreground/35 has-checked:bg-muted/60 has-focus-visible:ring-foreground/30 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors has-focus-visible:ring-2 has-disabled:cursor-default has-disabled:opacity-60'
          >
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              aria-label={option.label}
              aria-describedby={
                option.description ? `${id}-${index}` : undefined
              }
              name={`${props.approvalId}-${question.id}`}
              className='accent-foreground mt-0.5 size-4 shrink-0'
              checked={checked}
              disabled={!checked && !!question.multiSelect && answerCount >= 20}
              onChange={() => {
                let selected = [option.label]
                if (question.multiSelect) {
                  selected = checked
                    ? props.answer.selected.filter(
                        (value) => value !== option.label
                      )
                    : [...props.answer.selected, option.label]
                }
                props.onChange({
                  selected,
                  text: question.multiSelect ? props.answer.text : '',
                })
              }}
            />
            <span className='min-w-0 text-sm leading-5 break-words'>
              <span>{option.label}</span>
              {option.description && (
                <span
                  id={`${id}-${index}`}
                  className='text-muted-foreground mt-0.5 block text-xs leading-5'
                >
                  {option.description}
                </span>
              )}
            </span>
          </label>
        )
      })}
      {(question.isOther || !question.options?.length) && (
        <label className='block space-y-2 pt-1'>
          <span className='text-muted-foreground text-xs'>
            {question.options?.length
              ? t('Or write your own answer')
              : t('Your answer')}
          </span>
          <input
            type={question.isSecret ? 'password' : 'text'}
            aria-label={t('Your answer: {{question}}', {
              question: question.question,
            })}
            aria-invalid={overLimit || undefined}
            aria-describedby={overLimit ? `${id}-limit` : undefined}
            placeholder={t('Write an answer')}
            className='border-border bg-background focus-visible:border-ring focus-visible:ring-ring placeholder:text-muted-foreground w-full rounded-xl border px-3 py-2.5 text-base transition-colors outline-none focus-visible:ring-2 disabled:opacity-60 sm:text-sm'
            autoComplete='off'
            spellCheck={!question.isSecret}
            maxLength={10_000}
            value={props.answer.text}
            onChange={(event) =>
              props.onChange({
                selected: question.multiSelect ? props.answer.selected : [],
                text: event.target.value,
              })
            }
          />
        </label>
      )}
      {overLimit && (
        <p id={`${id}-limit`} className='text-destructive text-xs'>
          {t('Choose up to 20 answers.')}
        </p>
      )}
    </fieldset>
  )
}

function ApprovalPermissions(props: {
  permissions: unknown
  networkContext: unknown
  scopedToTurn: boolean
}) {
  const { t } = useTranslation()
  const permissions =
    props.permissions && typeof props.permissions === 'object'
      ? (props.permissions as Record<string, unknown>)
      : null
  const fileSystem =
    permissions?.fileSystem && typeof permissions.fileSystem === 'object'
      ? (permissions.fileSystem as Record<string, unknown>)
      : null
  const groups: Record<'read' | 'write' | 'deny', Set<string>> = {
    read: new Set(),
    write: new Set(),
    deny: new Set(),
  }
  for (const kind of ['read', 'write'] as const) {
    const values = fileSystem?.[kind]
    if (!Array.isArray(values)) continue
    for (const path of values) {
      if (typeof path === 'string' && path.trim()) groups[kind].add(path)
    }
  }
  if (Array.isArray(fileSystem?.entries)) {
    for (const entry of fileSystem.entries) {
      if (!entry || typeof entry !== 'object') continue
      if (
        entry.access !== 'read' &&
        entry.access !== 'write' &&
        entry.access !== 'deny'
      ) {
        continue
      }
      const path = entry.path
      if (!path || typeof path !== 'object') continue
      let label = ''
      if (path.type === 'path' && typeof path.path === 'string') {
        label = path.path
      } else if (
        path.type === 'glob_pattern' &&
        typeof path.pattern === 'string'
      ) {
        label = t('Pattern: {{pattern}}', {
          pattern: path.pattern,
          interpolation: { escapeValue: false },
        })
      } else if (
        path.type === 'special' &&
        path.value &&
        typeof path.value === 'object'
      ) {
        switch (path.value.kind) {
          case 'root':
            label = t('All files')
            break
          case 'minimal':
            label = t('Basic system files')
            break
          case 'project_roots':
            label = t('Project files')
            break
          case 'tmpdir':
            label = t('Temporary directory')
            break
          case 'slash_tmp':
            label = '/tmp'
            break
          case 'unknown':
            if (typeof path.value.path === 'string') label = path.value.path
            break
        }
        if (
          label &&
          typeof path.value.subpath === 'string' &&
          path.value.subpath
        ) {
          label += ` / ${path.value.subpath}`
        }
      }
      if (label) groups[entry.access as keyof typeof groups].add(label)
    }
  }
  const context =
    props.networkContext && typeof props.networkContext === 'object'
      ? (props.networkContext as Record<string, unknown>)
      : null
  const network = permissions?.network
  const networkAccess =
    network === true ||
    (network &&
      typeof network === 'object' &&
      'enabled' in network &&
      network.enabled === true)
  const host = typeof context?.host === 'string' ? context.host : ''
  const protocol = typeof context?.protocol === 'string' ? context.protocol : ''
  return (
    <div className='space-y-2'>
      {(['read', 'write', 'deny'] as const).map((kind) => {
        const paths = [...groups[kind]]
        if (!paths.length) return null
        let label = t('Read access')
        if (kind === 'write') label = t('Write access')
        else if (kind === 'deny') label = t('Blocked paths')
        return (
          <details
            key={kind}
            className='group border-border min-w-0 rounded-xl border'
          >
            <summary className='focus-visible:ring-foreground/25 flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-xs outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden'>
              <ChevronRight
                className='text-muted-foreground size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none'
                aria-hidden
              />
              <span>{label}</span>
              <span className='text-muted-foreground ml-auto tabular-nums'>
                {paths.length}
              </span>
            </summary>
            <ul className='border-border max-h-48 space-y-1 overflow-auto border-t p-3 font-mono text-xs leading-5 break-all'>
              {paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </details>
        )
      })}
      {(networkAccess || host) && (
        <div className='border-border flex min-w-0 items-start gap-2.5 rounded-xl border px-3 py-3 text-xs'>
          <Globe2
            className='text-muted-foreground mt-0.5 size-4 shrink-0'
            aria-hidden
          />
          <div className='min-w-0 space-y-1'>
            <p className='font-medium'>{t('Network access')}</p>
            {host && <p className='font-mono leading-5 break-all'>{host}</p>}
            {protocol && <p className='text-muted-foreground'>{protocol}</p>}
          </div>
        </div>
      )}
      {props.scopedToTurn && (
        <p className='text-muted-foreground text-xs leading-5'>
          {t('Access is limited to this turn.')}
        </p>
      )}
    </div>
  )
}

function ApprovalFileChanges(props: { item?: CodexItem }) {
  const { t } = useTranslation()
  const changes =
    props.item?.type === 'fileChange' && Array.isArray(props.item.changes)
      ? props.item.changes.filter(
          (change) =>
            change && typeof change.path === 'string' && change.path.trim()
        )
      : []
  if (!changes.length) {
    return (
      <p className='text-muted-foreground text-xs leading-5'>
        {t(
          'File changes are not available yet. Review the request details before deciding.'
        )}
      </p>
    )
  }
  return (
    <div className='space-y-2'>
      <h4 className='text-muted-foreground text-xs font-medium'>
        {t('Files to change')}
      </h4>
      {changes.map((change) => {
        const kind =
          typeof change.kind === 'string' ? change.kind : change.kind?.type
        const details =
          change.kind && typeof change.kind === 'object'
            ? (change.kind as Record<string, unknown>)
            : null
        const destination =
          typeof details?.move_path === 'string' ? details.move_path : ''
        let label = t('Modified')
        if (kind === 'add') label = t('Added')
        else if (kind === 'delete') label = t('Deleted')
        else if (destination) label = t('Renamed')
        return (
          <details
            key={change.path}
            className='group border-border min-w-0 rounded-xl border'
          >
            <summary className='focus-visible:ring-foreground/25 flex min-h-11 cursor-pointer list-none items-start gap-2 rounded-xl px-3 py-3 text-xs outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden'>
              <ChevronRight
                className='text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none'
                aria-hidden
              />
              <FilePenLine
                className='text-muted-foreground mt-0.5 size-3.5 shrink-0'
                aria-hidden
              />
              <span className='min-w-0 flex-1 font-mono leading-5 break-all'>
                {change.path}
              </span>
              <span className='text-muted-foreground shrink-0 leading-5'>
                {label}
              </span>
            </summary>
            <div className='border-border border-t'>
              {destination && (
                <p className='text-muted-foreground px-3 pt-3 text-xs leading-5 break-all'>
                  {t('Moved to')}:{' '}
                  <span className='font-mono'>{destination}</span>
                </p>
              )}
              {typeof change.diff === 'string' && change.diff ? (
                <pre className='bg-muted/30 max-h-72 overflow-auto rounded-b-xl p-3 font-mono text-xs leading-6 break-all whitespace-pre-wrap'>
                  {change.diff}
                </pre>
              ) : (
                <p className='text-muted-foreground p-3 text-xs leading-5'>
                  {t('No patch preview is available for this file.')}
                </p>
              )}
            </div>
          </details>
        )
      })}
    </div>
  )
}

function ApprovalRequest(props: ApprovalCardProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [resolved, setResolved] = useState<
    'accept' | 'decline' | 'answered' | null
  >(null)
  const [error, setError] = useState('')
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({})
  const locked = useRef(false)
  const mounted = useRef(true)
  const action = useRef<HTMLElement | null>(null)
  const errorId = useId()
  const progressId = useId()
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (error && action.current?.isConnected) action.current.focus()
  }, [error])

  const input = props.approval.method === 'item/tool/requestUserInput'
  const commandRequest =
    props.approval.method === 'item/commandExecution/requestApproval'
  const portRequest = props.approval.method === 'workbench/ports/approval'
  const accountRequest =
    props.approval.method === 'workbench/newapi/approval' || portRequest
  const fileRequest =
    props.approval.method === 'item/fileChange/requestApproval'
  const elicitation = props.approval.method
    .toLowerCase()
    .includes('elicitation')
  const permissionRequest =
    props.approval.method === 'item/permissions/requestApproval'
  const params = props.approval.params
  const item =
    props.item &&
    (typeof params.itemId !== 'string' || props.item.id === params.itemId)
      ? props.item
      : undefined
  const stdinRequest = commandRequest && params.kind === 'writeStdin'
  let command = ''
  if (typeof params.command === 'string') command = params.command
  else if (Array.isArray(params.command)) {
    command = params.command
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
  } else if (
    commandRequest &&
    !stdinRequest &&
    typeof item?.command === 'string'
  ) {
    command = item.command
  }
  if (accountRequest) {
    command = JSON.stringify(
      { name: params.name, arguments: params.arguments },
      null,
      2
    )
  }
  let detailsLabel = t('Command to run')
  if (stdinRequest) detailsLabel = t('Command details')
  if (accountRequest) detailsLabel = t('New API change')
  if (portRequest) detailsLabel = t('Public port change')
  const reason = [params.reason, params.message].find(
    (value): value is string => typeof value === 'string' && !!value.trim()
  )
  const cwd = typeof params.cwd === 'string' ? params.cwd : (item?.cwd ?? '')
  const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : ''
  const permissions = commandRequest
    ? (params.additionalPermissions ?? params.permissions)
    : params.permissions
  const decisions =
    commandRequest && Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : null
  const knownDecisionRequest =
    commandRequest || fileRequest || permissionRequest || accountRequest
  const canAccept =
    knownDecisionRequest && (!decisions || decisions.includes('accept'))
  const canDecline =
    (knownDecisionRequest || elicitation) &&
    (!decisions || decisions.includes('decline'))
  let title = t('Approval required')
  if (input) title = t('Codex needs your input')
  else if (stdinRequest) title = t('Send input to the running command?')
  else if (accountRequest) title = t('Change New API settings?')
  else if (commandRequest) title = t('Run this command?')
  else if (fileRequest) title = t('Apply these file changes?')
  else if (permissionRequest) title = t('Allow access for this turn?')
  if (portRequest) title = t('Change public port access?')
  const questions = parseApprovalQuestions(params.questions)
  const invalidQuestions =
    Array.isArray(params.questions) &&
    questions.length !== params.questions.length
  const questionAnswers = Object.fromEntries(
    questions.map((question) => {
      const answer = answers[question.id]
      const values = answer?.selected ?? []
      let custom = answer?.text ?? ''
      if (!question.isSecret) custom = custom.trim()
      return [
        question.id,
        { answers: [...new Set([...values, ...(custom ? [custom] : [])])] },
      ]
    })
  )
  const answeredCount = Object.values(questionAnswers).filter(
    (answer) =>
      answer.answers.length > 0 &&
      answer.answers.length <= 20 &&
      answer.answers.every((value) => value.length <= 10_000)
  ).length
  const complete =
    questions.length > 0 &&
    !invalidQuestions &&
    answeredCount === questions.length
  const disabled = busy || resolved !== null
  let status = ''
  if (busy) status = t('Submitting...')
  else if (resolved === 'accept') status = t('Allowed')
  else if (resolved === 'decline') status = t('Declined')
  else if (resolved === 'answered') status = t('Answers submitted')

  async function decide(
    answer: CodexApprovalAnswer,
    trigger: HTMLElement | null
  ): Promise<void> {
    if (locked.current) return
    if (
      'decision' in answer &&
      (answer.decision === 'accept' ? !canAccept : !canDecline)
    ) {
      return
    }
    locked.current = true
    action.current = trigger
    setBusy(true)
    setError('')
    try {
      await props.onApprove(props.approval.id, answer)
      if (!mounted.current) return
      setBusy(false)
      setResolved('decision' in answer ? answer.decision : 'answered')
    } catch (cause) {
      if (!mounted.current) return
      setError(codexError(cause))
      setBusy(false)
      locked.current = false
    }
  }

  return (
    <section
      className='border-border bg-background text-foreground w-full min-w-0 shrink-0 overflow-hidden rounded-2xl border shadow-sm'
      aria-label={input ? t('Codex needs your input') : t('Approval required')}
      aria-busy={busy}
      aria-describedby={error ? errorId : undefined}
    >
      <header className='border-border bg-muted/20 flex items-start gap-3 border-b p-4 sm:px-5'>
        <span className='border-border bg-background mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border'>
          {input ? (
            <HelpCircle className='size-4' aria-hidden />
          ) : (
            <ShieldCheck className='size-4' aria-hidden />
          )}
        </span>
        <div className='min-w-0'>
          {!input && (
            <p className='text-muted-foreground mb-0.5 text-[11px] font-medium'>
              {t('Approval required')}
            </p>
          )}
          <h3 className='text-sm leading-6 font-medium'>{title}</h3>
          <p className='text-muted-foreground mt-0.5 text-xs leading-5'>
            {input
              ? t('Answer these questions to continue the task.')
              : t('Review this action before allowing Codex to continue.')}
          </p>
        </div>
      </header>
      {input ? (
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
            if (complete && !disabled) {
              void decide(
                { answers: questionAnswers },
                event.currentTarget.querySelector('button[type="submit"]')
              )
            }
          }}
        >
          {questions.length === 0 && (
            <p className='text-muted-foreground text-sm'>
              {t('No questions were included in this request.')}
            </p>
          )}
          {invalidQuestions && (
            <p role='alert' className='text-destructive text-sm leading-6'>
              {t(
                'Some questions could not be displayed. Ask Codex to send them again.'
              )}
            </p>
          )}
          {questions.map((question) => (
            <ApprovalQuestionField
              key={question.id}
              approvalId={props.approval.id}
              question={question}
              answer={answers[question.id] ?? { selected: [], text: '' }}
              disabled={disabled}
              onChange={(answer) =>
                setAnswers((previous) => ({
                  ...previous,
                  [question.id]: answer,
                }))
              }
            />
          ))}
          <div className='border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4'>
            <div className='min-w-0 space-y-1'>
              {status ? (
                <p
                  role='status'
                  className='text-muted-foreground flex items-center gap-1.5 text-xs'
                >
                  {busy ? (
                    <LoaderCircle
                      className='size-3.5 animate-spin motion-reduce:animate-none'
                      aria-hidden
                    />
                  ) : (
                    <Check className='size-3.5' aria-hidden />
                  )}
                  {status}
                </p>
              ) : (
                <p
                  id={progressId}
                  className='text-muted-foreground text-xs'
                  aria-live='polite'
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
              type='submit'
              size='lg'
              disabled={disabled || !complete}
              aria-describedby={!status ? progressId : undefined}
              aria-keyshortcuts='Control+Enter Meta+Enter'
              className='bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-foreground/30 h-9 rounded-full px-4 text-sm focus-visible:ring-2 focus-visible:ring-offset-2'
            >
              {t('Submit answers')}
            </Button>
          </div>
        </form>
      ) : (
        <div className='space-y-4 p-4 sm:p-5'>
          <div className='space-y-1'>
            <p className='text-muted-foreground text-xs font-medium'>
              {t('Why approval is needed')}
            </p>
            <p className='text-sm leading-6 break-words'>
              {reason || t('No reason was provided for this request.')}
            </p>
          </div>
          {command && (
            <details className='group border-border bg-muted/30 min-w-0 rounded-xl border'>
              <summary className='focus-visible:ring-foreground/25 flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-xs outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden'>
                <ChevronRight
                  className='text-muted-foreground size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none'
                  aria-hidden
                />
                <span className='shrink-0'>{detailsLabel}</span>
                <code className='text-muted-foreground min-w-0 truncate'>
                  {command}
                </code>
              </summary>
              <pre className='border-border max-h-64 overflow-auto border-t p-3 font-mono text-xs leading-6 break-all whitespace-pre-wrap'>
                {command}
              </pre>
            </details>
          )}
          {cwd && (
            <p className='text-muted-foreground text-xs leading-5 break-all'>
              {t('Working directory')}: <span className='font-mono'>{cwd}</span>
            </p>
          )}
          {grantRoot && (
            <p className='text-muted-foreground text-xs leading-5 break-all'>
              {t('Requested directory')}:{' '}
              <span className='font-mono'>{grantRoot}</span>
            </p>
          )}
          {fileRequest && <ApprovalFileChanges item={item} />}
          <ApprovalPermissions
            permissions={permissions}
            networkContext={params.networkApprovalContext}
            scopedToTurn={permissionRequest}
          />
          <details className='group min-w-0'>
            <summary className='text-muted-foreground hover:text-foreground focus-visible:ring-foreground/25 flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden'>
              <ChevronRight
                className='size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none'
                aria-hidden
              />
              {t('Request details')}
            </summary>
            <pre className='bg-muted/40 mt-1 max-h-64 overflow-auto rounded-xl p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap'>
              {JSON.stringify(params, null, 2)}
            </pre>
          </details>
          {elicitation && (
            <p className='text-muted-foreground text-sm leading-6'>
              {t(
                'External tool forms are not supported here. Decline to continue safely.'
              )}
            </p>
          )}
          {!canAccept && !canDecline && (
            <p className='text-muted-foreground text-sm leading-6'>
              {t(
                'This request needs an action that is not available here. Stop the task to continue.'
              )}
            </p>
          )}
          <div className='border-border flex flex-wrap items-center justify-end gap-2 border-t pt-4'>
            {status && (
              <p
                role='status'
                className='text-muted-foreground mr-auto flex items-center gap-1.5 text-xs'
              >
                {busy ? (
                  <LoaderCircle
                    className='size-3.5 animate-spin motion-reduce:animate-none'
                    aria-hidden
                  />
                ) : (
                  <Check className='size-3.5' aria-hidden />
                )}
                {status}
              </p>
            )}
            {canDecline && (
              <Button
                type='button'
                size='lg'
                variant='outline'
                disabled={disabled}
                className='focus-visible:ring-foreground/30 h-9 rounded-full px-4 text-sm focus-visible:ring-2 focus-visible:ring-offset-2'
                onClick={(event) =>
                  void decide({ decision: 'decline' }, event.currentTarget)
                }
              >
                {t('Decline')}
              </Button>
            )}
            {canAccept && (
              <Button
                type='button'
                size='lg'
                disabled={disabled}
                className='bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-foreground/30 h-9 rounded-full px-4 text-sm focus-visible:ring-2 focus-visible:ring-offset-2'
                onClick={(event) =>
                  void decide({ decision: 'accept' }, event.currentTarget)
                }
              >
                {t('Allow once')}
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p
          id={errorId}
          role='alert'
          className='text-destructive px-4 pb-4 text-sm leading-6 break-words sm:px-5 sm:pb-5'
        >
          {t(error)}
        </p>
      )}
    </section>
  )
}

export function ApprovalCard(props: ApprovalCardProps) {
  return <ApprovalRequest key={props.approval.id} {...props} />
}
