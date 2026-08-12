/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Download, Megaphone, PackageOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { Skeleton } from '@/components/ui/skeleton'

import {
  getLatestDistributionRelease,
  getPublicAnnouncements,
  getPublicApps,
  type DistributionApp,
} from './api'

export function DistributionPublicHub() {
  const { t } = useTranslation()
  const appsQuery = useQuery({
    queryKey: ['public-apps'],
    queryFn: getPublicApps,
  })
  const apps = appsQuery.data?.data ?? []
  const releasedAppsQuery = useQuery({
    queryKey: ['public-apps-with-releases', apps.map((app) => app.id)],
    queryFn: () => getReleasedApps(apps),
    enabled: apps.length > 0,
  })
  const releasedApps = releasedAppsQuery.data ?? []
  const announcementsQuery = useQuery({
    queryKey: ['public-announcements', apps.map((app) => app.id)],
    queryFn: () => getPublicAnnouncements(apps),
    enabled: apps.length > 0,
  })
  let content: ReactNode
  if (appsQuery.isLoading || releasedAppsQuery.isLoading) {
    content = (
      <div className='space-y-3'>
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-16 w-full' />
      </div>
    )
  } else if (appsQuery.isError || releasedAppsQuery.isError) {
    content = (
      <p className='py-10 text-center text-sm'>{t('暂时无法加载下载内容')}</p>
    )
  } else if (releasedApps.length === 0) {
    content = (
      <p className='text-muted-foreground py-10 text-center text-sm'>
        {t('暂无可下载应用')}
      </p>
    )
  } else {
    content = (
      <section className='divide-border divide-y border-y'>
        {releasedApps.map(({ app, latest }) => (
          <HubAppRow key={app.id} app={app} latest={latest} />
        ))}
      </section>
    )
  }
  return (
    <PublicLayout>
      <div className='mx-auto max-w-6xl space-y-8 py-8'>
        <header>
          <h1 className='text-3xl font-bold'>{t('下载中心')}</h1>
          <p className='text-muted-foreground mt-2'>
            {t('获取公开应用的最新版本和公告')}
          </p>
        </header>
        {content}
        <section id='announcements' className='space-y-3'>
          <h2 className='flex items-center gap-2 text-lg font-semibold'>
            <Megaphone className='size-4' />
            {t('最新公告')}
          </h2>
          <div className='divide-border divide-y border-y'>
            {(announcementsQuery.data?.data ?? []).slice(0, 5).map((item) => {
              const app = apps.find((candidate) => candidate.id === item.app_id)
              return app ? (
                <Link
                  key={item.id}
                  to='/distribution/$slug/announcements/$id'
                  params={{ slug: app.slug, id: String(item.id) }}
                  className='flex items-center justify-between gap-3 py-3 text-sm hover:underline'
                >
                  <span>{item.title}</span>
                  <span className='text-muted-foreground'>{app.name}</span>
                </Link>
              ) : null
            })}
          </div>
        </section>
      </div>
    </PublicLayout>
  )
}

function HubAppRow({
  app,
  latest,
}: {
  app: DistributionApp
  latest: import('./api').DistributionRelease
}) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-wrap items-center justify-between gap-4 py-5'>
      <div className='flex items-start gap-3'>
        <PackageOpen className='mt-1 size-5' />
        <div>
          <Link
            to='/distribution/$slug'
            params={{ slug: app.slug }}
            className='font-semibold hover:underline'
          >
            {app.name}
          </Link>
          <p className='text-muted-foreground text-sm'>{app.description}</p>
        </div>
      </div>
      <div className='flex items-center gap-3 text-sm'>
        <span>v{latest.version}</span>
        <span className='text-muted-foreground text-xs'>
          {t('{{count}} downloads', { count: app.download_count })}
        </span>
        <Link
          to='/distribution/$slug'
          params={{ slug: app.slug }}
          className='text-primary inline-flex items-center gap-1 hover:underline'
        >
          <Download className='size-4' />
          {t('下载')}
        </Link>
      </div>
    </div>
  )
}
async function getReleasedApps(apps: DistributionApp[]) {
  const rows = await Promise.all(
    apps.map(async (app) => {
      try {
        const latest = (await getLatestDistributionRelease(app.slug)).data
        return latest ? { app, latest } : null
      } catch {
        return null
      }
    })
  )
  return rows.filter(
    (
      row
    ): row is {
      app: DistributionApp
      latest: import('./api').DistributionRelease
    } => row !== null
  )
}
