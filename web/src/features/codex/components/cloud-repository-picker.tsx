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
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { GitBranch, LoaderCircle, LockKeyhole, Search } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FaGithub } from 'react-icons/fa'

import { codexApi, codexError } from '../api'
import type { CodexGitHubRepository } from '../types'
import { Button } from '../vendor/zcode/button'
import { GitHubConnection } from './github-connection'
import { GitHubRepositoryAccess } from './github-repository-access'

type CloudRepositoryPickerProps = {
  actor?: string
  value: CodexGitHubRepository[]
  onChange: (repositories: CodexGitHubRepository[]) => void
  disabled?: boolean
  onManageConnection?: () => void
}

export function CloudRepositoryPicker(props: CloudRepositoryPickerProps) {
  return <CloudRepositoryPickerContent key={props.actor ?? ''} {...props} />
}

function CloudRepositoryPickerContent(props: CloudRepositoryPickerProps) {
  const { t } = useTranslation()
  const searchId = useId()
  const [search, setSearch] = useState('')
  const actor = props.actor ?? ''
  const connection = useQuery({
    queryKey: ['codex', 'github', actor],
    queryFn: ({ signal }) => codexApi.githubStatus(signal),
    staleTime: 30_000,
    retry: false,
  })
  const connected =
    connection.isSuccess &&
    connection.data.configured &&
    connection.data.connected &&
    !connection.data.revocationPending
  const repositories = useInfiniteQuery({
    queryKey: [
      'codex',
      'github',
      actor,
      'repositories',
      'cloud',
      connection.data?.login ?? '',
    ],
    queryFn: ({ pageParam, signal }) =>
      codexApi.githubRepositories(pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (page, _pages, pageParam) =>
      page.hasMore ? pageParam + 1 : undefined,
    enabled: connected,
    retry: false,
  })
  const selectedIds = new Set(props.value.map((repository) => repository.id))
  const loadedRepositories = [
    ...new Map(
      repositories.data?.pages.flatMap((page) =>
        page.repositories.map(
          (repository) => [repository.id, repository] as const
        )
      )
    ).values(),
  ]
  const matchingRepositories = loadedRepositories.filter((repository) =>
    repository.fullName
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  )
  const selectedMatches = matchingRepositories.filter((repository) =>
    selectedIds.has(repository.id)
  ).length
  const allMatchesSelected =
    matchingRepositories.length > 0 &&
    selectedMatches === matchingRepositories.length

  return (
    <fieldset disabled={props.disabled} className='min-w-0 space-y-3'>
      <legend className='mb-3 text-sm font-medium'>{t('Repositories')}</legend>
      {connection.isPending && (
        <p
          role='status'
          className='text-muted-foreground flex items-center gap-2 py-5 text-sm'
        >
          <LoaderCircle className='size-4 animate-spin' aria-hidden />
          {t('Loading GitHub connection...')}
        </p>
      )}
      {connection.isError && (
        <div className='space-y-3 rounded-xl border p-4'>
          <p role='alert' className='text-destructive text-sm break-words'>
            {t(codexError(connection.error))}
          </p>
          <Button
            variant='outline'
            className='h-9 rounded-full px-4 text-sm'
            disabled={props.disabled || connection.isFetching}
            onClick={() => void connection.refetch()}
          >
            {t('Retry GitHub connection')}
          </Button>
        </div>
      )}
      {connection.isSuccess &&
        !connected &&
        (props.onManageConnection ? (
          <div className='space-y-3 rounded-xl border p-4'>
            <p className='text-muted-foreground text-sm leading-6'>
              {t('Connect GitHub to choose repositories for this environment.')}
            </p>
            {connection.data.reason && (
              <p className='text-muted-foreground text-sm'>
                {t(connection.data.reason)}
              </p>
            )}
            <Button
              variant='outline'
              className='h-9 gap-2 rounded-full px-4 text-sm'
              disabled={props.disabled}
              onClick={props.onManageConnection}
            >
              <FaGithub className='size-4' aria-hidden />
              {t('Manage GitHub connection')}
            </Button>
          </div>
        ) : (
          <GitHubConnection actor={actor} />
        ))}
      {connected && (
        <>
          <GitHubRepositoryAccess
            actor={actor}
            status={connection.data}
            disabled={props.disabled}
          />
          <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
            <span className='flex min-w-0 items-center gap-2'>
              <FaGithub className='size-4 shrink-0' aria-hidden />
              <span className='truncate'>
                {connection.data.login || t('Connected account')}
              </span>
            </span>
            {props.onManageConnection && (
              <Button
                variant='ghost'
                className='h-8 rounded-full px-3 text-xs'
                disabled={props.disabled}
                onClick={props.onManageConnection}
              >
                {t('Manage GitHub connection')}
              </Button>
            )}
          </div>
          <div className='overflow-hidden rounded-xl border'>
            <label
              htmlFor={searchId}
              className='flex items-center gap-2 border-b px-4'
            >
              <Search
                className='text-muted-foreground size-4 shrink-0'
                aria-hidden
              />
              <input
                id={searchId}
                type='search'
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                disabled={props.disabled}
                aria-label={t('Search repositories')}
                placeholder={t('Search repositories')}
                className='placeholder:text-muted-foreground focus-visible:ring-ring min-w-0 flex-1 bg-transparent py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset'
              />
            </label>
            <div className='bg-muted/30 flex items-center justify-between gap-3 border-b px-4 py-3'>
              <label className='flex items-center gap-3 text-sm'>
                <input
                  type='checkbox'
                  className='accent-foreground border-input focus-visible:ring-ring size-4 shrink-0 cursor-pointer rounded border focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50'
                  checked={allMatchesSelected}
                  ref={(element) => {
                    if (element) {
                      element.indeterminate =
                        selectedMatches > 0 && !allMatchesSelected
                    }
                  }}
                  disabled={
                    props.disabled ||
                    matchingRepositories.length === 0 ||
                    repositories.isFetching
                  }
                  aria-label={t('Select all matching repositories')}
                  onChange={(event) => {
                    const checked = event.target.checked
                    if (props.disabled) return
                    const matchingIds = new Set(
                      matchingRepositories.map((repository) => repository.id)
                    )
                    props.onChange(
                      checked
                        ? [
                            ...props.value,
                            ...matchingRepositories.filter(
                              (repository) => !selectedIds.has(repository.id)
                            ),
                          ]
                        : props.value.filter(
                            (repository) => !matchingIds.has(repository.id)
                          )
                    )
                  }}
                />
                {t('Select all')}
              </label>
              <span
                role='status'
                className='text-muted-foreground text-xs whitespace-nowrap'
              >
                {t('{{count}} selected', { count: selectedIds.size })}
              </span>
            </div>
            {repositories.isPending && (
              <p
                role='status'
                className='text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm'
              >
                <LoaderCircle className='size-4 animate-spin' aria-hidden />
                {t('Loading repositories...')}
              </p>
            )}
            {matchingRepositories.length > 0 && (
              <ul
                aria-label={t('Available repositories')}
                className='max-h-72 overflow-y-auto overscroll-contain p-1'
              >
                {matchingRepositories.map((repository) => (
                  <li key={repository.id}>
                    <label className='hover:bg-muted/60 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 has-disabled:cursor-default has-disabled:opacity-60'>
                      <input
                        type='checkbox'
                        className='accent-foreground border-input focus-visible:ring-ring size-4 shrink-0 cursor-pointer rounded border focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50'
                        checked={selectedIds.has(repository.id)}
                        disabled={props.disabled}
                        aria-label={repository.fullName}
                        onChange={(event) => {
                          const checked = event.target.checked
                          if (props.disabled) return
                          props.onChange(
                            checked
                              ? [...props.value, repository]
                              : props.value.filter(
                                  (entry) => entry.id !== repository.id
                                )
                          )
                        }}
                      />
                      <span className='min-w-0 flex-1'>
                        <span className='flex min-w-0 items-center gap-2 text-sm'>
                          <span
                            className='truncate'
                            title={repository.fullName}
                          >
                            {repository.fullName}
                          </span>
                          {repository.private && (
                            <LockKeyhole
                              aria-label={t('Private repository')}
                              className='text-muted-foreground size-3.5 shrink-0'
                            />
                          )}
                        </span>
                        <span className='text-muted-foreground mt-1 flex items-center gap-1 text-xs'>
                          <GitBranch className='size-3 shrink-0' aria-hidden />
                          <span className='truncate'>
                            {repository.defaultBranch}
                          </span>
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {!repositories.isPending &&
              !repositories.isError &&
              matchingRepositories.length === 0 && (
                <p className='text-muted-foreground px-4 py-8 text-center text-sm'>
                  {search.trim()
                    ? t('No matching repositories')
                    : t('No repositories available')}
                </p>
              )}
            {repositories.isError && (
              <div className='space-y-3 p-4'>
                <p
                  role='alert'
                  className='text-destructive text-sm break-words'
                >
                  {t(codexError(repositories.error))}
                </p>
                <Button
                  variant='outline'
                  className='h-9 rounded-full px-4 text-sm'
                  disabled={props.disabled || repositories.isFetching}
                  onClick={() => {
                    if (repositories.isFetchNextPageError) {
                      void repositories.fetchNextPage()
                    } else void repositories.refetch()
                  }}
                >
                  {t('Retry loading repositories')}
                </Button>
              </div>
            )}
            {repositories.hasNextPage && !repositories.isError && (
              <div className='space-y-2 border-t px-4 py-3'>
                {search.trim() && (
                  <p className='text-muted-foreground text-xs leading-5'>
                    {t(
                      'Search includes loaded repositories. Load more to search the rest.'
                    )}
                  </p>
                )}
                <Button
                  variant='ghost'
                  className='h-9 w-full gap-2 rounded-lg text-sm'
                  disabled={props.disabled || repositories.isFetching}
                  onClick={() => void repositories.fetchNextPage()}
                >
                  {repositories.isFetchingNextPage && (
                    <LoaderCircle className='size-4 animate-spin' aria-hidden />
                  )}
                  {repositories.isFetchingNextPage
                    ? t('Loading repositories...')
                    : t('Load more repositories')}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </fieldset>
  )
}
