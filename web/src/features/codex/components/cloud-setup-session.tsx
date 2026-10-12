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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, LoaderCircle, Square, Terminal } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { codexApi, codexError } from '../api'
import { useCodexThread } from '../hooks/use-codex-thread'
import { isCodexBusy } from '../lib/events'
import type { CodexApprovalAnswer, CodexDetail, CodexTurnInput } from '../types'
import { Button } from '../vendor/zcode/button'
import { CodexConversation } from './conversation'

interface CloudSetupSessionProps {
  actor?: string
  workspaceId: string
  disabled?: boolean
  onActivity?: () => void
}

const setupMessageSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'Enter a message of up to 100,000 characters.')
    .max(100_000, 'Enter a message of up to 100,000 characters.'),
})

type SetupAction =
  | { type: 'send'; input: CodexTurnInput }
  | { type: 'stop' }
  | { type: 'approve'; id: string; answer: CodexApprovalAnswer }

export function CloudSetupSession(props: CloudSetupSessionProps) {
  return (
    <SetupSession
      key={JSON.stringify([props.actor ?? '', props.workspaceId])}
      {...props}
    />
  )
}

function SetupSession(props: CloudSetupSessionProps) {
  const { t } = useTranslation()
  const actor = props.actor ?? ''
  const onActivity = props.onActivity
  const client = useQueryClient()
  const detail = useCodexThread(props.workspaceId || undefined, actor)
  const status = useQuery({
    queryKey: ['codex', actor, 'status'],
    queryFn: ({ signal }) => codexApi.status(signal),
    enabled: !!props.workspaceId,
    staleTime: 30_000,
    retry: 1,
  })
  const catalog = useQuery({
    queryKey: ['codex', actor, 'catalog'],
    queryFn: ({ signal }) => codexApi.catalog(signal),
    enabled: !!props.workspaceId,
    staleTime: 30_000,
    retry: 1,
  })
  const form = useForm<z.infer<typeof setupMessageSchema>>({
    resolver: zodResolver(setupMessageSchema),
    defaultValues: { prompt: '' },
  })
  const prompt = form.watch('prompt')
  const id = useId()
  const mounted = useRef(true)
  const locked = useRef(false)
  const retry = useRef<{ signature: string; requestId: string } | null>(null)
  const wasRunning = useRef(false)
  const workspace = detail.data?.workspace
  const groups = catalog.data?.groups ?? []
  const orderedGroups = [
    ...groups.filter((group) => group.id === catalog.data?.defaultGroup),
    ...groups.filter((group) => group.id !== catalog.data?.defaultGroup),
  ]
  const availableModels = orderedGroups.flatMap((group) =>
    group.models
      .filter((model) => model.supported)
      .map((model) => ({ model: model.id, group: group.id }))
  )
  const selectedModel =
    availableModels.find(
      (entry) => entry.model === status.data?.defaultModel
    ) ?? availableModels[0]
  const model = selectedModel?.model ?? ''
  const group = selectedModel?.group ?? ''
  const effort = status.data?.defaultEffort ?? ''
  const running = isCodexBusy(workspace?.status ?? '')
  const approvals = detail.data?.pendingApprovals ?? []
  const conversationId =
    detail.data?.conversationId ?? workspace?.conversationId
  const actionsReady =
    !!props.workspaceId &&
    !!detail.data &&
    !props.disabled &&
    !detail.isError &&
    !workspace?.archived &&
    !workspace?.conversationArchived
  const sendReady =
    actionsReady &&
    !!status.data?.available &&
    !!status.data.configured &&
    !!model &&
    !status.isError &&
    !catalog.isError
  const mutation = useMutation({
    mutationFn: async (action: SetupAction) => {
      if (action.type === 'send') {
        return (
          await codexApi.turn(props.workspaceId, action.input, conversationId)
        ).workspace
      }
      if (action.type === 'stop') {
        return (await codexApi.interrupt(props.workspaceId, conversationId))
          .workspace
      }
      await codexApi.approve(
        props.workspaceId,
        action.id,
        action.answer,
        conversationId
      )
      return undefined
    },
    onSuccess: async (updatedWorkspace) => {
      if (!mounted.current) return
      const queryKey = ['codex', actor, 'workspace', props.workspaceId]
      if (updatedWorkspace) {
        client.setQueryData<CodexDetail>([...queryKey, 'default'], (previous) =>
          previous ? { ...previous, workspace: updatedWorkspace } : previous
        )
      }
      await client.invalidateQueries({ queryKey })
      if (mounted.current) props.onActivity?.()
    },
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (wasRunning.current && !running && detail.data) onActivity?.()
    wasRunning.current = running
  }, [running, detail.data, onActivity])

  async function perform(action: SetupAction): Promise<void> {
    if (!actionsReady || locked.current) {
      throw new Error(t('The setup session is temporarily unavailable.'))
    }
    locked.current = true
    try {
      await mutation.mutateAsync(action)
    } finally {
      locked.current = false
    }
  }

  async function sendMessage(value: string): Promise<void> {
    const parsed = setupMessageSchema.safeParse({ prompt: value })
    if (!parsed.success) {
      throw new Error(t('Enter a message of up to 100,000 characters.'))
    }
    if (!sendReady || running || approvals.length) {
      throw new Error(t('The setup session is temporarily unavailable.'))
    }
    const signature = JSON.stringify([parsed.data.prompt, model, effort, group])
    if (retry.current?.signature !== signature) {
      retry.current = { signature, requestId: crypto.randomUUID() }
    }
    await perform({
      type: 'send',
      input: {
        prompt: parsed.data.prompt,
        requestId: retry.current.requestId,
        model,
        effort,
        group,
        mode: 'code',
      },
    })
    if (!mounted.current) return
    retry.current = null
    if (form.getValues('prompt').trim() === parsed.data.prompt) {
      form.reset({ prompt: '' })
    }
    form.setFocus('prompt')
  }

  const submit = form.handleSubmit(async (value) => {
    try {
      await sendMessage(value.prompt)
    } catch {
      // The mutation error is displayed below; retain the message for retry.
    }
  })
  const loading =
    !!props.workspaceId &&
    (detail.isPending || status.isPending || catalog.isPending)
  const empty =
    !detail.data?.thread?.turns.length && !running && !approvals.length
  const error = mutation.error ?? detail.error ?? status.error ?? catalog.error
  const queryFailed = detail.isError || status.isError || catalog.isError
  const canSend =
    sendReady &&
    !running &&
    !approvals.length &&
    !mutation.isPending &&
    !!prompt.trim()
  let progress = t('Ready')
  if (!props.workspaceId) {
    progress = t('Prepare this environment to start a setup session.')
  } else if (loading) {
    progress = t('Loading conversation...')
  } else if (mutation.isPending) {
    progress = t('Submitting...')
    if (mutation.variables.type === 'stop') progress = t('Stopping task…')
    if (mutation.variables.type === 'send') progress = t('Sending task…')
  } else if (approvals.length) {
    progress = t('Waiting for approval')
  } else if (running) {
    progress = t('Codex is working...')
  } else if (!sendReady) {
    progress = t('The setup session is temporarily unavailable.')
  }

  return (
    <section
      aria-label={t('Setup session')}
      aria-busy={loading || mutation.isPending}
      className='flex h-full min-h-[28rem] min-w-0 flex-col overflow-hidden'
    >
      <header className='flex flex-wrap items-center justify-between gap-2 px-5 py-4'>
        <h2 className='text-sm font-medium'>{t('Setup session')}</h2>
        <span role='status' className='text-muted-foreground text-xs'>
          {progress}
        </span>
      </header>
      {!!detail.connectionError && (
        <p
          role='status'
          className='text-muted-foreground mx-5 mb-3 text-xs leading-5'
        >
          {t(
            'Connection interrupted. Reconnecting; your task continues on the server.'
          )}
        </p>
      )}
      {error && (
        <div
          id={`${id}-error`}
          role='alert'
          className='text-destructive mx-5 mb-3 text-sm'
        >
          <p>{t(codexError(error))}</p>
          {queryFailed && (
            <Button
              variant='outline'
              className='mt-2 h-8 px-3'
              disabled={
                detail.isFetching || status.isFetching || catalog.isFetching
              }
              onClick={() => {
                mutation.reset()
                void detail.refetch()
                void status.refetch()
                void catalog.refetch()
              }}
            >
              {t('Retry')}
            </Button>
          )}
        </div>
      )}
      {!loading &&
        !error &&
        status.data &&
        (!status.data.available || !status.data.configured || !model) && (
          <p role='alert' className='text-muted-foreground mx-5 mb-3 text-sm'>
            {t(
              status.data.reason ||
                'Codex is unavailable. Check the project service and model configuration.'
            )}
          </p>
        )}
      {loading ? (
        <div className='flex min-h-0 flex-1 items-center justify-center py-12'>
          <LoaderCircle
            className='text-muted-foreground size-5 animate-spin motion-reduce:animate-none'
            aria-hidden
          />
        </div>
      ) : (
        <fieldset
          disabled={!actionsReady || mutation.isPending}
          className='m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0'
        >
          {empty ? (
            <div className='m-auto max-w-xl px-6 py-10 text-center'>
              <Terminal
                className='text-muted-foreground mx-auto mb-5 size-7'
                aria-hidden
              />
              <h3 className='text-xl font-medium tracking-tight'>
                {t('Prepare your environment with Codex')}
              </h3>
              <p className='text-muted-foreground mt-3 text-sm leading-6'>
                {t(
                  'Work with Codex to check repositories, install dependencies, and prepare this environment.'
                )}
              </p>
              <div className='mt-6 flex flex-wrap justify-center gap-2'>
                {[
                  {
                    label: t('Check repositories'),
                    prompt: t(
                      'Inspect the repositories and summarize what this environment needs to run and test them.'
                    ),
                  },
                  {
                    label: t('Install dependencies'),
                    prompt: t(
                      'Install the dependencies required by these repositories and report anything that needs configuration.'
                    ),
                  },
                  {
                    label: t('Verify environment'),
                    prompt: t(
                      'Verify that this environment can run and test the repositories, and report any missing configuration.'
                    ),
                  },
                ].map((suggestion) => (
                  <Button
                    key={suggestion.label}
                    variant='outline'
                    className='focus-visible:ring-ring min-h-9 rounded-xl px-3 text-xs focus-visible:ring-2'
                    disabled={!sendReady}
                    onClick={() => {
                      form.setValue('prompt', suggestion.prompt, {
                        shouldValidate: true,
                      })
                      form.setFocus('prompt')
                    }}
                  >
                    {suggestion.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <CodexConversation
              workspaceId={props.workspaceId ?? undefined}
              actor={actor}
              remoteRoot={detail.data?.workspace.remote?.path}
              thread={detail.data?.thread ?? null}
              conversationId={conversationId}
              running={running}
              approvals={approvals}
              actionsDisabled={!sendReady || mutation.isPending}
              onApprove={(approvalId, answer) =>
                perform({ type: 'approve', id: approvalId, answer })
              }
              onReply={sendMessage}
            />
          )}
        </fieldset>
      )}
      <form
        onSubmit={submit}
        className='mx-auto w-full max-w-[816px] shrink-0 px-4 pt-3 pb-4 sm:px-5'
      >
        <div className='border-border bg-background focus-within:border-ring rounded-2xl border p-3 shadow-xs'>
          <label htmlFor={`${id}-prompt`} className='sr-only'>
            {t('Message Codex about this environment')}
          </label>
          <textarea
            {...form.register('prompt')}
            id={`${id}-prompt`}
            rows={3}
            maxLength={100_000}
            placeholder={t('Ask Codex to help set up this environment...')}
            disabled={!sendReady}
            readOnly={mutation.isPending}
            aria-invalid={!!form.formState.errors.prompt}
            aria-describedby={`${id}-hint${form.formState.errors.prompt ? ` ${id}-validation` : ''}${error ? ` ${id}-error` : ''}`}
            className='placeholder:text-muted-foreground max-h-56 min-h-20 w-full resize-y bg-transparent text-base outline-none disabled:opacity-60 sm:text-sm'
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              ) {
                return
              }
              event.preventDefault()
              if (canSend) void submit()
            }}
          />
          <div className='mt-2 flex items-center justify-between gap-3'>
            <span
              className='text-muted-foreground truncate text-xs'
              title={t('Model')}
            >
              {model}
            </span>
            {running ? (
              <Button
                size='icon'
                className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2 focus-visible:ring-offset-2'
                aria-label={t('Stop task')}
                disabled={!actionsReady || mutation.isPending}
                onClick={() => {
                  void perform({ type: 'stop' }).catch(() => undefined)
                }}
              >
                <Square className='size-3 fill-current' aria-hidden />
              </Button>
            ) : (
              <Button
                type='submit'
                size='icon'
                className='focus-visible:ring-ring size-9 rounded-full focus-visible:ring-2 focus-visible:ring-offset-2'
                aria-label={t('Send message')}
                disabled={!canSend}
              >
                {mutation.isPending ? (
                  <LoaderCircle
                    className='size-4 animate-spin motion-reduce:animate-none'
                    aria-hidden
                  />
                ) : (
                  <ArrowUp className='size-4' aria-hidden />
                )}
              </Button>
            )}
          </div>
        </div>
        {form.formState.errors.prompt && (
          <p
            id={`${id}-validation`}
            role='alert'
            className='text-destructive mt-2 text-xs'
          >
            {t('Enter a message of up to 100,000 characters.')}
          </p>
        )}
        <p
          id={`${id}-hint`}
          className='text-muted-foreground mt-2 text-center text-[11px]'
        >
          {t('Press Enter to send, Shift+Enter for a new line')}
        </p>
      </form>
    </section>
  )
}
