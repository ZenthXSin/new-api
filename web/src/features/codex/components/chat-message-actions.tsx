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
  Copy,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { copyToClipboard } from '@/lib/copy-to-clipboard'

import { Button } from '../vendor/zcode/button'
import { cn } from '../vendor/zcode/utils'

export function ChatMessageActions(props: {
  role: 'user' | 'assistant'
  content: string
  disabled?: boolean
  streaming?: boolean
  branchNavigation?: {
    index: number
    total: number
    messageNumber: number
    previousId?: string
    nextId?: string
    onSelect: (id: string) => void
  }
  onDelete?: () => Promise<void>
  onRetry?: (edited?: string) => Promise<void>
  children: ReactNode
}) {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  const actionInFlight = useRef(false)
  const [selected, setSelected] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState(props.content)
  const [error, setError] = useState('')
  const editorDescription = useId()
  const disabled = props.disabled || pending

  useEffect(() => {
    if (!selected) return
    function unselect(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setSelected(false)
    }
    document.addEventListener('pointerdown', unselect)
    return () => document.removeEventListener('pointerdown', unselect)
  }, [selected])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus()
    wasEditing.current = editing
  }, [editing])

  async function action(callback: () => Promise<void>) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setError('')
    setPending(true)
    try {
      await callback()
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : t('Message action failed. Please try again.')
      )
    } finally {
      actionInFlight.current = false
      setPending(false)
    }
  }
  function resend() {
    if (disabled || !draft.trim() || !props.onRetry) return
    void action(async () => {
      await props.onRetry?.(draft.trim())
      setEditing(false)
    })
  }

  return (
    <div
      ref={root}
      className={cn(
        'group/message relative min-w-0',
        props.role === 'assistant' && 'codex-task-response-card'
      )}
      data-message-role={props.role}
      data-actions-visible={selected || editing}
      onClick={() => setSelected(true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !editing) setSelected(false)
      }}
    >
      {editing ? (
        <div className='chatgpt-message-editor bg-secondary ml-auto w-full space-y-3 rounded-3xl p-4 sm:p-5'>
          <textarea
            autoFocus
            aria-label={t('Edit message')}
            aria-describedby={editorDescription}
            disabled={disabled}
            value={draft}
            maxLength={100000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Escape' && !pending) {
                event.preventDefault()
                setEditing(false)
              }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                resend()
              }
            }}
            className='focus-visible:ring-input-border-focused min-h-28 w-full resize-y rounded-lg bg-transparent px-1 py-0.5 text-base leading-7 outline-none focus-visible:ring-2 disabled:opacity-60'
          />
          <p
            id={editorDescription}
            className='text-muted-foreground px-1 text-xs leading-5'
          >
            {t(
              'Your original conversation is saved as a separate branch. Project files are kept.'
            )}
          </p>
          <div className='flex justify-end gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={pending}
              className='bg-background h-9 rounded-full px-4 text-sm'
              onClick={() => setEditing(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='button'
              disabled={disabled || !draft.trim()}
              className='h-9 gap-2 rounded-full px-4 text-sm'
              onClick={resend}
            >
              {pending && (
                <LoaderCircle
                  className='size-4 animate-spin motion-reduce:animate-none'
                  aria-hidden
                />
              )}
              {t('Save and retry')}
            </Button>
          </div>
        </div>
      ) : (
        props.children
      )}
      {!editing &&
        !props.streaming &&
        (props.content ||
          props.onRetry ||
          props.onDelete ||
          props.branchNavigation) && (
          <TooltipProvider delay={300}>
            <div
              className={cn(
                'chatgpt-message-controls text-muted-foreground mt-1 flex min-h-8 items-center gap-0.5',
                props.role === 'user' ? 'justify-end' : 'justify-start'
              )}
            >
              {props.branchNavigation && (
                <div
                  role='group'
                  aria-label={t('Versions of message {{number}}', {
                    number: props.branchNavigation.messageNumber,
                  })}
                  className='mr-1 flex shrink-0 items-center gap-0.5 text-xs tabular-nums'
                >
                  <MessageActionButton
                    label={t('Previous branch')}
                    disabled={!props.branchNavigation.previousId}
                    onClick={() => {
                      const previous = props.branchNavigation?.previousId
                      if (previous) props.branchNavigation?.onSelect(previous)
                    }}
                  >
                    <ChevronLeft className='size-4' aria-hidden />
                  </MessageActionButton>
                  <span
                    aria-live='polite'
                    aria-atomic='true'
                    className='min-w-8 text-center'
                  >
                    {props.branchNavigation.index + 1} /{' '}
                    {props.branchNavigation.total}
                  </span>
                  <MessageActionButton
                    label={t('Next branch')}
                    disabled={!props.branchNavigation.nextId}
                    onClick={() => {
                      const next = props.branchNavigation?.nextId
                      if (next) props.branchNavigation?.onSelect(next)
                    }}
                  >
                    <ChevronRight className='size-4' aria-hidden />
                  </MessageActionButton>
                </div>
              )}
              <div
                className={cn(
                  'codex-message-actions text-muted-foreground flex min-h-8 items-center gap-0.5',
                  props.role === 'user'
                    ? '-mr-1 justify-end'
                    : '-ml-2 justify-start'
                )}
              >
                {props.content && (
                  <MessageActionButton
                    label={
                      props.role === 'user'
                        ? t('Copy message')
                        : t('Copy response')
                    }
                    tooltip={copied ? t('Copied') : undefined}
                    disabled={pending}
                    onClick={() =>
                      void action(async () => {
                        if (!(await copyToClipboard(props.content))) {
                          throw new Error(t('Failed to copy to clipboard'))
                        }
                        setCopied(true)
                      })
                    }
                  >
                    {copied ? (
                      <Check className='size-[18px]' aria-hidden />
                    ) : (
                      <Copy className='size-[18px]' aria-hidden />
                    )}
                  </MessageActionButton>
                )}
                {props.role === 'user' && props.onRetry && (
                  <MessageActionButton
                    buttonRef={editButton}
                    label={t('Edit message')}
                    disabled={disabled}
                    onClick={() => {
                      setDraft(props.content)
                      setEditing(true)
                      setError('')
                    }}
                  >
                    <Pencil className='size-[18px]' aria-hidden />
                  </MessageActionButton>
                )}
                {props.onRetry && (
                  <MessageActionButton
                    label={t('Retry message')}
                    disabled={disabled}
                    onClick={() =>
                      void action(async () => {
                        await props.onRetry?.()
                      })
                    }
                  >
                    <RotateCcw className='size-[18px]' aria-hidden />
                  </MessageActionButton>
                )}
                {props.onDelete && (
                  <MessageActionButton
                    label={t('Delete message')}
                    disabled={disabled}
                    destructive
                    onClick={() =>
                      void action(async () => {
                        await props.onDelete?.()
                      })
                    }
                  >
                    <Trash2 className='size-[18px]' aria-hidden />
                  </MessageActionButton>
                )}
              </div>
            </div>
          </TooltipProvider>
        )}
      {copied && (
        <span role='status' className='sr-only'>
          {t('Copied')}
        </span>
      )}
      {error && (
        <p
          role='alert'
          className={cn(
            'text-destructive mt-2 text-sm leading-5',
            props.role === 'user' && 'text-right'
          )}
        >
          {error}
        </p>
      )}
    </div>
  )
}

function MessageActionButton(props: {
  label: string
  tooltip?: string
  children: ReactNode
  disabled?: boolean
  destructive?: boolean
  buttonRef?: Ref<HTMLButtonElement>
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={props.buttonRef}
            type='button'
            variant='ghost'
            size='icon'
            className={cn(
              'text-muted-foreground focus-visible:ring-ring pointer-events-auto size-8 rounded-lg focus-visible:ring-2 [@media(hover:none)]:size-10',
              props.destructive && 'hover:text-destructive'
            )}
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent
        side='bottom'
        className='rounded-lg px-2.5 py-1.5 text-xs'
      >
        {props.tooltip ?? props.label}
      </TooltipContent>
    </Tooltip>
  )
}
