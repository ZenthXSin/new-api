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
  ArrowUp,
  ChevronDown,
  LoaderCircle,
  Square,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { codexError } from '../api'
import type { CodexMode, CodexStatus, CodexTurnInput } from '../types'

type ComposerProps = {
  status?: CodexStatus
  model: string
  effort: string
  mode: CodexMode
  onModel: (model: string) => void
  onEffort: (effort: string) => void
  onMode: (mode: CodexMode) => void
  onSubmit: (input: CodexTurnInput) => Promise<void>
  onStop?: () => void | Promise<void>
  running?: boolean
  disabled?: boolean
  compact?: boolean
  workspaceTitle?: string
  blockedReason?: string
  draftKey?: string
  finishing?: boolean
  onActiveProject?: () => void
}
export function CodexComposer(props: ComposerProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const draftScope = useRef<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const stopLocked = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const restoreFocus = useRef(false)
  const hintId = useId()
  const errorId = useId()
  const locked = useRef(false)
  const retry = useRef<{ signature: string; id: string } | null>(null)
  const model = props.status?.models.find((entry) => entry.id === props.model)
  const efforts = model?.efforts?.length
    ? model.efforts
    : (props.status?.efforts ?? ['low', 'medium', 'high'])
  const enabled =
    !props.disabled &&
    !sending &&
    !props.running &&
    !!draft.trim() &&
    !!props.model
  useLayoutEffect(() => {
    const storageKey = props.draftKey
      ? `codex-draft:${props.draftKey}`
      : undefined
    draftScope.current = storageKey
    if (!storageKey) return
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
      setDraft(
        typeof stored?.draft === 'string' ? stored.draft.slice(0, 100_000) : ''
      )
      retry.current =
        stored?.retry &&
        typeof stored.retry.signature === 'string' &&
        typeof stored.retry.id === 'string'
          ? stored.retry
          : null
    } catch {
      setDraft('')
      retry.current = null
      preserveDraft('')
    }
  }, [props.draftKey])
  function preserveDraft(value: string) {
    if (!draftScope.current) return
    try {
      if (value) {
        sessionStorage.setItem(
          draftScope.current,
          JSON.stringify({ draft: value, retry: retry.current })
        )
      } else sessionStorage.removeItem(draftScope.current)
    } catch {
      // A disabled or full browser store must never prevent composing a task.
    }
  }
  useLayoutEffect(() => {
    const node = textarea.current
    if (!node) return
    const resize = () => {
      const minimum = props.compact ? 64 : 96
      node.style.height = 'auto'
      node.style.height = `${Math.min(224, Math.max(minimum, node.scrollHeight))}px`
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [draft, props.compact])
  useEffect(() => {
    if (!sending && restoreFocus.current) {
      if (document.activeElement === document.body) {
        textarea.current?.focus({ preventScroll: true })
      }
      restoreFocus.current = false
    }
  }, [sending])
  async function stop() {
    if (!props.onStop || stopLocked.current) return
    stopLocked.current = true
    setStopping(true)
    setError('')
    try {
      await props.onStop()
    } catch (cause) {
      setError(codexError(cause))
    } finally {
      stopLocked.current = false
      setStopping(false)
    }
  }
  async function submit() {
    if (!enabled || locked.current) return
    locked.current = true
    restoreFocus.current = document.activeElement === textarea.current
    setSending(true)
    setError('')
    const signature = JSON.stringify([
      draft,
      props.model,
      props.effort,
      props.mode,
    ])
    if (retry.current?.signature !== signature) {
      retry.current = { signature, id: crypto.randomUUID() }
    }
    preserveDraft(draft)
    const submittedScope = draftScope.current
    const submittedRequestId = retry.current.id
    try {
      await props.onSubmit({
        prompt: draft.trim(),
        requestId: retry.current.id,
        model: props.model,
        effort: props.effort,
        mode: props.mode,
      })
      if (draftScope.current === submittedScope) {
        setDraft((current) => (current === draft ? '' : current))
        if (retry.current?.id === submittedRequestId) retry.current = null
      }
      if (submittedScope) {
        try {
          const saved = JSON.parse(
            sessionStorage.getItem(submittedScope) || 'null'
          )
          if (
            saved?.draft === draft &&
            saved?.retry?.id === submittedRequestId
          ) {
            sessionStorage.removeItem(submittedScope)
          }
        } catch {
          // Do not erase a newer draft or block successful submission on storage failures.
        }
      }
    } catch (cause) {
      setError(codexError(cause))
    } finally {
      locked.current = false
      setSending(false)
    }
  }
  let progressLabel = t('Sending task…')
  if (props.finishing) progressLabel = t('Finishing task…')
  if (stopping) progressLabel = t('Stopping task…')
  let hint =
    props.mode === 'ask'
      ? t('Ask questions about your code in read-only mode.')
      : t('Codex can edit files and run commands in this project.')
  if (props.running) {
    hint = t('You can draft your next message while Codex works.')
  }
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-3xl',
        props.compact ? 'px-3 pt-2 pb-3 sm:px-6 sm:pb-5' : 'px-1 sm:px-0'
      )}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        aria-busy={sending || stopping}
        className='bg-background focus-within:border-foreground/30 focus-within:ring-foreground/5 border-border rounded-2xl border p-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:ring-4 sm:p-3'
      >
        <textarea
          ref={textarea}
          data-codex-composer
          aria-label={t('Describe your coding task')}
          aria-describedby={error ? errorId : hintId}
          aria-invalid={!!error}
          placeholder={
            props.compact
              ? t('Ask a follow-up or describe the next change')
              : t('What should we build next?')
          }
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            preserveDraft(event.target.value)
            setError('')
          }}
          disabled={sending}
          rows={props.compact ? 2 : 3}
          maxLength={100_000}
          className='placeholder:text-muted-foreground/80 block max-h-56 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-2 text-base leading-6 outline-none disabled:opacity-70 sm:text-[15px]'
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className='mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2'>
          <div className='flex min-w-0 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden'>
            <label className='hover:bg-muted focus-within:bg-muted relative flex h-11 w-28 shrink-0 items-center rounded-xl sm:w-auto sm:max-w-44'>
              <select
                aria-label={t('Codex model')}
                value={props.model}
                onChange={(event) => props.onModel(event.target.value)}
                disabled={sending || props.running || props.disabled}
                className='h-full w-full appearance-none truncate rounded-xl bg-transparent pr-5 pl-2 text-[13px] outline-none disabled:opacity-60'
              >
                {!props.model && (
                  <option value=''>{t('Select a model')}</option>
                )}
                {props.status?.models.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.name || entry.id}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className='pointer-events-none absolute right-1.5 size-3'
              />
            </label>
            <label className='hover:bg-muted focus-within:bg-muted relative flex h-11 shrink-0 items-center rounded-xl'>
              <Sparkles aria-hidden className='ml-1.5 size-3.5' />
              <select
                aria-label={t('Reasoning effort')}
                value={props.effort}
                onChange={(event) => props.onEffort(event.target.value)}
                disabled={sending || props.running || props.disabled}
                className='h-full appearance-none rounded-xl bg-transparent pr-6 pl-1.5 text-[13px] outline-none disabled:opacity-60'
              >
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {t(effort)}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className='pointer-events-none absolute right-1.5 size-3'
              />
            </label>
            <label className='hover:bg-muted focus-within:bg-muted relative flex h-11 shrink-0 items-center rounded-xl'>
              <Terminal aria-hidden className='ml-1.5 size-3.5' />
              <select
                aria-label={t('Codex mode')}
                value={props.mode}
                onChange={(event) =>
                  props.onMode(event.target.value as CodexMode)
                }
                disabled={sending || props.running || props.disabled}
                className='h-full appearance-none rounded-xl bg-transparent pr-6 pl-1.5 text-[13px] outline-none disabled:opacity-60'
              >
                <option value='code'>{t('Code')}</option>
                <option value='ask'>{t('Ask')}</option>
              </select>
              <ChevronDown
                aria-hidden
                className='pointer-events-none absolute right-1.5 size-3'
              />
            </label>
          </div>
          <div className='flex h-11 items-center justify-end'>
            {props.running ? (
              <Button
                type='button'
                size='icon'
                className='bg-foreground text-background hover:bg-foreground/85 size-11 rounded-full shadow-sm'
                aria-label={t('Stop task')}
                title={t('Stop task')}
                disabled={stopping || props.finishing || !props.onStop}
                onClick={() => void stop()}
              >
                {stopping ? (
                  <LoaderCircle className='size-4 animate-spin' />
                ) : (
                  <Square className='size-3.5 fill-current' />
                )}
              </Button>
            ) : (
              <Button
                type='submit'
                size='icon'
                className='bg-foreground text-background hover:bg-foreground/85 size-11 rounded-full shadow-sm'
                disabled={!enabled}
                aria-label={t('Start task')}
                title={t('Start task')}
              >
                {sending ? (
                  <LoaderCircle className='size-4 animate-spin' />
                ) : (
                  <ArrowUp className='size-5' />
                )}
              </Button>
            )}
          </div>
        </div>
      </form>
      {(sending || stopping || props.finishing) && (
        <p role='status' className='text-muted-foreground mt-2 px-2 text-xs'>
          {progressLabel}
        </p>
      )}
      {props.blockedReason && (
        <div
          role='status'
          className='mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-2 text-xs'
        >
          <p className='text-muted-foreground'>{props.blockedReason}</p>
          {props.onActiveProject && (
            <button
              type='button'
              className='font-medium underline underline-offset-4'
              onClick={props.onActiveProject}
            >
              {t('Open active project')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p
          id={errorId}
          role='alert'
          className='text-destructive mt-2 px-2 text-xs'
        >
          {t(error)}{' '}
          {t(
            'Your draft is preserved. Retry to reconnect to the same request.'
          )}
        </p>
      )}
      <div
        id={hintId}
        className='text-muted-foreground mt-2 flex items-start justify-between gap-3 px-1 text-[11px] leading-4 sm:px-2'
      >
        <p>{hint}</p>
        <p className='hidden shrink-0 sm:block'>
          {t('Enter to send · Shift + Enter for a new line')}
        </p>
      </div>
    </div>
  )
}
