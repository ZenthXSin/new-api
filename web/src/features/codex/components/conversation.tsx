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
import { Collapsible } from '@base-ui/react/collapsible'
import {
  ArrowDown,
  CheckCircle2,
  ChevronRight,
  Brain,
  Globe,
  ListChecks,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  PauseCircle,
  Paperclip,
  Terminal,
  Users,
} from 'lucide-react'
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { codexItemText } from '../lib/events'
import type {
  CodexApproval,
  CodexApprovalAnswer,
  CodexItem,
  CodexProjectConversation,
  CodexThread,
  CodexTurn,
} from '../types'
import { Button } from '../vendor/zcode/button'
import { Message, MessageContent } from '../vendor/zcode/conversation/message'
import { MessageResponse } from '../vendor/zcode/conversation/message-response'
import { ApprovalCard } from './approval-card'
import { AsyncQuestionCard } from './async-question-card'
import { ChatMessageActions } from './chat-message-actions'
import { WorkspaceFileLinkProvider } from './workspace-file-link-provider'

type CodexConversationProps = {
  workspaceId?: string
  actor?: string
  remoteRoot?: string
  initialFile?: string
  initialLine?: number
  thread: CodexThread | null
  running: boolean
  approvals: CodexApproval[]
  onApprove: (id: string, answer: CodexApprovalAnswer) => Promise<void>
  actionsDisabled?: boolean
  scrollToLatestKey?: string | number
  branches?: CodexProjectConversation[]
  conversationId?: string
  onSelectBranch?: (id: string, turnIndex?: number) => void
  onReply?: (prompt: string) => Promise<void>
  focusTurnId?: string
  focusTurnIndex?: number
  focusTurnKey?: string | number
  onDelete?: (turnId: string, role: 'user' | 'assistant') => Promise<void>
  onRetry?: (turnId: string, prompt: string) => Promise<void>
}

const noReplies: string[] = []

export function CodexConversation(props: CodexConversationProps) {
  return (
    <WorkspaceFileLinkProvider
      key={props.workspaceId}
      workspaceId={props.workspaceId}
      actor={props.actor}
      remoteRoot={props.remoteRoot}
      conversationId={props.conversationId}
      initialFile={props.initialFile}
      initialLine={props.initialLine}
    >
      <ConversationContent {...props} />
    </WorkspaceFileLinkProvider>
  )
}

function ConversationContent(props: CodexConversationProps) {
  const { t } = useTranslation()
  const latestCallbacks = useRef(props)
  useLayoutEffect(() => {
    latestCallbacks.current = props
  })
  const branchFamily = useMemo(() => {
    const current = props.branches?.find(
      (branch) => branch.id === props.conversationId
    )
    if (!current?.branch) return []
    return (props.branches ?? [])
      .filter(
        (branch) =>
          branch.branch?.rootConversationId ===
          current.branch?.rootConversationId
      )
      .sort(
        (left, right) =>
          (left.branch?.version ?? 0) - (right.branch?.version ?? 0)
      )
  }, [props.branches, props.conversationId])
  const branchPaths = useMemo(() => {
    const revisions = new Map(
      branchFamily.map((entry) => [entry.branch?.revisionId, entry])
    )
    const paths = new Map<string, CodexProjectConversation[]>()
    for (const entry of branchFamily) {
      const path: CodexProjectConversation[] = []
      const visited = new Set<string>()
      let current: CodexProjectConversation | undefined = entry
      while (current?.branch) {
        if (visited.has(current.branch.revisionId)) break
        visited.add(current.branch.revisionId)
        path.unshift(current)
        if (!current.branch.parentRevisionId) {
          paths.set(entry.id, path)
          break
        }
        if (
          !Number.isInteger(current.branch.turnIndex) ||
          (current.branch.turnIndex ?? -1) < 0
        ) {
          break
        }
        current = revisions.get(current.branch.parentRevisionId)
      }
    }
    return paths
  }, [branchFamily])
  const currentPath = branchPaths.get(props.conversationId ?? '')
  const hasMessageBranches =
    !!currentPath && branchPaths.size === branchFamily.length
  const selectedBranchTurn = useRef<{
    conversationId: string
    index: number
  } | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const perform = useCallback(async (action: () => Promise<void>) => {
    setActionPending(true)
    try {
      await action()
    } finally {
      setActionPending(false)
    }
  }, [])
  const turnActions = useMemo(
    () => ({
      reply: async (prompt: string) => {
        await latestCallbacks.current.onReply?.(prompt)
      },
      remove: async (turnId: string, role: 'user' | 'assistant') =>
        perform(async () => {
          await latestCallbacks.current.onDelete?.(turnId, role)
        }),
      retry: async (turnId: string, prompt: string) =>
        perform(async () => {
          await latestCallbacks.current.onRetry?.(turnId, prompt)
        }),
    }),
    [perform]
  )
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [showBottom, setShowBottom] = useState(false)
  const [missingFocus, setMissingFocus] = useState(false)
  const empty =
    !props.thread?.turns.length &&
    !props.running &&
    props.approvals.length === 0
  const latestTurn = props.thread?.turns.at(-1)
  const previousRun = useRef({
    threadId: props.thread?.id,
    running: props.running,
  })
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const previous = previousRun.current
    previousRun.current = { threadId: props.thread?.id, running: props.running }
    if (previous.threadId !== props.thread?.id || props.running) {
      setAnnouncement('')
      return
    }
    if (!previous.running) return
    if (latestTurn?.status === 'failed') {
      setAnnouncement(t('Task failed'))
    } else if (latestTurn?.status === 'interrupted') {
      setAnnouncement(t('Task stopped. Send a message to continue.'))
    } else {
      setAnnouncement(t('Response complete'))
    }
  }, [props.running, props.thread?.id, latestTurn?.status, t])
  useLayoutEffect(() => {
    setMissingFocus(false)
    if (
      (props.focusTurnId || props.focusTurnIndex !== undefined) &&
      viewport.current
    ) {
      const target = [
        ...(content.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ??
          []),
      ].find((element) =>
        props.focusTurnId
          ? element.dataset.turnId === props.focusTurnId
          : Number(element.dataset.turnIndex) === props.focusTurnIndex
      )
      if (target) {
        selectedBranchTurn.current = null
        const top =
          target.getBoundingClientRect().top -
          viewport.current.getBoundingClientRect().top +
          viewport.current.scrollTop
        viewport.current.scrollTop = Math.max(0, top - 24)
        follow.current = false
        setShowBottom(
          viewport.current.scrollHeight -
            viewport.current.scrollTop -
            viewport.current.clientHeight >=
            90
        )
        target.focus({ preventScroll: true })
        return
      }
      setMissingFocus(!!props.thread?.id)
    }
    const selected = selectedBranchTurn.current
    if (
      selected &&
      selected.conversationId === props.conversationId &&
      viewport.current
    ) {
      const turn = content.current?.querySelector<HTMLElement>(
        `[data-turn-index="${selected.index}"]`
      )
      if (turn) {
        const top =
          turn.getBoundingClientRect().top -
          viewport.current.getBoundingClientRect().top +
          viewport.current.scrollTop
        viewport.current.scrollTop = Math.max(0, top - 24)
        follow.current =
          viewport.current.scrollHeight -
            viewport.current.scrollTop -
            viewport.current.clientHeight <
          90
        setShowBottom(!follow.current)
        turn.focus({ preventScroll: true })
        selectedBranchTurn.current = null
        return
      }
    }
    follow.current = true
    setShowBottom(false)
    if (viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    }
  }, [
    props.thread?.id,
    props.conversationId,
    props.scrollToLatestKey,
    props.focusTurnId,
    props.focusTurnIndex,
    props.focusTurnKey,
  ])
  useLayoutEffect(() => {
    if (follow.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
    }
  }, [props.thread, props.approvals])
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // Markdown/code renderers and expanded tools can resize after a network
      // event. Follow only when the reader has not scrolled into older messages.
      if (follow.current && viewport.current) {
        viewport.current.scrollTop = viewport.current.scrollHeight
      }
    })
    observer.observe(content.current)
    if (viewport.current) observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [])
  function scrollToBottom() {
    follow.current = true
    setShowBottom(false)
    if (viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
      viewport.current.focus({ preventScroll: true })
    }
  }
  return (
    <div className='chatgpt-conversation relative min-h-0 min-w-0 flex-1'>
      <div
        ref={viewport}
        className='chatgpt-conversation-viewport focus-visible:ring-ring h-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset'
        role='region'
        tabIndex={0}
        aria-busy={props.running}
        onScroll={() => {
          const node = viewport.current
          if (!node) return
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 90
          setShowBottom(!follow.current)
        }}
        aria-label={t('Task conversation')}
      >
        <div
          ref={content}
          className={cn(
            'chatgpt-conversation-content codex-conversation-content mx-auto w-full max-w-[816px] min-w-0 space-y-6 px-4 pt-4 pb-5 sm:px-6',
            empty && 'flex min-h-full items-center justify-center'
          )}
        >
          {missingFocus && (
            <p role='status' className='text-muted-foreground text-sm'>
              {t('This message is no longer available in this conversation.')}
            </p>
          )}
          {empty && (
            <div className='chatgpt-empty mx-auto w-full text-center'>
              <h2 className='text-foreground text-[28px] leading-10 font-medium tracking-tight sm:text-[32px]'>
                {t('What can I help with?')}
              </h2>
            </div>
          )}
          {branchFamily.length > 1 &&
            !hasMessageBranches &&
            props.onSelectBranch && (
              <div className='flex items-center justify-end gap-2 text-sm'>
                <label
                  htmlFor='codex-conversation-version'
                  className='text-muted-foreground'
                >
                  {t('Conversation version')}
                </label>
                <select
                  id='codex-conversation-version'
                  value={props.conversationId}
                  onChange={(event) =>
                    props.onSelectBranch?.(event.target.value)
                  }
                  className='border-border bg-background max-w-64 rounded-lg border px-2 py-1.5'
                >
                  {branchFamily.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {t('Version {{number}}', {
                        number: branch.branch?.version,
                      })}{' '}
                      · {branch.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          {props.thread?.turns.map((turn, turnIndex) => {
            let versions: CodexProjectConversation[] = []
            let currentVersion = -1
            if (hasMessageBranches && props.onSelectBranch && currentPath) {
              const currentPrefix = messageBranchRevision(
                currentPath,
                turnIndex - 1
              )
              const currentRevision = messageBranchRevision(
                currentPath,
                turnIndex
              )
              const representatives = new Map<
                string,
                CodexProjectConversation
              >()
              for (const branch of branchFamily) {
                const path = branchPaths.get(branch.id)
                if (
                  !path ||
                  branch.turnCount <= turnIndex ||
                  messageBranchRevision(path, turnIndex - 1) !== currentPrefix
                ) {
                  continue
                }
                const revision = messageBranchRevision(path, turnIndex)
                if (!revision) continue
                representatives.set(revision, branch)
              }
              versions = [...representatives.entries()]
                .sort(([left], [right]) => {
                  const leftVersion =
                    branchFamily.find(
                      (branch) => branch.branch?.revisionId === left
                    )?.branch?.version ?? 0
                  const rightVersion =
                    branchFamily.find(
                      (branch) => branch.branch?.revisionId === right
                    )?.branch?.version ?? 0
                  return leftVersion - rightVersion
                })
                .map(([, branch]) => branch)
              currentVersion = versions.findIndex(
                (branch) =>
                  messageBranchRevision(
                    branchPaths.get(branch.id) ?? [],
                    turnIndex
                  ) === currentRevision
              )
            }
            return (
              <ConversationTurn
                key={`${props.thread?.id}:${turn.id}`}
                turn={turn}
                turnIndex={turnIndex}
                focused={
                  turn.id === props.focusTurnId ||
                  turnIndex === props.focusTurnIndex
                }
                laterReplies={
                  turn.items.some(
                    (item) =>
                      item.delivery === 'async' && Array.isArray(item.questions)
                  )
                    ? (props.thread?.turns.slice(turnIndex + 1) ?? [])
                        .filter(
                          (later) => !later.deletedRoles?.includes('user')
                        )
                        .flatMap((later) =>
                          later.items
                            .filter((item) => item.type === 'userMessage')
                            .map(codexItemText)
                        )
                    : noReplies
                }
                hasContinued={
                  turn.items.some(
                    (item) =>
                      item.delivery === 'async' && Array.isArray(item.questions)
                  ) &&
                  (props.thread?.turns.slice(turnIndex + 1) ?? []).some(
                    (later) =>
                      later.items.some((item) => item.type === 'userMessage')
                  )
                }
                onReply={props.onReply ? turnActions.reply : undefined}
                branchNavigation={
                  versions.length > 1 &&
                  currentVersion >= 0 &&
                  props.onSelectBranch
                    ? {
                        index: currentVersion,
                        total: versions.length,
                        messageNumber: turnIndex + 1,
                        previousId: versions[currentVersion - 1]?.id,
                        nextId: versions[currentVersion + 1]?.id,
                        onSelect: (id) => {
                          selectedBranchTurn.current = {
                            conversationId: id,
                            index: turnIndex,
                          }
                          props.onSelectBranch?.(id, turnIndex)
                        },
                      }
                    : undefined
                }
                running={props.running && turn.status === 'inProgress'}
                disabled={
                  props.running || props.actionsDisabled || actionPending
                }
                onDelete={props.onDelete ? turnActions.remove : undefined}
                onRetry={props.onRetry ? turnActions.retry : undefined}
              />
            )
          })}
          {props.approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              item={approvalItemFromThread(props.thread, approval)}
              onApprove={props.onApprove}
            />
          ))}
          {props.running && props.approvals.length === 0 && (
            <div
              className='codex-run-status text-muted-foreground flex min-h-8 items-center gap-2.5 text-sm'
              aria-hidden='true'
            >
              <span className='bg-foreground block size-2.5 animate-pulse rounded-full motion-reduce:animate-none' />
              {t('Codex is working...')}
            </div>
          )}
        </div>
      </div>
      {(props.running || announcement) && (
        <span role='status' aria-atomic='true' className='sr-only'>
          {props.running ? t('Codex is working...') : announcement}
        </span>
      )}
      {showBottom && (
        <Button
          type='button'
          variant='outline'
          size='icon'
          className='bg-background/95 border-border focus-visible:ring-ring absolute bottom-4 left-1/2 size-9 -translate-x-1/2 rounded-full shadow-sm backdrop-blur focus-visible:ring-2'
          title={t('Scroll to latest message')}
          aria-label={t('Scroll to latest message')}
          onClick={scrollToBottom}
        >
          <ArrowDown className='size-4' aria-hidden />
        </Button>
      )}
    </div>
  )
}

const ConversationTurn = memo(function ConversationTurn(props: {
  turn: CodexTurn
  turnIndex: number
  focused?: boolean
  laterReplies: string[]
  hasContinued: boolean
  onReply?: (prompt: string) => Promise<void>
  branchNavigation?: {
    index: number
    total: number
    messageNumber: number
    previousId?: string
    nextId?: string
    onSelect: (id: string) => void
  }
  running: boolean
  disabled?: boolean
  onDelete?: (turnId: string, role: 'user' | 'assistant') => Promise<void>
  onRetry?: (turnId: string, prompt: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const turn = props.turn
  const users = turn.items.filter((item) => item.type === 'userMessage')
  const prompt = users.map(codexItemText).join('\n')
  const agents = turn.items.filter((item) => item.type === 'agentMessage')
  const latestAgents = [...agents].reverse()
  const final =
    latestAgents.find((item) => item.phase === 'final_answer') ??
    latestAgents.find((item) => item.phase !== 'commentary') ??
    (!props.running ? latestAgents[0] : undefined)
  const activity = turn.items.filter(
    (item) => item.type !== 'userMessage' && item !== final
  )
  const liveUpdate =
    props.running && !final
      ? latestAgents.find(
          (item) => item.phase === 'commentary' && codexItemText(item)
        )
      : undefined
  return (
    <section
      className={cn(
        'codex-turn min-w-0 space-y-3 rounded-2xl outline-none',
        props.focused &&
          'ring-ring/50 ring-2 ring-offset-8 ring-offset-background'
      )}
      aria-label={t('Task turn')}
      data-turn-index={props.turnIndex}
      data-turn-id={turn.id}
      tabIndex={-1}
    >
      {!turn.deletedRoles?.includes('user') &&
        users.map((item, index) => (
          <ChatMessageActions
            key={item.id}
            role='user'
            branchNavigation={index === 0 ? props.branchNavigation : undefined}
            content={codexItemText(item)}
            disabled={props.disabled}
            onDelete={
              props.onDelete
                ? async () => {
                    await props.onDelete?.(turn.id, 'user')
                  }
                : undefined
            }
            onRetry={
              props.onRetry && prompt
                ? async (edited) => {
                    await props.onRetry?.(turn.id, edited ?? prompt)
                  }
                : undefined
            }
          >
            <CodexMessage
              item={item}
              running={props.running}
              turnStatus={turn.status}
            />
          </ChatMessageActions>
        ))}
      {!turn.deletedRoles?.includes('assistant') &&
        (final ||
          activity.length > 0 ||
          !!turn.plan?.length ||
          turn.status === 'failed' ||
          turn.status === 'interrupted') && (
          <ChatMessageActions
            role='assistant'
            content={final ? codexItemText(final) : ''}
            disabled={props.disabled}
            streaming={props.running}
            onDelete={
              props.onDelete
                ? async () => {
                    await props.onDelete?.(turn.id, 'assistant')
                  }
                : undefined
            }
            onRetry={
              props.onRetry && prompt
                ? async () => {
                    await props.onRetry?.(turn.id, prompt)
                  }
                : undefined
            }
          >
            <div className='codex-task-response-body min-w-0 space-y-2'>
              <TaskPlan turn={turn} running={props.running} />
              {activity.length > 0 && (
                <ExecutionSteps
                  items={activity}
                  running={props.running}
                  turnStatus={turn.status}
                  liveUpdate={liveUpdate}
                />
              )}
              {final && (
                <CodexMessage
                  item={final}
                  running={props.running}
                  turnStatus={turn.status}
                />
              )}
              {final?.delivery === 'async' &&
                Array.isArray(final.questions) && (
                  <AsyncQuestionCard
                    key={final.id}
                    item={final}
                    replies={props.laterReplies}
                    hasContinued={props.hasContinued}
                    disabled={props.disabled}
                    onReply={props.onReply}
                  />
                )}
              <TaskChangedFiles items={turn.items} />
            </div>
          </ChatMessageActions>
        )}
      {!turn.deletedRoles?.includes('assistant') &&
        turn.status === 'interrupted' && (
          <p className='codex-run-status text-muted-foreground flex items-center gap-2 py-1 text-sm'>
            <PauseCircle className='size-4 shrink-0' aria-hidden />
            {t('Task stopped. Send a message to continue.')}
          </p>
        )}
      {!turn.deletedRoles?.includes('assistant') &&
        (turn.error?.message || turn.status === 'failed') && (
          <div
            role='alert'
            className='text-destructive border-destructive/20 bg-destructive/5 flex items-start gap-2 rounded-xl border p-3 text-sm'
          >
            <CircleAlert className='mt-0.5 size-4 shrink-0' aria-hidden />
            <div className='min-w-0'>
              <p className='font-medium'>{t('Task failed')}</p>
              {turn.error?.message && (
                <p className='mt-1 leading-6 break-words'>
                  {turn.error.message}
                </p>
              )}
            </div>
          </div>
        )}
    </section>
  )
})

function TaskPlan(props: { turn: CodexTurn; running: boolean }) {
  const { t } = useTranslation()
  if (!props.turn.plan?.length) return null
  const completed = props.turn.plan.filter(
    (step) => step.status === 'completed'
  ).length
  return (
    <details className='codex-plan group/plan min-w-0'>
      <summary className='text-muted-foreground focus-visible:ring-ring flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg py-1 text-sm focus-visible:ring-2 focus-visible:outline-none'>
        <ListChecks className='size-4 shrink-0' aria-hidden />
        <span>{t('Implementation plan')}</span>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {completed} / {props.turn.plan.length}
        </span>
        <ChevronRight
          className='size-3.5 shrink-0 transition-transform group-open/plan:rotate-90 motion-reduce:transition-none'
          aria-hidden
        />
      </summary>
      <div className='border-border mt-2 ml-2 border-l px-4 py-1'>
        {props.turn.planExplanation && (
          <p className='text-muted-foreground mb-3 text-sm leading-6'>
            {props.turn.planExplanation}
          </p>
        )}
        <ol className='space-y-2.5'>
          {props.turn.plan.map((step) => (
            <li
              key={step.step}
              className='flex items-start gap-2 text-sm leading-5'
            >
              {step.status === 'completed' && (
                <CheckCircle2
                  className='mt-0.5 size-3.5 shrink-0'
                  aria-label={t('Completed')}
                />
              )}
              {step.status === 'inProgress' && props.running && (
                <LoaderCircle
                  className='mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none'
                  aria-label={t('Running')}
                />
              )}
              {step.status === 'inProgress' && !props.running && (
                <PauseCircle
                  className='mt-0.5 size-3.5 shrink-0'
                  aria-label={t('Stopped')}
                />
              )}
              {step.status === 'pending' && (
                <span
                  className='border-muted-foreground/50 mt-1 size-3 shrink-0 rounded-full border'
                  aria-label={t('Pending')}
                />
              )}
              <span
                className={cn(
                  'min-w-0 break-words',
                  step.status === 'completed' && 'text-muted-foreground'
                )}
              >
                {step.step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  )
}

function TaskChangedFiles(props: { items: CodexItem[] }) {
  const { t } = useTranslation()
  const changes = new Map<string, { path: string; diff?: string }>()
  for (const item of props.items) {
    if (
      item.type !== 'fileChange' ||
      (item.status && item.status !== 'completed')
    ) {
      continue
    }
    for (const change of item.changes ?? []) changes.set(change.path, change)
  }
  if (!changes.size) return null
  return (
    <section
      className='codex-task-changed-files min-w-0 text-sm'
      aria-label={t('Changed {{count}} files', { count: changes.size })}
    >
      <Collapsible.Root defaultOpen>
        <h4 className='text-sm font-medium'>
          <Collapsible.Trigger
            type='button'
            className='group focus-visible:ring-ring hover:bg-muted/60 flex min-h-9 max-w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-2'
          >
            <span>{t('Changed {{count}} files', { count: changes.size })}</span>
            <ChevronRight
              className='size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none'
              aria-hidden
            />
          </Collapsible.Trigger>
        </h4>
        <Collapsible.Panel keepMounted className='codex-activity-panel min-w-0'>
          <ul className='space-y-1 pt-1'>
            {[...changes.values()].map((change) => (
              <ChangedFileRow key={change.path} change={change} />
            ))}
          </ul>
        </Collapsible.Panel>
      </Collapsible.Root>
    </section>
  )
}

function ChangedFileRow(props: { change: { path: string; diff?: string } }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const contentId = useId()
  let added = 0
  let removed = 0
  if (props.change.diff) {
    for (const line of props.change.diff.split(/\r?\n/)) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
  }
  const summary = (
    <>
      <FileCode2 className='size-4 shrink-0' aria-hidden />
      <span className='min-w-0 flex-1 truncate'>{props.change.path}</span>
      {added > 0 && (
        <span className='text-diff-added shrink-0 text-xs tabular-nums'>
          +{added}
        </span>
      )}
      {removed > 0 && (
        <span className='text-diff-removed shrink-0 text-xs tabular-nums'>
          −{removed}
        </span>
      )}
    </>
  )
  return (
    <li>
      {props.change.diff ? (
        <>
          <button
            type='button'
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen(!open)}
            className='focus-visible:ring-ring hover:bg-muted/60 flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-xs outline-none focus-visible:ring-2'
            title={props.change.path}
          >
            {summary}
            <ChevronRight
              className={cn('size-3.5 shrink-0', open && 'rotate-90')}
              aria-hidden
            />
          </button>
          {open && (
            <pre
              id={contentId}
              aria-label={t('Changes in {{file}}', { file: props.change.path })}
              tabIndex={0}
              className='bg-muted/50 focus-visible:ring-ring mt-1 max-h-72 max-w-full overflow-auto rounded-xl p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2'
            >
              {props.change.diff}
            </pre>
          )}
        </>
      ) : (
        <div
          className='flex min-h-9 items-center gap-2 px-2 text-xs'
          title={props.change.path}
        >
          {summary}
        </div>
      )}
    </li>
  )
}

function ExecutionSteps(props: {
  items: CodexItem[]
  running: boolean
  turnStatus: string
  liveUpdate?: CodexItem
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const latest = props.items.at(-1)
  let summary: string | undefined
  if (latest?.type === 'commandExecution') summary = latest.command
  if (latest?.type === 'fileChange') {
    summary = latest.changes?.[0]?.path.split('/').at(-1)
  }
  const agents = props.items.filter((item) => item.type === 'subagent').length
  return (
    <div className='codex-execution-group min-w-0 space-y-1'>
      <ActivityDisclosure
        icon={<ListChecks className='size-4' aria-hidden />}
        label={t('Execution steps')}
        summary={summary}
        hideSummaryWhenOpen
        running={props.running}
        status={
          <span className='flex items-center gap-2'>
            <span>{t('{{count}} steps', { count: props.items.length })}</span>
            {agents > 0 && (
              <span>{t('{{count}} agents', { count: agents })}</span>
            )}
          </span>
        }
        onExpandedChange={setExpanded}
      >
        <ol
          aria-label={t('Execution steps')}
          className='codex-execution-timeline border-border ml-1 min-w-0 space-y-0.5 border-l pb-0.5 pl-3'
        >
          {props.items.map((item) => (
            <li key={item.id} className='codex-execution-item min-w-0'>
              <CodexMessage
                item={item}
                running={props.running}
                turnStatus={props.turnStatus}
              />
            </li>
          ))}
        </ol>
      </ActivityDisclosure>
      {props.liveUpdate && !expanded && (
        <div className='codex-live-update min-w-0'>
          <CodexMessage
            item={props.liveUpdate}
            running={props.running}
            turnStatus={props.turnStatus}
          />
        </div>
      )}
    </div>
  )
}

type ActivityState = 'running' | 'completed' | 'failed' | 'stopped' | 'pending'

function executionState(
  item: CodexItem,
  running: boolean,
  turnStatus: string
): ActivityState | undefined {
  if (
    item.status === 'failed' ||
    item.status === 'declined' ||
    item.success === false ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
  ) {
    return 'failed'
  }
  if (
    item.status === 'interrupted' ||
    item.status === 'stopped' ||
    item.status === 'cancelled'
  ) {
    return 'stopped'
  }
  if (
    item.status === 'completed' ||
    item.success === true ||
    item.exitCode === 0
  ) {
    return 'completed'
  }
  if (
    item.status === 'inProgress' ||
    item.status === 'running' ||
    item.status === 'starting'
  ) {
    if (running) return 'running'
    return turnStatus === 'failed' ? 'failed' : 'stopped'
  }
  if (item.status === 'pending' || item.status === 'queued') return 'pending'
  return undefined
}

function ExecutionStatus(props: {
  state?: ActivityState
  exitCode?: number | null
}) {
  const { t } = useTranslation()
  let label = ''
  if (props.state === 'running') label = t('Running')
  if (props.state === 'completed') label = t('Completed')
  if (props.state === 'failed') label = t('Failed')
  if (props.state === 'stopped') label = t('Stopped')
  if (props.state === 'pending') label = t('Pending')
  if (typeof props.exitCode === 'number' && props.state !== 'running') {
    label = t('Exit {{code}}', { code: props.exitCode })
  }
  if (!label) return null
  return (
    <span
      className={cn(
        'text-xs whitespace-nowrap',
        props.state === 'failed' && 'text-destructive'
      )}
      data-state={props.state}
    >
      {label}
    </span>
  )
}

function ActivityDisclosure(props: {
  icon: ReactNode
  label: string
  summary?: ReactNode
  status?: ReactNode
  running?: boolean
  hideSummaryWhenOpen?: boolean
  title?: string
  onExpandedChange?: (expanded: boolean) => void
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  return (
    <Collapsible.Root
      open={expanded}
      onOpenChange={(next) => {
        setExpanded(next)
        props.onExpandedChange?.(next)
      }}
      className='codex-activity min-w-0'
    >
      <Collapsible.Trigger
        type='button'
        aria-expanded={expanded}
        aria-controls={contentId}
        title={props.title}
        className='codex-execution-summary text-muted-foreground focus-visible:ring-ring flex min-h-9 max-w-full cursor-pointer items-center gap-2 rounded-lg py-1 text-left text-[13px] leading-5 outline-none focus-visible:ring-2'
      >
        <span className='shrink-0'>
          {props.running ? (
            <LoaderCircle
              className='size-4 animate-spin motion-reduce:animate-none'
              aria-hidden
            />
          ) : (
            props.icon
          )}
        </span>
        <span className='shrink-0 font-medium'>{props.label}</span>{' '}
        {props.summary && !(expanded && props.hideSummaryWhenOpen) && (
          <span className='min-w-0 truncate'>{props.summary}</span>
        )}{' '}
        {props.status && (
          <span className='shrink-0 text-xs'>{props.status}</span>
        )}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90'
          )}
          aria-hidden
        />
      </Collapsible.Trigger>
      <Collapsible.Panel
        id={contentId}
        className='codex-activity-panel min-w-0'
      >
        <div className='min-w-0 pt-1'>{props.children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

function CodexMessage(props: {
  item: CodexItem
  running: boolean
  turnStatus: string
}) {
  const { t } = useTranslation()
  const item = props.item
  const content = codexItemText(item)
  const state = executionState(item, props.running, props.turnStatus)
  if (item.type === 'userMessage') {
    const attachments = (item.content ?? []).filter(
      (part) => part.type !== 'text' && (part.path || part.url)
    )
    return (
      <Message from='user' aria-label={t('You')}>
        {attachments.length > 0 && (
          <ul
            aria-label={t('Attachments')}
            className='ml-auto flex max-w-full flex-wrap justify-end gap-2'
          >
            {attachments.map((part) => {
              let name = part.path?.split(/[\\/]/).at(-1) || t('Attached file')
              let imageUrl: string | undefined
              if (part.url) {
                try {
                  const url = new URL(part.url)
                  if (url.protocol === 'http:' || url.protocol === 'https:') {
                    name =
                      decodeURIComponent(
                        url.pathname.split('/').at(-1) || ''
                      ) || name
                    if (part.type === 'image') imageUrl = url.href
                  }
                } catch {
                  /* Keep a readable attachment when the URL cannot be previewed. */
                }
              }
              return (
                <li
                  key={`${part.type}:${part.path ?? part.url}`}
                  className='border-border bg-background max-w-full overflow-hidden rounded-xl border'
                >
                  {imageUrl && (
                    <a
                      href={imageUrl}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='focus-visible:ring-ring block outline-none focus-visible:ring-2'
                    >
                      <img
                        src={imageUrl}
                        alt={name}
                        loading='lazy'
                        referrerPolicy='no-referrer'
                        className='max-h-48 max-w-64 object-contain'
                      />
                    </a>
                  )}
                  <span className='flex min-h-10 max-w-64 items-center gap-2 px-3 py-2 text-xs'>
                    <Paperclip className='size-4 shrink-0' aria-hidden />
                    <span className='truncate'>{name}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {content && (
          <MessageContent className='chatgpt-user-message max-w-[90%] text-[15px] leading-7 [overflow-wrap:anywhere] whitespace-pre-wrap group-[.is-user]:rounded-[20px] group-[.is-user]:px-4 group-[.is-user]:py-2.5 sm:max-w-[85%]'>
            {content}
          </MessageContent>
        )}
      </Message>
    )
  }
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return (
      <Message from='assistant' className='chatgpt-assistant-message'>
        <MessageContent className='w-full overflow-visible'>
          <span className='sr-only'>
            {item.type === 'plan' ? t('Implementation plan') : 'Codex'}
          </span>
          <MessageResponse
            streaming={props.running && item.status !== 'completed'}
          >
            {content}
          </MessageResponse>
        </MessageContent>
      </Message>
    )
  }
  if (item.type === 'subagent') {
    const children = Array.isArray(item.items)
      ? item.items.filter(isCodexItem)
      : []
    const turns = Array.isArray(item.turns)
      ? item.turns.filter(isCodexTurn)
      : []
    const active = state === 'running'
    return (
      <ActivityDisclosure
        icon={<Users className='size-4' aria-hidden />}
        label={
          typeof item.agentName === 'string' && item.agentName
            ? item.agentName
            : t('Subagent')
        }
        summary={content || undefined}
        hideSummaryWhenOpen
        status={<ExecutionStatus state={state} />}
        running={active}
      >
        <div className='codex-subagent-activity border-border min-w-0 space-y-4 border-l pl-4'>
          {turns.length > 0 ? (
            turns.map((turn) => (
              <div key={turn.id} className='min-w-0 space-y-3'>
                {!turn.deletedRoles?.includes('assistant') && (
                  <TaskPlan
                    turn={turn}
                    running={active && turn.status === 'inProgress'}
                  />
                )}
                {turn.items
                  .filter(
                    (child) =>
                      !turn.deletedRoles?.includes(
                        child.type === 'userMessage' ? 'user' : 'assistant'
                      )
                  )
                  .map((child) => (
                    <CodexMessage
                      key={child.id}
                      item={child}
                      running={active && turn.status === 'inProgress'}
                      turnStatus={turn.status}
                    />
                  ))}
              </div>
            ))
          ) : (
            <>
              {children.map((child) => (
                <CodexMessage
                  key={child.id}
                  item={child}
                  running={active}
                  turnStatus={item.status ?? props.turnStatus}
                />
              ))}
              {!children.length && (
                <p className='text-muted-foreground py-2 text-sm'>
                  {content || t('Waiting for output...')}
                </p>
              )}
            </>
          )}
        </div>
      </ActivityDisclosure>
    )
  }
  if (item.type === 'reasoning') {
    return (
      <ActivityDisclosure
        icon={<Brain className='size-4' aria-hidden />}
        label={t('Reasoning summary')}
        running={state === 'running'}
      >
        <div className='text-muted-foreground min-w-0 text-sm leading-7'>
          <MessageResponse
            streaming={props.running && item.status !== 'completed'}
          >
            {content || t('Thinking...')}
          </MessageResponse>
        </div>
      </ActivityDisclosure>
    )
  }
  if (item.type === 'commandExecution') {
    return (
      <ActivityDisclosure
        icon={<Terminal className='size-4' aria-hidden />}
        label={t('Command')}
        summary={<code>{item.command || t('Command')}</code>}
        running={state === 'running'}
        status={<ExecutionStatus state={state} exitCode={item.exitCode} />}
        title={item.command}
      >
        <div className='border-border bg-muted/40 min-w-0 overflow-hidden rounded-xl border'>
          {item.cwd && (
            <p className='text-muted-foreground border-border border-b px-3 py-2 font-mono text-xs break-all'>
              {item.cwd}
            </p>
          )}
          <pre
            tabIndex={0}
            aria-label={t('Command output')}
            className='focus-visible:ring-ring max-h-80 max-w-full overflow-auto p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2'
          >
            {item.aggregatedOutput || t('No command output.')}
          </pre>
        </div>
      </ActivityDisclosure>
    )
  }
  if (item.type === 'fileChange') {
    let label = t('Changed {{count}} files', {
      count: item.changes?.length ?? 0,
    })
    if (
      state === 'failed' ||
      state === 'running' ||
      state === 'pending' ||
      state === 'stopped'
    ) {
      label = t('File changes')
    }
    return (
      <ActivityDisclosure
        icon={<FileCode2 className='size-4' aria-hidden />}
        label={label}
        summary={item.changes
          ?.map((change) => change.path.split('/').at(-1))
          .join(', ')}
        running={state === 'running'}
        status={<ExecutionStatus state={state} />}
      >
        <div className='border-border bg-muted/30 min-w-0 overflow-hidden rounded-xl border'>
          {item.changes?.map((change) => (
            <div className='min-w-0 [&+&]:border-t' key={change.path}>
              <p className='px-3 py-2 font-mono text-xs break-all'>
                {change.path}
              </p>
              {change.diff && (
                <pre
                  tabIndex={0}
                  aria-label={t('Changes in {{file}}', { file: change.path })}
                  className='bg-background/40 focus-visible:ring-ring max-h-72 max-w-full overflow-auto p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2'
                >
                  {change.diff}
                </pre>
              )}
            </div>
          ))}
        </div>
      </ActivityDisclosure>
    )
  }
  if (item.type === 'contextCompaction') {
    return (
      <p className='text-muted-foreground py-2 text-xs'>
        {t('Conversation context compacted.')}
      </p>
    )
  }
  return <ToolActivity item={item} state={state} />
}

function ToolActivity(props: { item: CodexItem; state?: ActivityState }) {
  const { t } = useTranslation()
  const item = props.item
  const result =
    item.result &&
    typeof item.result === 'object' &&
    !Array.isArray(item.result)
      ? (item.result as Record<string, unknown>)
      : undefined
  const action =
    item.action &&
    typeof item.action === 'object' &&
    !Array.isArray(item.action)
      ? (item.action as Record<string, unknown>)
      : undefined
  const blocks: string[] = []
  if (typeof item.text === 'string' && item.text) blocks.push(item.text)
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) {
    blocks.push(item.aggregatedOutput)
  }
  if (typeof item.result === 'string' && item.result) blocks.push(item.result)
  const outputs = [item.content, item.contentItems, result?.content]
  for (const output of outputs) {
    if (!Array.isArray(output)) continue
    for (const block of output) {
      if (
        block &&
        typeof block === 'object' &&
        (block.type === 'text' || block.type === 'inputText') &&
        typeof block.text === 'string' &&
        block.text
      ) {
        blocks.push(block.text)
      }
    }
  }
  const error =
    item.error &&
    typeof item.error === 'object' &&
    'message' in item.error &&
    typeof item.error.message === 'string'
      ? item.error.message
      : undefined
  const urls: string[] = []
  for (const value of [item.url, action?.url]) {
    if (typeof value !== 'string' || !value) continue
    try {
      const url = new URL(value)
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !urls.includes(url.href)
      ) {
        urls.push(url.href)
      }
    } catch {
      /* Invalid tool links remain non-interactive. */
    }
  }
  const queries = Array.isArray(action?.queries)
    ? action.queries.filter(
        (query): query is string => typeof query === 'string'
      )
    : []
  if (typeof item.query === 'string' && item.query) queries.unshift(item.query)
  else if (typeof action?.query === 'string' && action.query) {
    queries.unshift(action.query)
  }
  const toolName = typeof item.tool === 'string' ? item.tool : undefined
  const label = item.type === 'webSearch' ? t('Web search') : t('Tool activity')
  const structuredOutput =
    !blocks.length && result?.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent, null, 2)
      : undefined
  return (
    <ActivityDisclosure
      icon={<Globe className='size-4' aria-hidden />}
      label={label}
      summary={toolName || queries[0]}
      hideSummaryWhenOpen
      running={props.state === 'running'}
      status={<ExecutionStatus state={props.state} />}
    >
      <div className='codex-tool-output min-w-0 space-y-3 text-sm leading-6'>
        {toolName && (
          <p className='text-muted-foreground font-mono text-xs break-all'>
            {toolName}
          </p>
        )}
        {queries.length > 0 && (
          <ul className='space-y-1'>
            {[...new Set(queries)].map((query) => (
              <li key={query} className='break-words'>
                {query}
              </li>
            ))}
          </ul>
        )}
        {typeof action?.pattern === 'string' && (
          <p className='break-words'>{action.pattern}</p>
        )}
        {urls.map((url) => (
          <a
            key={url}
            href={url}
            target='_blank'
            rel='noopener noreferrer'
            className='text-foreground focus-visible:ring-ring block break-all underline underline-offset-4 outline-none focus-visible:ring-2'
          >
            {url}
          </a>
        ))}
        {blocks.length > 0 && (
          <MessageResponse>{blocks.join('\n\n')}</MessageResponse>
        )}
        {structuredOutput && (
          <pre
            tabIndex={0}
            aria-label={t('Tool output')}
            className='bg-muted/40 focus-visible:ring-ring max-h-72 max-w-full overflow-auto rounded-xl p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-2'
          >
            {structuredOutput}
          </pre>
        )}
        {error && <p className='text-destructive break-words'>{error}</p>}
        {!blocks.length &&
          !structuredOutput &&
          !queries.length &&
          !urls.length &&
          !error && (
            <p className='text-muted-foreground'>
              {props.state === 'running'
                ? t('Waiting for output...')
                : t('No output was returned.')}
            </p>
          )}
      </div>
    </ActivityDisclosure>
  )
}

function isCodexItem(value: unknown): value is CodexItem {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

function isCodexTurn(value: unknown): value is CodexTurn {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'status' in value &&
    typeof value.status === 'string' &&
    'items' in value &&
    Array.isArray(value.items) &&
    value.items.every(isCodexItem)
  )
}

// Approval item IDs are scoped to a thread and turn. Child thread projections
// also carry a flattened mirror; traverse turns only to avoid duplicate matches.
function approvalItemFromThread(
  thread: CodexThread | null,
  approval: CodexApproval
): CodexItem | undefined {
  if (!thread || typeof approval.params.itemId !== 'string') return undefined
  const threadId = approval.params.threadId ?? thread.id
  const turnId = approval.params.turnId
  if (
    typeof threadId !== 'string' ||
    (turnId !== undefined && typeof turnId !== 'string')
  ) {
    return undefined
  }
  const pending = [thread]
  const visited = new Set<string>()
  const matches: CodexItem[] = []
  for (const current of pending) {
    if (visited.has(current.id)) continue
    visited.add(current.id)
    for (const turn of current.turns) {
      if (
        current.id === threadId &&
        (turnId === undefined || turn.id === turnId)
      ) {
        matches.push(
          ...turn.items.filter((item) => item.id === approval.params.itemId)
        )
      }
      for (const item of turn.items) {
        if (
          item.type !== 'subagent' ||
          typeof item.threadId !== 'string' ||
          !Array.isArray(item.turns)
        ) {
          continue
        }
        pending.push({
          id: item.threadId,
          turns: item.turns.filter(isCodexTurn),
        })
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

// A revision replaces its edited turn and everything after it. Revisions after
// the requested position preserve that message, so they share one navigation
// option. The previous position identifies the branch prefix; unrelated earlier
// forks must never be presented as versions of the same message.
function messageBranchRevision(
  path: CodexProjectConversation[],
  turnIndex: number
): string | undefined {
  let revision = path[0]?.branch?.revisionId
  for (const entry of path.slice(1)) {
    if (
      entry.branch &&
      entry.branch.turnIndex !== undefined &&
      entry.branch.turnIndex <= turnIndex
    ) {
      revision = entry.branch.revisionId
    }
  }
  return revision
}
