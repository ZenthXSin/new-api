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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowUp,
  Check,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { codexError } from '../api'
import { codexGitApi } from '../git-api'
import type { CodexGitResult } from '../git-types'
import { Button } from '../vendor/zcode/button'
import { LightweightDiffPreview } from '../vendor/zcode/inspector/lightweight-diff-preview'
import { parseUnifiedDiffLines } from '../vendor/zcode/inspector/patch-lines'
import { GitHubConnection } from './github-connection'

type GitAction = 'commit' | 'push' | 'pull-request'

type GitActionsPanelProps = {
  id: string
  actor: string
  running: boolean
  readOnly?: boolean
  onBusy?: (busy: boolean) => void
}

export function GitActionsPanel(props: GitActionsPanelProps) {
  return <GitActionsContent key={`${props.actor}:${props.id}`} {...props} />
}

function GitActionsContent(props: GitActionsPanelProps) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const formId = useId()
  const queryKey = ['codex', props.actor, props.id, 'git-status']
  const [action, setAction] = useState<GitAction | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [draft, setDraft] = useState(true)
  const [remote, setRemote] = useState('origin')
  const [expectedHead, setExpectedHead] = useState<string | null>(null)
  const [expectedStatusVersion, setExpectedStatusVersion] = useState('')
  const [lastResult, setLastResult] = useState<CodexGitResult | null>(null)
  const status = useQuery({
    queryKey,
    queryFn: ({ signal }) => codexGitApi.status(props.id, signal),
    retry: false,
    refetchInterval: props.running ? 5000 : false,
    refetchOnWindowFocus: action === null,
  })
  const data = status.data
  const mutation = useMutation({
    mutationFn: async (requestedAction: GitAction) => {
      if (props.running || props.readOnly) {
        throw new Error(
          'Wait for the task to finish or restore this project before changing Git history.'
        )
      }
      if (requestedAction === 'commit') {
        return codexGitApi.commit(props.id, {
          message: message.trim(),
          paths: selectedPaths,
          expectedHead,
          expectedStatusVersion,
        })
      }
      if (requestedAction === 'push') {
        return codexGitApi.push(props.id, { remote, expectedHead })
      }
      return codexGitApi.pullRequest(props.id, {
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
        remote,
        expectedHead,
      })
    },
    onSuccess: async (result) => {
      setLastResult(result)
      client.setQueryData(queryKey, result.status)
      setAction(null)
      if (result.commit) setMessage('')
      await client.invalidateQueries({
        queryKey: ['codex', props.actor],
      })
    },
    onError: () => {
      void client.invalidateQueries({ queryKey })
    },
  })
  const onBusy = props.onBusy
  useEffect(() => {
    onBusy?.(mutation.isPending)
    return () => onBusy?.(false)
  }, [mutation.isPending, onBusy])

  const disabled =
    props.running ||
    props.readOnly ||
    mutation.isPending ||
    status.isFetching ||
    status.isError
  const repositoryChanged =
    action !== null &&
    data !== undefined &&
    (data.head !== expectedHead ||
      (action === 'commit' && data.statusVersion !== expectedStatusVersion))
  const pathsChanged =
    action === 'commit' &&
    selectedPaths.some(
      (path) => !data?.files.some((file) => file.path === path)
    )
  let actionSupported = data?.pullRequestSupported
  if (action === 'commit') actionSupported = data?.commitSupported
  if (action === 'push') actionSupported = data?.pushSupported
  let formValid =
    !!title.trim() && !!base.trim() && base.trim() !== data?.branch
  if (action === 'commit') {
    formValid = !!message.trim() && selectedPaths.length > 0
  }
  if (action === 'push') formValid = !!remote

  const reasons: Record<string, string> = {
    not_repository: t(
      'Initialize Git in this project to commit and publish changes.'
    ),
    repository_busy: t(
      'Wait for the running task to finish before changing Git history.'
    ),
    repository_conflict: t(
      'Resolve merge conflicts in the project before continuing.'
    ),
    repository_changed: t(
      'The repository changed. Refresh the review before continuing.'
    ),
    operation_in_progress: t(
      'Finish the current merge or rebase before continuing.'
    ),
    detached_head: t('Check out a branch before publishing changes.'),
    no_changes: t('No uncommitted changes.'),
    github_auth_required: t(
      'Connect GitHub to publish this branch and create pull requests.'
    ),
    gh_unavailable: t(
      'Ask your administrator to install GitHub CLI in this environment to create pull requests.'
    ),
    remote_unsupported: t(
      'Add a GitHub.com remote in this project to publish changes.'
    ),
    no_remote: t('Add a GitHub.com remote in this project to publish changes.'),
    push_required: t('Push this branch before creating a pull request.'),
    dirty: t('Commit your remaining changes before creating a pull request.'),
  }
  let blockingReason =
    data?.commitReason || data?.pushReason || data?.pullRequestReason
  if (data?.commitSupported) {
    blockingReason = data.pushReason || data.pullRequestReason
  }
  if (props.running) blockingReason = 'repository_busy'
  if (props.readOnly) blockingReason = null
  const actionLabels: Record<GitAction, string> = {
    commit: t('Commit changes'),
    push: t('Push branch'),
    'pull-request': t('Create pull request'),
  }
  const pullRequest = lastResult?.pullRequest
  let pullRequestUrl: string | undefined
  if (pullRequest) {
    try {
      const url = new URL(pullRequest.url)
      if (
        url.origin === 'https://github.com' &&
        /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) &&
        !url.username &&
        !url.password
      ) {
        pullRequestUrl = url.href
      }
    } catch {
      /* An invalid remote URL must never become a navigable link. */
    }
  }

  async function openAction(next: GitAction) {
    if (!data || disabled) return
    mutation.reset()
    const refreshed = await status.refetch()
    if (refreshed.isError || !refreshed.data) return
    const latest = refreshed.data
    setExpectedHead(latest.head)
    setExpectedStatusVersion(latest.statusVersion)
    setSelectedPaths(latest.files.map((file) => file.path))
    const remotes = latest.publishRemotes ?? []
    setRemote(
      remotes.some((entry) => entry.name === 'origin')
        ? 'origin'
        : (remotes[0]?.name ?? '')
    )
    setBase(latest.defaultBranch ?? '')
    setAction(next)
  }

  return (
    <section
      className='codex-git-actions border-border bg-background shrink-0 border-t px-4 py-3'
      aria-label={t('Publish changes')}
    >
      <div className='flex min-w-0 items-center gap-2 text-xs'>
        <GitBranch
          className='text-foreground-subtle size-3.5 shrink-0'
          aria-hidden
        />
        <span
          className='min-w-0 flex-1 truncate font-medium'
          title={data?.branch ?? undefined}
        >
          {data?.branch || t('Git repository')}
        </span>
        {data?.available && (
          <span className='text-foreground-subtle shrink-0'>
            {t('{{count}} uncommitted', { count: data.files.length })}
          </span>
        )}
        <Button
          variant='ghost'
          size='icon-sm'
          className='focus-visible:outline-ring size-8 rounded-full focus-visible:outline-2'
          aria-label={t('Refresh Git status')}
          disabled={status.isFetching || mutation.isPending}
          onClick={() => void status.refetch()}
        >
          <RefreshCw
            className={status.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'}
            aria-hidden
          />
        </Button>
      </div>
      {status.isPending && (
        <p className='text-foreground-subtle py-2 text-xs'>
          {t('Checking repository...')}
        </p>
      )}
      {status.isError && (
        <p
          role='alert'
          className='text-destructive mt-2 flex items-start gap-2 text-xs leading-5'
        >
          <AlertCircle className='mt-0.5 size-3.5 shrink-0' aria-hidden />
          {t(codexError(status.error))}
        </p>
      )}
      {data && (
        <>
          {props.readOnly && (
            <p className='text-foreground-subtle mt-2 text-xs leading-5'>
              {t(
                'Restore this archived project or task to commit and publish changes.'
              )}
            </p>
          )}
          {blockingReason && (
            <p className='text-foreground-subtle mt-2 text-xs leading-5'>
              {reasons[blockingReason] || t(blockingReason)}
            </p>
          )}
          {(data.ahead !== null || data.behind !== null) && data.upstream && (
            <p className='text-foreground-subtle mt-1 text-xs'>
              {t('{{ahead}} ahead · {{behind}} behind {{upstream}}', {
                ahead: data.ahead ?? 0,
                behind: data.behind ?? 0,
                upstream: data.upstream,
                interpolation: { escapeValue: false },
              })}
            </p>
          )}
          <div className='mt-3 flex flex-wrap items-center gap-2'>
            <Button
              variant='outline'
              className='focus-visible:outline-ring h-9 gap-1.5 rounded-lg px-3 text-xs focus-visible:outline-2'
              disabled={disabled || !data.commitSupported || !data.files.length}
              onClick={() => openAction('commit')}
            >
              <GitCommitHorizontal className='size-3.5' aria-hidden />
              {t('Commit')}
            </Button>
            <Button
              variant='outline'
              className='focus-visible:outline-ring h-9 gap-1.5 rounded-lg px-3 text-xs focus-visible:outline-2'
              disabled={disabled || !data.pushSupported}
              onClick={() => openAction('push')}
            >
              <ArrowUp className='size-3.5' aria-hidden />
              {t('Push')}
            </Button>
            <Button
              className='focus-visible:outline-ring ml-auto h-9 gap-1.5 rounded-lg px-3 text-xs focus-visible:outline-2'
              disabled={disabled || !data.pullRequestSupported}
              onClick={() => openAction('pull-request')}
            >
              <GitPullRequest className='size-3.5' aria-hidden />
              {t('Create PR')}
            </Button>
          </div>
          {!data.githubAuthenticated && data.available && (
            <Button
              variant='link'
              className='mt-2 h-auto max-w-full px-0 py-1 text-xs whitespace-normal'
              onClick={() => setConnectionOpen(true)}
            >
              {t('Manage GitHub connection')}
            </Button>
          )}
        </>
      )}
      {lastResult?.commit && (
        <p role='status' className='mt-3 flex items-center gap-2 text-xs'>
          <Check className='text-diff-added size-3.5' aria-hidden />
          {t('Committed {{sha}}', { sha: lastResult.commit.sha.slice(0, 8) })}
        </p>
      )}
      {lastResult?.push && (
        <p role='status' className='mt-3 flex items-center gap-2 text-xs'>
          <Check className='text-diff-added size-3.5' aria-hidden />
          {t('Pushed {{branch}} to {{remote}}', {
            ...lastResult.push,
            interpolation: { escapeValue: false },
          })}
        </p>
      )}
      {pullRequestUrl && (
        <a
          className='text-foreground mt-3 inline-flex items-center gap-2 text-xs underline underline-offset-4'
          href={pullRequestUrl}
          target='_blank'
          rel='noopener noreferrer'
        >
          {t('Open pull request #{{number}}', { number: pullRequest?.number })}
          <ExternalLink className='size-3.5' aria-hidden />
        </a>
      )}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setAction(null)
        }}
      >
        <DialogContent
          className='codex-zcode codex-chatgpt chatgpt-dialog max-h-[calc(100dvh-2rem)] overflow-auto rounded-2xl p-6 sm:max-w-lg'
          showCloseButton={!mutation.isPending}
        >
          <DialogHeader>
            <DialogTitle>
              {action ? actionLabels[action] : t('Publish changes')}
            </DialogTitle>
            <DialogDescription>
              {action === 'commit'
                ? t(
                    'Review the selected files and save a commit to this branch.'
                  )
                : t(
                    'Review the repository and branch before publishing to GitHub.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <div className='bg-surface flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm'>
            <GitBranch className='size-4 shrink-0' aria-hidden />
            <span className='min-w-0 flex-1 truncate'>
              {data?.branch || t('Detached HEAD')}
            </span>
            <code className='text-foreground-subtle text-xs'>
              {expectedHead?.slice(0, 8)}
            </code>
          </div>
          <form
            id={formId}
            className='space-y-4'
            onSubmit={(event) => {
              event.preventDefault()
              if (
                action &&
                formValid &&
                actionSupported &&
                !disabled &&
                !repositoryChanged &&
                !pathsChanged
              ) {
                mutation.mutate(action)
              }
            }}
          >
            {action === 'commit' && (
              <>
                <label className='block space-y-2 text-sm'>
                  <span className='font-medium'>{t('Commit message')}</span>
                  <textarea
                    className='border-border bg-background focus-visible:outline-ring min-h-24 w-full resize-y rounded-lg border px-3 py-2 text-sm focus-visible:outline-2'
                    value={message}
                    required
                    maxLength={4000}
                    disabled={mutation.isPending}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder={t('Describe these changes')}
                  />
                </label>
                <fieldset className='space-y-2' disabled={mutation.isPending}>
                  <legend className='mb-2 text-sm font-medium'>
                    {t('Files to commit')}
                  </legend>
                  <div className='max-h-48 space-y-1 overflow-auto rounded-lg border p-2'>
                    {data?.files.map((file) => (
                      <label
                        className='hover:bg-hover flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-xs'
                        key={file.path}
                      >
                        <input
                          type='checkbox'
                          checked={selectedPaths.includes(file.path)}
                          onChange={(event) =>
                            setSelectedPaths((current) =>
                              event.target.checked
                                ? [...current, file.path]
                                : current.filter((path) => path !== file.path)
                            )
                          }
                        />
                        <span className='min-w-0 flex-1 break-all'>
                          {file.path}
                        </span>
                        <span className='text-foreground-subtle font-mono'>
                          {file.status}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {!!data?.diff && (
                  <details className='rounded-lg border'>
                    <summary className='cursor-pointer px-3 py-2 text-sm font-medium'>
                      {t('Review uncommitted diff')}
                    </summary>
                    <LightweightDiffPreview
                      className='max-h-56 border-t py-2'
                      lines={parseUnifiedDiffLines(data.diff).lines}
                      lineNumbers={parseUnifiedDiffLines(data.diff).lineNumbers}
                      codePreviewSettings={{
                        fontSizePx: 12,
                        showLineNumbers: true,
                        wrapLongLines: false,
                      }}
                    />
                  </details>
                )}
                {data?.truncated && (
                  <p className='text-foreground-subtle text-xs leading-5'>
                    {t(
                      'The uncommitted diff is truncated. Inspect the selected files before committing.'
                    )}
                  </p>
                )}

                <p className='text-foreground-subtle text-xs leading-5'>
                  {t(
                    'Each selected file is committed with its current saved contents. Unselected files stay unchanged.'
                  )}
                </p>
              </>
            )}
            {action && action !== 'commit' && (
              <label className='block space-y-2 text-sm'>
                <span className='font-medium'>{t('Remote')}</span>
                <select
                  value={remote}
                  disabled={mutation.isPending}
                  onChange={(event) => setRemote(event.target.value)}
                  className='border-border bg-background focus-visible:outline-ring w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline-2'
                >
                  {data?.publishRemotes?.map((entry) => (
                    <option value={entry.name} key={entry.name}>
                      {entry.name}
                      {entry.url ? ` · ${entry.url}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {action === 'push' && (
              <p className='text-foreground-subtle text-sm leading-6'>
                {t(
                  'Push the existing commits on this branch to the selected remote. This updates the remote branch and does not create a pull request.'
                )}
              </p>
            )}
            {action === 'pull-request' && (
              <>
                <label className='block space-y-2 text-sm'>
                  <span className='font-medium'>{t('Pull request title')}</span>
                  <input
                    className='border-border bg-background focus-visible:outline-ring w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline-2'
                    value={title}
                    required
                    maxLength={250}
                    disabled={mutation.isPending}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label className='block space-y-2 text-sm'>
                  <span className='font-medium'>{t('Base branch')}</span>
                  <input
                    className='border-border bg-background focus-visible:outline-ring w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline-2'
                    value={base}
                    required
                    disabled={mutation.isPending}
                    placeholder={t('Choose the branch to merge into')}
                    onChange={(event) => setBase(event.target.value)}
                  />
                </label>
                <label className='block space-y-2 text-sm'>
                  <span className='font-medium'>{t('Description')}</span>
                  <textarea
                    className='border-border bg-background focus-visible:outline-ring min-h-24 w-full resize-y rounded-lg border px-3 py-2 text-sm focus-visible:outline-2'
                    value={body}
                    maxLength={65536}
                    disabled={mutation.isPending}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
                <label className='flex items-center gap-2 text-sm'>
                  <input
                    type='checkbox'
                    checked={draft}
                    disabled={mutation.isPending}
                    onChange={(event) => setDraft(event.target.checked)}
                  />
                  {t('Create as draft')}
                </label>
                <p className='text-foreground-subtle text-xs leading-5'>
                  {t(
                    'This creates a pull request for commits already pushed to GitHub. It does not push or merge your branch.'
                  )}
                </p>
              </>
            )}
          </form>
          {(repositoryChanged || pathsChanged) && (
            <div
              role='alert'
              className='space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm'
            >
              <p>
                {t(
                  'The repository changed. Refresh the review before continuing.'
                )}
              </p>
              <Button
                variant='outline'
                disabled={status.isFetching}
                onClick={() => {
                  if (data) {
                    setExpectedHead(data.head)
                    setExpectedStatusVersion(data.statusVersion)
                    setSelectedPaths(data.files.map((file) => file.path))
                    mutation.reset()
                  }
                }}
              >
                {t('Review latest changes')}
              </Button>
            </div>
          )}
          {mutation.isError && (
            <p
              role='alert'
              className='text-destructive border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-sm break-words'
            >
              {t(codexError(mutation.error))}
            </p>
          )}
          {props.running && (
            <p role='status' className='text-foreground-subtle text-sm'>
              {t(
                'Wait for the running task to finish before changing Git history.'
              )}
            </p>
          )}
          <DialogFooter className='-mx-6 mt-1 -mb-6 rounded-b-2xl px-6'>
            <Button
              variant='outline'
              className='h-9 rounded-lg px-4'
              disabled={mutation.isPending}
              onClick={() => setAction(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='submit'
              form={formId}
              className='h-9 gap-2 rounded-lg px-4'
              disabled={
                disabled ||
                !formValid ||
                !actionSupported ||
                repositoryChanged ||
                pathsChanged
              }
            >
              {mutation.isPending && (
                <LoaderCircle className='size-4 animate-spin' aria-hidden />
              )}
              {action ? actionLabels[action] : t('Continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
        <DialogContent className='codex-zcode codex-chatgpt chatgpt-dialog max-h-[calc(100dvh-2rem)] overflow-auto rounded-2xl p-6 sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>{t('GitHub connection')}</DialogTitle>
            <DialogDescription>
              {t(
                'Connect an account with access to this repository to publish changes.'
              )}
            </DialogDescription>
          </DialogHeader>
          <GitHubConnection
            actor={props.actor}
            onChanged={() => void status.refetch()}
          />
        </DialogContent>
      </Dialog>
    </section>
  )
}
