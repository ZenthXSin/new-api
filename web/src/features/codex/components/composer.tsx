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
  CornerUpLeft,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  Plus,
  Square,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/features/codex/vendor/zcode/utils'

// Input surface and submit controls adapted from ZCode ConversationComposer.tsx.
// See ../vendor/zcode/conversation/CONVERSATION-PROVENANCE.md.
import { codexError } from '../api'
import type {
  CodexCatalog,
  CodexMode,
  CodexQueuedTurn,
  CodexStatus,
  CodexTurnInput,
} from '../types'
import { Button } from '../vendor/zcode/button'
import { CodexModelSelector } from './model-selector'
import { QueuedTurns } from './queued-turns'
import { CodexReasoningControl } from './reasoning-control'
import { CodexSelect } from './select'

type ComposerProps = {
  status?: CodexStatus
  catalog?: CodexCatalog
  group?: string
  catalogLoading?: boolean
  catalogError?: boolean
  onCatalogRetry?: () => void
  model: string
  hideModelSelector?: boolean
  contextControls?: ReactNode
  effort: string
  mode: CodexMode
  onModel: (model: string, group?: string) => void
  onEffort: (effort: string) => void
  onMode: (mode: CodexMode) => void
  onSubmit: (input: CodexTurnInput) => Promise<void>
  onParallel?: (input: CodexTurnInput) => Promise<void>
  onStop?: () => void | Promise<void>
  running?: boolean
  activeTurnId?: string | null
  busy?: boolean
  disabled?: boolean
  compact?: boolean
  workspaceTitle?: string
  blockedReason?: string
  draftKey?: string
  finishing?: boolean
  onActiveProject?: () => void
  queuedTurns?: CodexQueuedTurn[]
  onCancelQueued?: (requestId: string) => Promise<void>
  onResumeQueued?: (requestId: string) => Promise<void>
  onUploadFiles?: () => void
  onAttachFiles?: (files: File[]) => void
  uploading?: boolean
  uploadedFiles?: string[]
  onRemoveUploadedFile?: (path: string) => void
}
export function CodexComposer(props: ComposerProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const draftScope = useRef<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const dragDepth = useRef(0)
  const stopLocked = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const restoreFocus = useRef(false)
  const errorId = useId()
  const locked = useRef(false)
  const retry = useRef<{ signature: string; id: string } | null>(null)
  const model = props.status?.models.find((entry) => entry.id === props.model)
  const efforts = model?.efforts?.length
    ? model.efforts
    : (props.status?.efforts ?? ['low', 'medium', 'high'])
  const effortDisabled = sending || props.running || props.disabled
  const busy = props.busy || props.running
  const attachmentsDisabled =
    busy || sending || props.disabled || props.uploading
  const hasDraft = !!draft.trim()
  const enabled =
    !props.disabled && !sending && !props.uploading && hasDraft && !!props.model
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
      node.style.height = 'auto'
      node.style.height = `${Math.min(224, Math.max(48, node.scrollHeight))}px`
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
  async function submit(
    busyAction: 'queue' | 'interrupt' | 'parallel' | 'steer' = 'queue'
  ) {
    if (!enabled || locked.current) return
    if (
      busyAction === 'steer' &&
      (!props.running || !props.activeTurnId || stopping || props.finishing)
    ) {
      return
    }
    locked.current = true
    restoreFocus.current = document.activeElement === textarea.current
    setSending(true)
    setError('')
    const signature = JSON.stringify([
      draft,
      props.model,
      props.effort,
      props.mode,
      props.group,
      busy ? busyAction : 'send',
      ...(busyAction === 'steer' ? [props.activeTurnId] : []),
      ...(props.uploadedFiles?.length ? [props.uploadedFiles] : []),
    ])
    if (retry.current?.signature !== signature) {
      retry.current = { signature, id: crypto.randomUUID() }
    }
    preserveDraft(draft)
    const submittedScope = draftScope.current
    const submittedRequestId = retry.current.id
    try {
      const input: CodexTurnInput = {
        prompt: draft.trim(),
        requestId: retry.current.id,
        model: props.model,
        group: props.group,
        effort: props.effort,
        mode: props.mode,
        ...(busy && busyAction !== 'parallel' ? { busyAction } : {}),
        ...(busyAction === 'steer'
          ? { expectedTurnId: props.activeTurnId ?? undefined }
          : {}),
      }
      if (busyAction === 'parallel' && props.onParallel) {
        await props.onParallel(input)
      } else {
        await props.onSubmit(input)
      }
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
  const descriptionId = error ? errorId : undefined
  const inputField = (
    <textarea
      ref={textarea}
      data-codex-composer
      aria-label={t('Describe your coding task')}
      aria-describedby={descriptionId}
      aria-invalid={!!error}
      placeholder={t('Collaborate with Codex')}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        preserveDraft(event.target.value)
        setError('')
      }}
      disabled={sending}
      rows={1}
      maxLength={100_000}
      className={cn(
        'chatgpt-composer-input placeholder:text-muted-foreground block max-h-56 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 pt-2.5 pb-3 text-base leading-6 outline-none disabled:opacity-70',
        props.compact && 'px-2 py-1.5'
      )}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
      }}
      onPaste={(event) => {
        if (!props.onAttachFiles || !event.clipboardData.files.length) {
          return
        }
        event.preventDefault()
        if (!attachmentsDisabled) {
          props.onAttachFiles([...event.clipboardData.files])
        }
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !composing.current &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault()
          void submit()
        }
      }}
    />
  )
  const uploadControl = props.onUploadFiles && (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type='button' variant='ghost' size='icon-md' />}
        className={cn(
          'focus-visible:ring-ring size-11 rounded-full focus-visible:ring-2 sm:size-9',
          props.compact && 'size-9 max-sm:size-10'
        )}
        aria-label={t('Add files and more')}
        title={t('Add files and more')}
        disabled={attachmentsDisabled}
      >
        {props.uploading ? (
          <LoaderCircle className='size-5 animate-spin' aria-hidden />
        ) : (
          <Plus className='size-6' strokeWidth={1.75} aria-hidden />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side='top'
        sideOffset={10}
        align='start'
        className='codex-zcode codex-chatgpt chatgpt-popover w-64 rounded-2xl p-1.5 shadow-lg'
      >
        <DropdownMenuItem
          onClick={props.onUploadFiles}
          disabled={attachmentsDisabled}
          className='min-h-11 gap-3 rounded-xl px-3 py-2.5'
        >
          <Paperclip className='size-5' aria-hidden />
          {t('Add photos & files')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const permissionControl = (
    <CodexSelect
      compact
      side='top'
      label={t('Approval mode')}
      value={props.mode}
      disabled={sending || props.running || props.disabled}
      icon={<ShieldCheck aria-hidden className='size-3.5' />}
      className={cn(
        'codex-permission-select h-9 rounded-full text-xs',
        props.mode === 'full-access' && 'codex-full-access'
      )}
      options={[
        {
          value: 'code',
          label: t('Request approval'),
          description: t(
            'Edit files and run commands, pausing when approval is needed'
          ),
        },
        {
          value: 'auto',
          label: t('Auto approve'),
          description: t(
            'Automatically approve commands and file changes in your environment'
          ),
        },
        {
          value: 'full-access',
          label: t('Full access'),
          description: t(
            'Use the whole execution environment without approval prompts'
          ),
        },
        {
          value: 'ask',
          label: t('Read-only'),
          description: t('Explore your project without changing files'),
        },
      ]}
      onChange={(value) => props.onMode(value as CodexMode)}
    />
  )
  const reasoningControl = (
    <CodexReasoningControl
      efforts={efforts}
      value={props.effort}
      defaultValue={props.status?.defaultEffort}
      disabled={sending || props.running}
      sliderDisabled={effortDisabled}
      onChange={props.onEffort}
      modelName={model?.name || props.model}
      modelControl={
        !props.hideModelSelector && (
          <CodexModelSelector
            catalog={props.catalog}
            status={props.status}
            model={props.model}
            group={props.group}
            disabled={sending || props.running}
            loading={props.catalogLoading}
            error={props.catalogError}
            onRetry={props.onCatalogRetry}
            onSelect={props.onModel}
            className='codex-reasoning-model mx-auto justify-center'
            side='top'
            align='end'
          />
        )
      }
    />
  )
  const sendControls = (
    <>
      {props.running && props.activeTurnId && hasDraft && (
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='codex-task-steer size-11 rounded-full sm:size-9'
          aria-label={t('Steer current task', { defaultValue: '引导当前任务' })}
          title={t('Add guidance to the running task', {
            defaultValue: '补充要求，引导当前任务继续执行',
          })}
          disabled={!enabled || stopping || props.finishing}
          onClick={() => void submit('steer')}
        >
          <MessageSquarePlus className='size-4' aria-hidden />
        </Button>
      )}
      {busy && hasDraft && props.onParallel && (
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='size-11 rounded-full sm:size-9'
          aria-label={t('Start parallel task')}
          title={t('Start parallel task')}
          disabled={!enabled || stopping || props.finishing}
          onClick={() => void submit('parallel')}
        >
          <GitBranch className='size-4' aria-hidden />
        </Button>
      )}
      {busy && hasDraft && (
        <Button
          type='button'
          variant='ghost'
          size='icon-md'
          className='codex-task-steer focus-visible:ring-ring size-11 rounded-full focus-visible:ring-2 sm:size-9'
          aria-label={t('Interrupt and send')}
          title={t('Interrupt and send')}
          disabled={!enabled || stopping || props.finishing}
          onClick={() => void submit('interrupt')}
        >
          <CornerUpLeft className='size-5' aria-hidden />
        </Button>
      )}
      {props.running && (
        <Button
          type='button'
          size='icon-md'
          className='codex-task-stop bg-foreground text-background hover:bg-foreground/80 focus-visible:ring-ring size-11 cursor-pointer rounded-full focus-visible:ring-2 focus-visible:ring-offset-2 sm:size-9'
          aria-label={t('Stop task')}
          title={t('Stop task')}
          disabled={stopping || props.finishing || !props.onStop}
          onClick={() => void stop()}
        >
          {stopping ? (
            <LoaderCircle className='size-4 animate-spin' aria-hidden />
          ) : (
            <Square className='size-3.5 fill-current' aria-hidden />
          )}
        </Button>
      )}
      {(!props.running || hasDraft) && (
        <Button
          type='submit'
          size='icon-md'
          className={cn(
            'codex-task-send bg-foreground text-background hover:bg-foreground/80 focus-visible:ring-ring size-11 rounded-full focus-visible:ring-2 sm:size-9',
            busy && 'codex-task-queue',
            props.compact && 'codex-task-followup-send',
            props.compact && busy && 'codex-task-followup-queue'
          )}
          disabled={!enabled}
          aria-label={busy ? t('Queue message') : t('Start task')}
          title={busy ? t('Queue message') : t('Send message')}
        >
          {sending ? (
            <LoaderCircle className='size-4 animate-spin' aria-hidden />
          ) : (
            <ArrowUp className='size-4' aria-hidden />
          )}
        </Button>
      )}
    </>
  )
  return (
    <div
      className={cn(
        'chatgpt-composer-wrap chat-composer-region z-20 mx-auto w-full max-w-3xl shrink-0 @container/composer',
        props.compact ? 'px-3 pt-2 pb-3 sm:px-4 sm:pb-4' : 'px-3 sm:px-4'
      )}
    >
      <QueuedTurns
        key={props.draftKey}
        turns={props.queuedTurns ?? []}
        onCancel={props.onCancelQueued}
        onResume={props.onResumeQueued}
      />
      {props.contextControls && (
        <div className='codex-task-context-row mb-2 flex min-w-0 flex-wrap items-center gap-1 px-1'>
          {props.contextControls}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        aria-busy={sending || stopping}
        className={cn(
          'codex-task-composer chatgpt-composer chat-composer-input-surface border-border bg-background focus-within:border-border-hover relative w-full rounded-3xl border p-3 shadow-[0_2px_8px_#00000005] transition-colors',
          props.compact && 'codex-task-followup p-2'
        )}
        onDragEnter={(event) => {
          if (
            !props.onAttachFiles ||
            !event.dataTransfer.types.includes('Files')
          ) {
            return
          }
          event.preventDefault()
          dragDepth.current += 1
          if (!attachmentsDisabled) setDraggingFiles(true)
        }}
        onDragOver={(event) => {
          if (
            !props.onAttachFiles ||
            !event.dataTransfer.types.includes('Files')
          ) {
            return
          }
          event.preventDefault()
          event.dataTransfer.dropEffect = attachmentsDisabled ? 'none' : 'copy'
        }}
        onDragLeave={(event) => {
          if (
            !props.onAttachFiles ||
            !event.dataTransfer.types.includes('Files')
          ) {
            return
          }
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDraggingFiles(false)
        }}
        onDrop={(event) => {
          if (
            !props.onAttachFiles ||
            !event.dataTransfer.types.includes('Files')
          ) {
            return
          }
          event.preventDefault()
          dragDepth.current = 0
          setDraggingFiles(false)
          const files = [...event.dataTransfer.files]
          if (!attachmentsDisabled && files.length) props.onAttachFiles(files)
        }}
      >
        {draggingFiles && !attachmentsDisabled && (
          <div
            role='status'
            className='bg-background/95 border-foreground/30 pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-3xl border-2 border-dashed text-sm font-medium'
          >
            <Plus className='size-5' aria-hidden />
            {t('Drop files here')}
          </div>
        )}
        {!!props.uploadedFiles?.length && (
          <ul
            aria-label={t('Uploaded files')}
            className='flex max-h-36 flex-wrap gap-2 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pt-1 pb-2'
          >
            {props.uploadedFiles.map((path) => (
              <li
                key={path}
                className='border-border/70 bg-background flex max-w-full min-w-0 items-center gap-2 rounded-2xl border py-1 pr-1 pl-3 text-sm'
              >
                <Paperclip
                  className='text-muted-foreground size-4 shrink-0'
                  aria-hidden
                />
                <span className='max-w-52 truncate' title={path}>
                  {path}
                </span>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-sm'
                  className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2 sm:size-7'
                  aria-label={t('Remove attachment {{name}}', {
                    name: path,
                    interpolation: { escapeValue: false },
                  })}
                  disabled={
                    sending || props.uploading || !props.onRemoveUploadedFile
                  }
                  onClick={() => props.onRemoveUploadedFile?.(path)}
                >
                  <X className='size-3' aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className='codex-task-input-row min-w-0'>{inputField}</div>
        <div className='codex-task-composer-toolbar chatgpt-composer-toolbar flex min-h-11 flex-wrap items-end gap-2'>
          <div className='codex-task-composer-controls flex min-w-0 flex-1 flex-wrap items-center gap-0.5 sm:gap-1'>
            {uploadControl}
            {permissionControl}
          </div>
          <div className='codex-task-composer-actions ml-auto flex min-h-11 shrink-0 items-center justify-end gap-2 self-end'>
            {reasoningControl}
            {sendControls}
          </div>
        </div>
      </form>
      {(sending || stopping || props.finishing) && (
        <p role='status' className='sr-only'>
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
          className='codex-composer-error text-destructive text-xs'
        >
          {t(error)}{' '}
          {t(
            'Your draft is preserved. Retry to reconnect to the same request.'
          )}
        </p>
      )}
    </div>
  )
}
