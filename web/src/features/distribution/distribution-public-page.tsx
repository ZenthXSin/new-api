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
import { Link, useParams } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  CalendarDays,
  Download,
  PackageOpen,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { RichContent } from '@/components/rich-content'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import {
  getDistributionAnnouncements,
  getDistributionApp,
  getDistributionAssetDownloadUrl,
  getDistributionReleases,
} from './api'
import { formatDistributionDate } from './distribution-display'

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function DistributionPublicPage() {
  const { t, i18n } = useTranslation()
  const { slug } = useParams({ from: '/distribution/$slug/' })
  const appQuery = useQuery({
    queryKey: ['distribution-app', slug],
    queryFn: () => getDistributionApp(slug),
  })
  const releasesQuery = useQuery({
    queryKey: ['distribution-releases', slug],
    queryFn: () => getDistributionReleases(slug),
    enabled: !!appQuery.data?.data,
  })
  const announcementsQuery = useQuery({
    queryKey: ['distribution-announcements', slug],
    queryFn: () => getDistributionAnnouncements(slug),
    enabled: !!appQuery.data?.data,
  })
  const app = appQuery.data?.data
  const releases = releasesQuery.data?.data ?? []
  const announcements = announcementsQuery.data?.data ?? []

  if (appQuery.isLoading) {
    return (
      <PublicLayout>
        <div className='mx-auto max-w-5xl space-y-5 py-10'>
          <Skeleton className='h-10 w-64' />
          <Skeleton className='h-5 w-96' />
          <Skeleton className='h-48 w-full' />
        </div>
      </PublicLayout>
    )
  }
  if (appQuery.isError || !app) {
    return (
      <PublicLayout>
        <div className='mx-auto max-w-3xl py-24 text-center'>
          <h1 className='text-2xl font-semibold'>{t('找不到应用')}</h1>
          <p className='text-muted-foreground mt-2'>
            {t('请检查应用分发地址是否正确。')}
          </p>
        </div>
      </PublicLayout>
    )
  }

  const latest = releases[0]
  return (
    <PublicLayout>
      <div className='mx-auto max-w-5xl space-y-8 py-4 sm:py-8'>
        <header className='space-y-2'>
          <p className='text-muted-foreground text-sm'>{t('公开下载')}</p>
          <h1 className='text-3xl font-bold tracking-tight'>{app.name}</h1>
          <p className='text-muted-foreground'>
            {t('下载稳定版本、查看版本说明并阅读最新公告。')}
          </p>
          <p className='text-muted-foreground text-sm'>
            {t('{{count}} downloads', { count: app.download_count })}
          </p>
        </header>

        <section className='border-border bg-card rounded-lg border p-5 sm:p-6'>
          <div className='flex flex-wrap items-start justify-between gap-4'>
            <div className='space-y-1'>
              <p className='text-muted-foreground text-sm'>{t('最新版本')}</p>
              <h2 className='text-2xl font-semibold'>
                {latest ? `v${latest.version}` : t('暂无已发布版本')}
              </h2>
              {latest && (
                <p className='text-muted-foreground text-sm'>
                  {latest.channel} ·{' '}
                  {formatDistributionDate(
                    latest.published_at,
                    i18n.language,
                    'medium'
                  )}
                </p>
              )}
            </div>
            <Badge variant={latest ? 'default' : 'secondary'}>
              {latest ? t('已发布') : t('等待发布')}
            </Badge>
          </div>
          {latest?.notes && (
            <RichContent
              mode='markdown'
              content={latest.notes}
              className='prose-neutral dark:prose-invert mt-5 max-w-none text-sm'
            />
          )}
          {latest?.assets?.length ? (
            <div className='mt-6 grid gap-2 sm:grid-cols-2'>
              {latest.assets.map((asset) => (
                <a
                  key={asset.id}
                  href={getDistributionAssetDownloadUrl(slug, asset.id)}
                  className='border-border hover:bg-muted/50 flex items-center justify-between gap-3 rounded-md border px-3 py-3 transition-colors'
                >
                  <span className='flex min-w-0 items-center gap-2'>
                    <PackageOpen className='text-muted-foreground size-4 shrink-0' />
                    <span className='min-w-0 truncate text-sm'>
                      {asset.platform} · {asset.architecture}
                      <span className='text-muted-foreground ml-2'>
                        {formatSize(asset.size)}
                      </span>
                      <span className='text-muted-foreground ml-2 text-xs'>
                        {t('{{count}} downloads', { count: asset.downloads })}
                      </span>
                    </span>
                  </span>
                  <ArrowDownToLine className='text-primary size-4 shrink-0' />
                </a>
              ))}
            </div>
          ) : null}
        </section>

        <section className='space-y-4'>
          <div className='flex items-center justify-between'>
            <h2 className='text-xl font-semibold'>{t('版本历史')}</h2>
            <Download className='text-muted-foreground size-5' />
          </div>
          {releases.length === 0 ? (
            <p className='text-muted-foreground py-8 text-sm'>
              {t('暂无版本。')}
            </p>
          ) : (
            <div className='divide-border divide-y border-y'>
              {releases.map((release) => (
                <div
                  key={release.id}
                  className='flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between'
                >
                  <div className='min-w-0 space-y-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <h3 className='font-medium'>v{release.version}</h3>
                      <Badge variant='outline'>{release.channel}</Badge>
                    </div>
                    <p className='text-muted-foreground text-sm'>
                      {formatDistributionDate(
                        release.published_at,
                        i18n.language,
                        'medium'
                      )}
                    </p>
                    {release.notes && (
                      <RichContent
                        mode='markdown'
                        content={release.notes}
                        className='prose-neutral dark:prose-invert max-w-none text-sm'
                      />
                    )}
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    {release.assets?.map((asset) => (
                      <Button
                        key={asset.id}
                        size='sm'
                        variant='outline'
                        render={
                          <a
                            href={getDistributionAssetDownloadUrl(
                              slug,
                              asset.id
                            )}
                          />
                        }
                      >
                        <ArrowDownToLine />
                        {asset.platform}/{asset.architecture}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className='space-y-4'>
          <div className='flex items-center justify-between'>
            <h2 className='text-xl font-semibold'>{t('公告')}</h2>
            <CalendarDays className='text-muted-foreground size-5' />
          </div>
          {announcements.length === 0 ? (
            <p className='text-muted-foreground py-8 text-sm'>
              {t('暂无公告。')}
            </p>
          ) : (
            <div className='divide-border divide-y border-y'>
              {announcements.map((item) => (
                <article key={item.id} className='py-4'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <Link
                      to='/distribution/$slug/announcements/$id'
                      params={{ slug, id: String(item.id) }}
                      className='font-medium hover:underline'
                    >
                      {item.title}
                    </Link>
                    {item.pinned && (
                      <Badge variant='secondary'>{t('置顶')}</Badge>
                    )}
                  </div>
                  <p className='text-muted-foreground mt-1 text-xs'>
                    {formatDistributionDate(
                      item.created_at,
                      i18n.language,
                      'medium'
                    )}
                  </p>
                  <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
                    {item.body}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </PublicLayout>
  )
}
