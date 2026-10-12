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
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import { codexApi, codexError } from '../api'
import { codexPullRequestApi, pullRequestExternalUrl } from '../pr-api'
import type {
  CodexPullRequestReviewEvent,
  CodexPullRequestTarget,
} from '../pr-types'
import { Button } from '../vendor/zcode/button'

export function PullRequestPanel(props: {
  actor: string
  model: string
  group?: string
  effort: string
  onManageConnection: () => void
  onSelect: (id: string, conversationId?: string) => void
}) {
  return <PullRequestContent key={props.actor} {...props} />
}
function PullRequestContent(props: {
  actor: string
  model: string
  group?: string
  effort: string
  onManageConnection: () => void
  onSelect: (id: string, conversationId?: string) => void
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)
  const [target, setTarget] = useState<CodexPullRequestTarget | null>(null)
  const [tab, setTab] = useState<'overview' | 'files' | 'activity'>('overview')
  const [message, setMessage] = useState('')
  const [instruction, setInstruction] = useState('')
  const requestId = useRef<{ key: string; id: string } | null>(null)
  const connection = useQuery({
    queryKey: ['codex', props.actor, 'github'],
    queryFn: ({ signal }) => codexApi.githubStatus(signal),
  })
  const list = useQuery({
    queryKey: ['codex', props.actor, 'pulls', filter, page],
    enabled: connection.data?.connected === true && !target,
    queryFn: ({ signal }) =>
      codexPullRequestApi.list({ search: filter, state: 'open', page }, signal),
  })
  const detail = useQuery({
    queryKey: ['codex', props.actor, 'pull', target],
    enabled: !!target,
    queryFn: ({ signal }) => {
      if (!target) throw new Error('No pull request selected')
      return codexPullRequestApi.detail(target, signal)
    },
  })
  const send = useMutation({
    mutationFn: async (event: 'comment' | CodexPullRequestReviewEvent) => {
      if (!target || !detail.data?.pullRequest.head)
        throw new Error(t('Refresh the pull request before continuing.'))
      if (event === 'comment')
        await codexPullRequestApi.comment(target, message)
      else
        await codexPullRequestApi.review(target, {
          body: message,
          event,
          commitId: detail.data.pullRequest.head.sha,
        })
    },
    onSuccess: () => {
      setMessage('')
      void detail.refetch()
    },
  })
  const task = useMutation({
    mutationFn: async () => {
      if (!target || !detail.data?.pullRequest.head)
        throw new Error(t('Refresh the pull request before continuing.'))
      const key = JSON.stringify([
        target,
        detail.data.pullRequest.head.sha,
        instruction,
        props.model,
        props.group,
        props.effort,
      ])
      if (requestId.current?.key !== key)
        requestId.current = { key, id: crypto.randomUUID() }
      return codexPullRequestApi.task(target, {
        requestId: requestId.current.id,
        instruction,
        mode: 'review',
        model: props.model,
        group: props.group,
        effort: props.effort,
        expectedHead: detail.data.pullRequest.head.sha,
      })
    },
    onSuccess: (result) =>
      props.onSelect(result.workspaceId, result.conversationId),
  })
  const busy = task.isPending || send.isPending
  if (connection.isPending) return <p role='status'>{t('Loading...')}</p>
  if (!connection.data?.connected)
    return (
      <div className='flex flex-col items-center gap-4 py-12'>
        <GitPullRequest className='size-8' />
        <p>
          {connection.isError
            ? codexError(connection.error)
            : t('Connect GitHub to review pull requests.')}
        </p>
        <Button onClick={props.onManageConnection}>
          {t('Connect GitHub')}
        </Button>
      </div>
    )
  if (!target) {
    return (
      <div className='space-y-4'>
        <form
          className='flex gap-2'
          onSubmit={(event) => {
            event.preventDefault()
            setFilter(search)
            setPage(1)
          }}
        >
          <Input
            aria-label={t('Search pull requests')}
            placeholder={t('Search pull requests')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type='submit'>{t('Search')}</Button>
          <Button
            type='button'
            aria-label={t('Refresh')}
            onClick={() => void list.refetch()}
          >
            <RefreshCw className='size-4' />
          </Button>
        </form>
        {list.isPending && <p role='status'>{t('Loading...')}</p>}
        {list.isError && <p role='alert'>{codexError(list.error)}</p>}
        <div className='divide-y rounded-xl border'>
          {list.data?.pullRequests.map((pr) => (
            <button
              type='button'
              key={`${pr.repository}:${pr.number}`}
              className='hover:bg-muted flex w-full min-w-0 gap-3 p-4 text-left'
              onClick={() => {
                setTarget({ repository: pr.repository, number: pr.number })
                setTab('overview')
              }}
            >
              <GitPullRequest className='mt-1 size-4 shrink-0' />
              <span className='min-w-0'>
                <strong className='block break-words'>{pr.title}</strong>
                <span className='text-muted-foreground text-xs'>
                  {pr.repository} #{pr.number} · {pr.author.login}
                </span>
              </span>
            </button>
          ))}
        </div>
        {list.data?.pullRequests.length === 0 && (
          <p className='text-muted-foreground py-8 text-center'>
            {t('No pull requests found.')}
          </p>
        )}
        <div className='flex justify-end gap-2'>
          <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
            {t('Previous')}
          </Button>
          <Button
            disabled={!list.data?.hasMore}
            onClick={() => setPage(page + 1)}
          >
            {t('Next')}
          </Button>
        </div>
      </div>
    )
  }
  const pr = detail.data?.pullRequest
  const external = pr ? pullRequestExternalUrl(pr.url) : undefined
  return (
    <div className='space-y-4'>
      <div className='flex items-center gap-2'>
        <Button
          disabled={busy}
          onClick={() => {
            setTarget(null)
            setMessage('')
            setInstruction('')
            send.reset()
            task.reset()
          }}
        >
          <ArrowLeft className='size-4' />
          {t('Back')}
        </Button>
        <span className='min-w-0 flex-1 truncate text-sm'>
          {target.repository} #{target.number}
        </span>
        {external && (
          <a
            href={external}
            target='_blank'
            rel='noreferrer'
            className='text-sm underline'
          >
            {t('Open in GitHub')} <ExternalLink className='inline size-3' />
          </a>
        )}
      </div>
      {detail.isPending && <p role='status'>{t('Loading...')}</p>}
      {detail.isError && (
        <div role='alert'>
          {codexError(detail.error)}{' '}
          <Button onClick={() => void detail.refetch()}>{t('Retry')}</Button>
        </div>
      )}
      {pr && detail.data && (
        <>
          <h2 className='text-xl font-semibold'>{pr.title}</h2>
          <p className='text-muted-foreground text-xs'>
            {pr.head?.ref} → {pr.base?.ref} · +{pr.additions} −{pr.deletions}
          </p>
          <div
            className='flex gap-2'
            role='tablist'
            aria-label={t('Pull request details')}
          >
            {(
              [
                { id: 'overview', label: 'Overview' },
                { id: 'files', label: 'Files' },
                { id: 'activity', label: 'Activity' },
              ] as const
            ).map((item) => (
              <Button
                key={item.id}
                role='tab'
                aria-selected={tab === item.id}
                variant={tab === item.id ? 'default' : 'ghost'}
                onClick={() => setTab(item.id)}
              >
                {t(item.label)}
              </Button>
            ))}
          </div>
          <div
            role='tabpanel'
            className='max-h-[40dvh] overflow-auto rounded-xl border p-4'
          >
            {tab === 'overview' && (
              <>
                <p className='break-words whitespace-pre-wrap'>
                  {pr.body || t('No description.')}
                </p>
                <h3 className='mt-6 font-medium'>{t('Checks')}</h3>
                {detail.data.checks.map((check) => (
                  <p key={check.id} className='py-2 text-sm'>
                    {check.name} · {check.conclusion || check.status}
                  </p>
                ))}
              </>
            )}
            {tab === 'files' &&
              detail.data.files.map((file) => (
                <details key={file.path} className='border-b py-3'>
                  <summary className='cursor-pointer text-sm break-all'>
                    {file.path}{' '}
                    <span className='text-muted-foreground'>
                      +{file.additions} −{file.deletions}
                    </span>
                  </summary>
                  <pre className='mt-3 overflow-x-auto text-xs'>
                    {file.patch || t('No inline diff is available.')}
                  </pre>
                  {file.patchTruncated && (
                    <p>
                      {t(
                        'Diff truncated. Open in GitHub for the complete change.'
                      )}
                    </p>
                  )}
                </details>
              ))}
            {tab === 'activity' && (
              <>
                {detail.data.comments.map((comment) => (
                  <article key={comment.id} className='border-b py-3'>
                    <strong className='text-sm'>{comment.author.login}</strong>
                    <p className='text-sm break-words whitespace-pre-wrap'>
                      {comment.body}
                    </p>
                  </article>
                ))}
                {detail.data.reviews.map((review) => (
                  <article key={review.id} className='border-b py-3'>
                    <strong className='text-sm'>
                      {review.author.login} · {review.state}
                    </strong>
                    <p className='text-sm break-words whitespace-pre-wrap'>
                      {review.body}
                    </p>
                  </article>
                ))}
              </>
            )}
          </div>
          {detail.data.warnings.map((warning) => (
            <p
              key={warning}
              role='status'
              className='text-muted-foreground text-xs'
            >
              {warning}
            </p>
          ))}
          <div className='space-y-2'>
            <Textarea
              aria-label={t('Review instructions')}
              placeholder={t('Ask Codex to review or explain these changes')}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              maxLength={10000}
            />
            <Button
              disabled={busy || !props.model}
              onClick={() => task.mutate()}
            >
              {task.isPending ? t('Starting...') : t('Review with Codex')}
            </Button>
            {task.isError && <p role='alert'>{codexError(task.error)}</p>}
          </div>
          <details className='rounded-xl border p-4'>
            <summary className='cursor-pointer text-sm font-medium'>
              {t('Submit a comment or review to GitHub')}
            </summary>
            <Textarea
              className='my-3'
              aria-label={t('Review message')}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={60000}
            />
            <div className='flex flex-wrap gap-2'>
              {(
                [
                  { event: 'comment', label: 'Post comment' },
                  { event: 'COMMENT', label: 'Submit review' },
                  { event: 'APPROVE', label: 'Approve pull request' },
                  { event: 'REQUEST_CHANGES', label: 'Request changes' },
                ] as const
              ).map((action) => (
                <Button
                  key={action.event}
                  disabled={
                    busy || (!message.trim() && action.event !== 'APPROVE')
                  }
                  variant='outline'
                  onClick={() => {
                    if (window.confirm(t('Send this review to GitHub?')))
                      send.mutate(action.event)
                  }}
                >
                  {t(action.label)}
                </Button>
              ))}
            </div>
            {send.isError && <p role='alert'>{codexError(send.error)}</p>}
            {send.isSuccess && <p role='status'>{t('Review submitted')}</p>}
          </details>
        </>
      )}
    </div>
  )
}
