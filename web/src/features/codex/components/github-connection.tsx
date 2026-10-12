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
import { Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FaGithub } from 'react-icons/fa'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { codexApi, codexError } from '../api'
import type { CodexGitHubStatus } from '../types'
import { Button } from '../vendor/zcode/button'

type GitHubConnectionProps = { actor: string; onChanged?: () => void }

export function GitHubConnection(props: GitHubConnectionProps) {
  return <GitHubConnectionContent key={props.actor} {...props} />
}

function GitHubConnectionContent(props: GitHubConnectionProps) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const queryKey = ['codex', 'github', props.actor]
  const connection = useQuery({
    queryKey,
    queryFn: ({ signal }) => codexApi.githubStatus(signal),
    staleTime: 30_000,
    retry: false,
  })
  const authorize = useMutation({
    mutationFn: async () => {
      const result = await codexApi.githubAuthorize()
      let url: URL
      try {
        url = new URL(result.url)
      } catch {
        throw new Error(
          'GitHub returned an invalid authorization link. Please try again.'
        )
      }
      if (
        url.origin !== 'https://github.com' ||
        url.pathname !== '/login/oauth/authorize' ||
        url.username ||
        url.password
      ) {
        throw new Error(
          'GitHub returned an invalid authorization link. Please try again.'
        )
      }
      return url.href
    },
  })
  const disconnect = useMutation({
    mutationFn: () => codexApi.githubDisconnect(),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey })
      client.setQueryData<CodexGitHubStatus>(queryKey, (current) =>
        current
          ? {
              ...current,
              connected: false,
              revocationPending: false,
              login: undefined,
              avatarUrl: undefined,
            }
          : current
      )
      setConfirmDisconnect(false)
      await client.invalidateQueries({ queryKey })
      props.onChanged?.()
    },
  })
  const data = connection.data
  const busy = authorize.isPending || disconnect.isPending || redirecting
  const capabilityLabels: Record<string, string> = {
    app_permissions: t('Permissions enabled for this GitHub App installation'),
    repositories: t('Read and write repositories and commits'),
    issues: t('Manage issues'),
    pull_requests: t('Create and update pull requests'),
    workflows: t('Update GitHub Actions workflows'),
  }
  const requestError =
    authorize.error || (!confirmDisconnect && disconnect.error)
  let status = t('GitHub not connected')
  if (data?.connected) status = t('GitHub connected')
  if (data?.revocationPending) status = t('GitHub disconnection pending')

  return (
    <section
      aria-label={t('GitHub connection')}
      className='bg-background min-w-0 overflow-hidden rounded-2xl border'
    >
      <div className='flex items-center justify-between gap-3 p-5'>
        <div className='flex min-w-0 items-center gap-3'>
          <span className='bg-muted flex size-11 shrink-0 items-center justify-center rounded-xl'>
            <FaGithub className='size-6' aria-hidden />
          </span>
          <div className='min-w-0'>
            <h3 className='text-base font-semibold'>GitHub</h3>
            {data?.connected && (
              <p className='text-muted-foreground mt-0.5 text-sm break-all'>
                {data.login ? `@${data.login}` : t('Connected account')}
              </p>
            )}
          </div>
        </div>
        <Button
          variant='ghost'
          size='icon'
          className='size-10 rounded-full'
          aria-label={t('Refresh GitHub connection')}
          disabled={connection.isFetching || busy}
          onClick={() => void connection.refetch()}
        >
          {connection.isFetching ? (
            <LoaderCircle className='size-4 animate-spin' aria-hidden />
          ) : (
            <RefreshCw className='size-4' aria-hidden />
          )}
        </Button>
      </div>

      <div className='space-y-5 px-5 pb-5'>
        {connection.isPending && (
          <p
            role='status'
            className='text-muted-foreground flex items-center gap-2 text-sm'
          >
            <LoaderCircle className='size-4 animate-spin' aria-hidden />
            {t('Loading GitHub connection...')}
          </p>
        )}
        {connection.isError && (
          <div className='space-y-3'>
            <p
              role='alert'
              className='text-destructive bg-destructive/5 rounded-xl p-3 text-sm break-words'
            >
              {t(codexError(connection.error))}
            </p>
            <Button
              variant='outline'
              className='h-10 rounded-full px-4 text-sm'
              disabled={connection.isFetching}
              onClick={() => void connection.refetch()}
            >
              {t('Retry GitHub connection')}
            </Button>
          </div>
        )}
        {data && (
          <>
            <p
              role='status'
              className='bg-muted inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium'
            >
              {data.connected && !data.revocationPending && (
                <Check
                  className='size-3.5 text-emerald-600 dark:text-emerald-400'
                  aria-hidden
                />
              )}
              {status}
            </p>
            <p className='text-muted-foreground text-sm leading-6'>
              {t(
                'Authorize Codex to work with your GitHub repositories, issues, pull requests, and workflows within the permissions you grant.'
              )}
            </p>
            {!data.configured && (
              <p className='bg-muted text-muted-foreground rounded-xl p-4 text-sm leading-6'>
                {t(
                  data.reason ||
                    'GitHub authorization has not been configured on this site yet.'
                )}
              </p>
            )}
            {data.configured && data.reason && (
              <p className='text-muted-foreground text-sm leading-6'>
                {t(data.reason)}
              </p>
            )}
            {data.capabilities.length > 0 && (
              <ul
                aria-label={t('GitHub permissions')}
                className='text-muted-foreground space-y-3 rounded-xl border p-4 text-sm'
              >
                {[...new Set(data.capabilities)].map((capability) => (
                  <li key={capability} className='flex items-start gap-2'>
                    <Check
                      className='text-foreground mt-0.5 size-4 shrink-0'
                      aria-hidden
                    />
                    <span>{capabilityLabels[capability] || capability}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.scopes.length > 0 && (
              <details className='text-muted-foreground text-sm'>
                <summary className='hover:text-foreground w-fit cursor-pointer rounded-md py-1'>
                  {data.connected
                    ? t('Granted GitHub scopes')
                    : t('Requested GitHub scopes')}
                </summary>
                <p className='bg-muted mt-2 rounded-lg px-3 py-2 font-mono text-xs break-words'>
                  {data.scopes.join(', ')}
                </p>
              </details>
            )}
            {requestError && (
              <p
                role='alert'
                className='text-destructive bg-destructive/5 rounded-xl p-3 text-sm break-words'
              >
                {t(codexError(requestError))}
              </p>
            )}
            <div className='flex flex-wrap items-center justify-end gap-2 border-t pt-4'>
              {data.connected || data.revocationPending ? (
                <Button
                  variant='outline'
                  className='h-10 rounded-full px-5 text-sm'
                  disabled={busy || connection.isError}
                  onClick={() => {
                    disconnect.reset()
                    setConfirmDisconnect(true)
                  }}
                >
                  {t('Disconnect GitHub')}
                </Button>
              ) : (
                <Button
                  className='h-10 gap-2 rounded-full px-5 text-sm'
                  disabled={!data.configured || busy || connection.isError}
                  onClick={() =>
                    authorize.mutate(undefined, {
                      onSuccess: (url) => {
                        window.location.assign(url)
                        setRedirecting(true)
                      },
                    })
                  }
                >
                  {authorize.isPending || redirecting ? (
                    <LoaderCircle
                      className='size-3.5 animate-spin'
                      aria-hidden
                    />
                  ) : (
                    <ExternalLink className='size-3.5' aria-hidden />
                  )}
                  {authorize.isPending || redirecting
                    ? t('Opening GitHub...')
                    : t('Connect GitHub')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog
        open={confirmDisconnect}
        onOpenChange={(open) => {
          if (!disconnect.isPending) setConfirmDisconnect(open)
        }}
      >
        <DialogContent
          className='codex-zcode codex-chatgpt chatgpt-dialog rounded-3xl p-6 sm:max-w-md'
          showCloseButton={!disconnect.isPending}
        >
          <DialogHeader>
            <DialogTitle className='font-sans text-xl'>
              {t('Disconnect GitHub?')}
            </DialogTitle>
            <DialogDescription className='text-sm leading-6'>
              {t(
                'Codex will lose access through this connection. Your repositories, project files, and conversations will be kept.'
              )}
            </DialogDescription>
          </DialogHeader>
          {disconnect.error && (
            <p
              role='alert'
              className='text-destructive bg-destructive/5 rounded-xl p-3 text-sm break-words'
            >
              {t(codexError(disconnect.error))}
            </p>
          )}
          <DialogFooter>
            <Button
              variant='outline'
              className='h-10 rounded-full px-5 text-sm'
              disabled={disconnect.isPending}
              onClick={() => setConfirmDisconnect(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant='destructive'
              className='h-10 gap-2 rounded-full px-5 text-sm'
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending && (
                <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
              )}
              {disconnect.isPending
                ? t('Disconnecting GitHub...')
                : t('Confirm disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
