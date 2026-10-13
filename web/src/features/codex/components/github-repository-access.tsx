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
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { CodexGitHubStatus } from '../types'
import { Button } from '../vendor/zcode/button'

export function GitHubRepositoryAccess(props: {
  actor?: string
  status: CodexGitHubStatus
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const queryKey = ['codex', 'github', props.actor]
  const refreshing = useIsFetching({ queryKey }) > 0
  const isApp =
    props.status.applicationType === 'github_app' ||
    props.status.capabilities.includes('app_permissions')
  if (!props.status.connected || props.status.revocationPending || !isApp) {
    return null
  }

  let accessUrl = 'https://github.com/settings/apps/authorizations'
  try {
    const url = new URL(props.status.repositoryAccessUrl ?? accessUrl)
    if (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '/settings/apps/authorizations' ||
        /^\/apps\/[a-z0-9][a-z0-9-]{0,99}\/installations\/new$/.test(
          url.pathname
        ))
    ) {
      accessUrl = url.href
    }
  } catch {
    // Older servers and unavailable installation links use GitHub's settings page.
  }

  return (
    <aside
      aria-label={t('GitHub repository access')}
      className='bg-muted/30 space-y-3 rounded-xl border p-3'
    >
      <p className='text-muted-foreground text-xs leading-5'>
        {t(
          'To access all your repositories, install this GitHub App on your account and choose All repositories.'
        )}
      </p>
      <div className='flex flex-wrap items-center gap-2'>
        <a
          href={accessUrl}
          target='_blank'
          rel='noopener noreferrer'
          className='border-border hover:bg-hover inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors'
        >
          <ExternalLink className='size-3.5' aria-hidden />
          {t('Grant repository access')}
        </a>
        <Button
          variant='ghost'
          className='h-9 gap-1.5 rounded-full px-3 text-xs'
          disabled={props.disabled || refreshing}
          onClick={() => void client.invalidateQueries({ queryKey })}
        >
          <RefreshCw
            className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'}
            aria-hidden
          />
          {t('Refresh repositories')}
        </Button>
      </div>
    </aside>
  )
}
