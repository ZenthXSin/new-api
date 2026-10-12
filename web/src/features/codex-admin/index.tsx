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
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RefreshCw, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { codexError } from '@/features/codex/api'
import { api } from '@/lib/api'

import { UserCodexConfigDialog } from './components/user-codex-config-dialog'
import type { CodexAdminUser } from './types'

export function CodexAdmin() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<CodexAdminUser | null>(null)
  const query = useQuery({
    queryKey: ['codex-admin-users', keyword, page],
    queryFn: async ({ signal }) => {
      const response = await api.get<{
        success: boolean
        message?: string
        data: { items: CodexAdminUser[]; total: number }
      }>('/api/codex-admin/users', {
        params: { keyword, page, pageSize: 20 },
        signal,
      })
      if (!response.data.success) {
        throw new Error(
          response.data.message || t('Unable to load Codex configuration')
        )
      }
      return response.data.data
    },
  })
  const rows = query.data?.items ?? []
  const sourceLabels = {
    none: t('Not granted'),
    manual: t('Manual override'),
    subscription: t('Subscription plan'),
    administrator: t('Administrator default'),
  }
  return (
    <>
      <SectionPageLayout stackActionsOnMobile>
        <SectionPageLayout.Title>
          {t('Codex management')}
        </SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <Link
            to='/subscriptions'
            className='text-primary rounded-md px-3 py-2 text-sm hover:underline'
          >
            {t('Configure subscription plans')}
          </Link>
          <Button
            variant='outline'
            size='sm'
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              className={query.isFetching ? 'size-4 animate-spin' : 'size-4'}
            />
            {t('Refresh')}
          </Button>
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          <div className='space-y-3 pb-3'>
            <p className='text-muted-foreground max-w-4xl text-xs leading-5'>
              {t(
                'Manage Codex access and resource limits here. Manual overrides take priority; otherwise the most recently started active Codex subscription applies.'
              )}
            </p>
            <div className='flex flex-wrap items-center gap-x-6 gap-y-1.5 border-y py-2'>
              {[
                { label: t('Matching users'), value: query.data?.total },
                {
                  label: t('Enabled on this page'),
                  value:
                    query.data &&
                    rows.filter((row) => row.effective.enabled).length,
                },
                {
                  label: t('Subscription access on this page'),
                  value:
                    query.data &&
                    rows.filter(
                      (row) =>
                        row.effective.enabled &&
                        row.effective.source === 'subscription'
                    ).length,
                },
              ].map((item) => (
                <div key={item.label} className='flex items-center gap-2'>
                  <p className='text-muted-foreground text-xs'>{item.label}</p>
                  <p className='text-base font-semibold tabular-nums'>
                    {item.value ?? '—'}
                  </p>
                </div>
              ))}
            </div>
            <form
              className='flex max-w-xl gap-2'
              onSubmit={(event) => {
                event.preventDefault()
                setKeyword(search.trim())
                setPage(1)
              }}
            >
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={128}
                placeholder={t('Search username, display name or ID')}
                aria-label={t('Search Codex users')}
              />
              <Button type='submit' size='sm'>
                {t('Search')}
              </Button>
            </form>
            {query.isPending && (
              <p
                role='status'
                className='text-muted-foreground py-10 text-center'
              >
                {t('Loading...')}
              </p>
            )}
            {query.isError && (
              <div
                role='alert'
                className='text-destructive flex items-center gap-3 rounded-lg border p-4'
              >
                {codexError(query.error)}
                <Button variant='outline' onClick={() => void query.refetch()}>
                  {t('Retry')}
                </Button>
              </div>
            )}
            {query.data && (
              <div className='overflow-hidden rounded-lg border'>
                <Table className='[&_td]:px-3 [&_td]:py-2 [&_th]:h-9'>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('User')}</TableHead>
                      <TableHead>{t('Current access')}</TableHead>
                      <TableHead>{t('Access source')}</TableHead>
                      <TableHead>{t('Resource limits')}</TableHead>
                      <TableHead>{t('Actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className='text-muted-foreground h-32 text-center'
                        >
                          {t('No matching users')}
                        </TableCell>
                      </TableRow>
                    )}
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className='font-medium'>
                            {row.displayName || row.username}
                          </div>
                          <div className='text-muted-foreground text-xs'>
                            {row.username} · #{row.id}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.effective.enabled ? 'default' : 'secondary'
                            }
                          >
                            {row.effective.enabled
                              ? t('Enabled')
                              : t('Disabled')}
                          </Badge>
                          {row.status !== 1 && (
                            <p className='text-destructive mt-1 text-xs'>
                              {t('Account disabled')}
                            </p>
                          )}
                          <p className='text-muted-foreground mt-1 text-xs'>
                            {[
                              row.effective.allowDocker && 'Docker',
                              row.effective.allowSSH && 'SSH',
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </p>
                        </TableCell>
                        <TableCell>
                          <p>{sourceLabels[row.effective.source]}</p>
                          {row.effective.planTitle && (
                            <p className='text-muted-foreground mt-1 text-xs'>
                              {row.effective.planTitle}
                            </p>
                          )}
                          {row.effective.expiresAt && (
                            <p className='text-muted-foreground mt-1 text-xs whitespace-nowrap'>
                              {t('Plan expires')}:{' '}
                              {new Date(
                                row.effective.expiresAt * 1000
                              ).toLocaleString()}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <p className='text-xs whitespace-nowrap'>
                            {t('Memory limit (MB)')}:{' '}
                            {row.effective.memoryMB || t('Server default')}
                          </p>
                          <p className='text-muted-foreground mt-1 text-xs'>
                            CPU:{' '}
                            {row.effective.cpuPercent
                              ? `${row.effective.cpuPercent}%`
                              : t('Server default')}
                          </p>
                          <p className='text-muted-foreground mt-1 text-xs'>
                            {t('Maximum projects')}:{' '}
                            {row.effective.maxProjects || t('Server default')}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant='outline'
                            size='sm'
                            aria-label={t('Configure Codex for {{username}}', {
                              username: row.username,
                            })}
                            onClick={() => setSelected(row)}
                          >
                            <Settings2 className='size-4' />
                            {t('Configure')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className='flex items-center justify-between gap-2 border-t p-3 text-sm'>
                  <span>{t('Page {{page}}', { page })}</span>
                  <div className='flex gap-2'>
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={page === 1 || query.isFetching}
                      onClick={() => setPage(page - 1)}
                    >
                      {t('Previous')}
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={
                        page * 20 >= query.data.total || query.isFetching
                      }
                      onClick={() => setPage(page + 1)}
                    >
                      {t('Next')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SectionPageLayout.Content>
      </SectionPageLayout>
      {selected && (
        <UserCodexConfigDialog
          key={selected.id}
          user={selected}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
        />
      )}
    </>
  )
}
