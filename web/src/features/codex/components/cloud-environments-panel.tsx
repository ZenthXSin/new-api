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
import { Menu } from '@base-ui/react/menu'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Cloud,
  Container,
  Ellipsis,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
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
import { cloudApi, cloudEnvironmentQueryKey } from '../cloud-api'
import type { CloudEnvironment, CloudEnvironmentStatus } from '../cloud-types'
import type { CodexGitHubRepository } from '../types'
import { Button } from '../vendor/zcode/button'
import { CloudEnvironmentEditor } from './cloud-environment-editor'
import { CloudRepositoryPicker } from './cloud-repository-picker'

export function CloudEnvironmentsPanel(props: {
  actor?: string
  onStartTask: (environment: CloudEnvironment) => void
  onClose?: () => void
  onManageDocker?: () => void
  initialCreate?: boolean
}) {
  return <CloudEnvironmentsContent key={props.actor ?? 'current'} {...props} />
}

function CloudEnvironmentsContent(props: {
  actor?: string
  onStartTask: (environment: CloudEnvironment) => void
  onClose?: () => void
  onManageDocker?: () => void
  initialCreate?: boolean
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'environments' | 'vault'>('environments')
  const [creating, setCreating] = useState(props.initialCreate ?? false)
  const [repositories, setRepositories] = useState<CodexGitHubRepository[]>([])
  const [editing, setEditing] = useState<CloudEnvironment | null>(null)
  const [deleting, setDeleting] = useState<CloudEnvironment | null>(null)
  const environments = useQuery({
    queryKey: cloudEnvironmentQueryKey(props.actor),
    queryFn: ({ signal }) => cloudApi.list(signal),
    staleTime: 15_000,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.environments.some(
        (environment) => environment.status === 'preparing'
      )
        ? 1500
        : false,
  })
  const create = useMutation({
    mutationFn: () =>
      cloudApi.create({
        name:
          repositories.length === 1
            ? repositories[0].name
            : t('Development environment'),
        description: '',
        config: {
          repositories: repositories.map((repository) => ({
            url: repository.cloneUrl,
            branch: repository.defaultBranch,
            path: repository.fullName.replaceAll('/', '-'),
          })),
          installScript: '',
          startSkill: '',
          internetAccess: 'enabled',
          allowedDomains: [],
          networkSecrets: [],
          environmentVariables: [],
          privacy: 'private',
          advanced: { setupTimeoutSeconds: 600 },
        },
      }),
    onSuccess: async (result) => {
      setCreating(false)
      setRepositories([])
      setEditing(result.environment)
      await client.invalidateQueries({
        queryKey: cloudEnvironmentQueryKey(props.actor),
      })
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => cloudApi.remove(id),
    onSuccess: async () => {
      setDeleting(null)
      await client.invalidateQueries({
        queryKey: cloudEnvironmentQueryKey(props.actor),
      })
    },
  })
  const labels: Record<CloudEnvironmentStatus, string> = {
    draft: t('Draft'),
    ready: t('Ready to publish'),
    published: t('Published'),
    changes_pending: t('Unpublished changes'),
    preparing: t('Preparing'),
    publishing: t('Publishing'),
    error: t('Setup failed'),
  }
  const list = environments.data?.environments ?? []
  const filtered = list.filter((environment) =>
    `${environment.name} ${environment.description} ${environment.config.repositories.map((repository) => repository.url).join(' ')}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
  )
  const maxRepositories =
    environments.data?.capabilities?.limits.maxRepositories ?? 10

  if (editing) {
    return (
      <CloudEnvironmentEditor
        key={editing.id}
        actor={props.actor}
        environment={editing}
        capabilities={environments.data?.capabilities}
        onBack={() => setEditing(null)}
        onStartTask={props.onStartTask}
      />
    )
  }

  return (
    <section
      aria-label={t('Codex Cloud')}
      className='codex-cloud-settings min-w-0 space-y-6'
    >
      <header className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-xl font-semibold'>{t('Codex Cloud')}</h2>
          <p className='text-muted-foreground mt-2 max-w-2xl text-sm leading-6'>
            {t(
              'Prepare reusable environments, publish a version, and start each task in its own workspace.'
            )}
          </p>
          <p className='text-muted-foreground mt-1 text-xs'>
            {t('Environments run on this site’s Docker infrastructure.')}
          </p>
        </div>
        {props.onManageDocker && (
          <Button
            type='button'
            variant='outline'
            className='h-9 gap-2 rounded-full px-4 text-sm'
            onClick={props.onManageDocker}
          >
            <Container className='size-4' aria-hidden />
            {t('Manage Docker')}
          </Button>
        )}
      </header>
      <div
        className='flex gap-5 border-b'
        role='group'
        aria-label={t('Cloud settings sections')}
      >
        <button
          type='button'
          aria-pressed={tab === 'environments'}
          className='text-muted-foreground aria-pressed:border-foreground aria-pressed:text-foreground border-b-2 border-transparent px-1 pb-3 text-sm'
          onClick={() => setTab('environments')}
        >
          {t('Environments')}
        </button>
        <button
          type='button'
          aria-pressed={tab === 'vault'}
          className='text-muted-foreground aria-pressed:border-foreground aria-pressed:text-foreground border-b-2 border-transparent px-1 pb-3 text-sm'
          onClick={() => setTab('vault')}
        >
          {t('Personal vault')}
        </button>
      </div>
      {tab === 'vault' ? (
        <div className='rounded-2xl border p-6'>
          <LockKeyhole className='text-muted-foreground size-6' aria-hidden />
          <h3 className='mt-4 font-medium'>{t('Environment secrets')}</h3>
          <p className='text-muted-foreground mt-2 text-sm leading-6'>
            {t(
              'This runtime stores secrets per environment. Add secret environment variables in an environment’s configuration. A shared personal vault is not available.'
            )}
          </p>
          <Button
            type='button'
            variant='outline'
            className='mt-4 h-9 rounded-full px-4 text-sm'
            onClick={() => setTab('environments')}
          >
            {t('Manage environments')}
          </Button>
        </div>
      ) : (
        <>
          <div className='flex flex-wrap gap-3'>
            <div className='relative min-w-40 flex-1'>
              <Search
                className='text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2'
                aria-hidden
              />
              <input
                type='search'
                aria-label={t('Search environments')}
                placeholder={t('Search')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className='focus-visible:ring-ring h-10 w-full rounded-xl border bg-transparent pr-3 pl-10 text-sm outline-none focus-visible:ring-2'
              />
            </div>
            <Button
              type='button'
              className='h-10 gap-2 rounded-full px-4 text-sm'
              onClick={() => {
                create.reset()
                setCreating(true)
              }}
              disabled={environments.isPending || environments.isError}
            >
              <Plus className='size-4' aria-hidden />
              {t('Create environment')}
            </Button>
          </div>
          {environments.isPending && (
            <p
              role='status'
              className='text-muted-foreground flex items-center gap-2 py-8 text-sm'
            >
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
              {t('Loading environments...')}
            </p>
          )}
          {environments.isError && (
            <div className='space-y-3 rounded-xl border p-4'>
              <p role='alert' className='text-destructive text-sm'>
                {t(codexError(environments.error))}
              </p>
              <Button
                type='button'
                variant='outline'
                className='h-9 gap-2 rounded-full px-4 text-sm'
                onClick={() => void environments.refetch()}
              >
                <RefreshCw className='size-4' aria-hidden />
                {t('Retry')}
              </Button>
            </div>
          )}
          {!environments.isPending &&
            !environments.isError &&
            filtered.length === 0 && (
              <div className='rounded-2xl border border-dashed px-6 py-12 text-center'>
                <Cloud
                  className='text-muted-foreground mx-auto size-7'
                  aria-hidden
                />
                <h3 className='mt-4 text-sm font-medium'>
                  {search
                    ? t('No environments match your search.')
                    : t('Create your first environment')}
                </h3>
                <p className='text-muted-foreground mx-auto mt-2 max-w-sm text-sm leading-6'>
                  {search
                    ? t('Try a different environment name or repository.')
                    : t(
                        'Choose repositories and prepare the tools your tasks need.'
                      )}
                </p>
              </div>
            )}
          {filtered.length > 0 && (
            <div className='codex-cloud-table overflow-x-auto rounded-xl border'>
              <table className='w-full min-w-[420px] text-left text-sm'>
                <thead className='text-muted-foreground border-b text-xs'>
                  <tr>
                    <th className='px-4 py-3 font-medium'>
                      {t('Environment')}
                    </th>
                    <th className='px-4 py-3 font-medium'>{t('Sharing')}</th>
                    <th className='px-4 py-3 font-medium'>{t('Status')}</th>
                    <th className='w-12 px-2 py-3'>
                      <span className='sr-only'>{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((environment) => (
                    <tr
                      key={environment.id}
                      className='border-b last:border-b-0'
                    >
                      <td className='max-w-64 px-4 py-4'>
                        <button
                          type='button'
                          className='block max-w-full truncate text-left font-medium hover:underline focus-visible:outline-2'
                          onClick={() => setEditing(environment)}
                        >
                          {environment.name}
                        </button>
                        <p className='text-muted-foreground mt-1 truncate text-xs'>
                          {t('{{count}} repositories', {
                            count: environment.config.repositories.length,
                          })}
                        </p>
                      </td>
                      <td className='px-4 py-4 text-xs'>{t('Private')}</td>
                      <td className='px-4 py-4'>
                        <span className='bg-muted inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs'>
                          {environment.status === 'preparing' && (
                            <LoaderCircle
                              className='size-3 animate-spin'
                              aria-hidden
                            />
                          )}
                          {labels[environment.status]}
                        </span>
                        {environment.publishedVersion !== null && (
                          <p className='text-muted-foreground mt-1 text-xs'>
                            {t('Version {{version}}', {
                              version: environment.publishedVersion,
                            })}
                          </p>
                        )}
                      </td>
                      <td className='px-2 py-4'>
                        <Menu.Root>
                          <Menu.Trigger
                            aria-label={t('Actions for {{name}}', {
                              name: environment.name,
                            })}
                            className='hover:bg-muted focus-visible:ring-ring flex size-9 items-center justify-center rounded-full outline-none focus-visible:ring-2'
                          >
                            <Ellipsis className='size-4' aria-hidden />
                          </Menu.Trigger>
                          <Menu.Portal>
                            <Menu.Positioner
                              sideOffset={4}
                              align='end'
                              className='z-[85]'
                            >
                              <Menu.Popup className='bg-popover text-popover-foreground min-w-48 rounded-xl border p-1 shadow-lg outline-none'>
                                <Menu.Item
                                  className='data-highlighted:bg-muted flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none'
                                  onClick={() => setEditing(environment)}
                                >
                                  <Pencil className='size-4' aria-hidden />
                                  {t('Edit')}
                                </Menu.Item>
                                <Menu.Item
                                  disabled={environment.status === 'preparing'}
                                  className='data-highlighted:bg-muted text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-disabled:opacity-40'
                                  onClick={() => {
                                    remove.reset()
                                    setDeleting(environment)
                                  }}
                                >
                                  <Trash2 className='size-4' aria-hidden />
                                  {t('Delete environment')}
                                </Menu.Item>
                              </Menu.Popup>
                            </Menu.Positioner>
                          </Menu.Portal>
                        </Menu.Root>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!create.isPending) setCreating(open)
        }}
      >
        <DialogContent
          className='codex-zcode codex-chatgpt max-h-[90dvh] overflow-y-auto rounded-2xl sm:max-w-xl'
          showCloseButton={!create.isPending}
        >
          <DialogHeader>
            <DialogTitle>{t('Create a cloud environment')}</DialogTitle>
            <DialogDescription>
              {t(
                'Choose one or more repositories. Codex will use them to prepare your environment.'
              )}
            </DialogDescription>
          </DialogHeader>
          <CloudRepositoryPicker
            actor={props.actor}
            value={repositories}
            onChange={setRepositories}
            disabled={create.isPending}
          />
          {repositories.length > maxRepositories && (
            <p role='alert' className='text-destructive text-sm'>
              {t('Choose up to {{count}} repositories.', {
                count: maxRepositories,
              })}
            </p>
          )}
          {create.error && (
            <p role='alert' className='text-destructive text-sm'>
              {t(codexError(create.error))}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              className='h-9 rounded-full px-4 text-sm'
              disabled={create.isPending}
              onClick={() => setCreating(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='button'
              className='h-9 gap-2 rounded-full px-4 text-sm'
              disabled={
                create.isPending ||
                repositories.length === 0 ||
                repositories.length > maxRepositories
              }
              onClick={() => create.mutate()}
            >
              {create.isPending && (
                <LoaderCircle className='size-4 animate-spin' aria-hidden />
              )}
              {t('Get started')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null)
        }}
      >
        <DialogContent
          className='codex-zcode codex-chatgpt rounded-2xl sm:max-w-md'
          showCloseButton={!remove.isPending}
        >
          <DialogHeader>
            <DialogTitle>{t('Delete environment')}</DialogTitle>
            <DialogDescription>
              {t(
                'Delete {{name}} and its published versions? Tasks already created from it keep their own workspace.',
                { name: deleting?.name }
              )}
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <p role='alert' className='text-destructive text-sm'>
              {t(codexError(remove.error))}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              className='h-9 rounded-full px-4 text-sm'
              disabled={remove.isPending}
              onClick={() => setDeleting(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='button'
              variant='destructive'
              className='h-9 rounded-full px-4 text-sm'
              disabled={remove.isPending}
              onClick={() => {
                if (deleting) remove.mutate(deleting.id)
              }}
            >
              {remove.isPending ? t('Deleting...') : t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
