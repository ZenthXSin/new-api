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
import { ArrowLeft, CalendarDays } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PublicLayout } from '@/components/layout'
import { RichContent } from '@/components/rich-content'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

import { getDistributionAnnouncement } from './api'
import { formatDistributionDate } from './distribution-display'

export function DistributionAnnouncementPage() {
  const { t, i18n } = useTranslation()
  const { slug, id } = useParams({
    from: '/distribution/$slug/announcements/$id',
  })
  const query = useQuery({
    queryKey: ['distribution-announcement', slug, id],
    queryFn: () => getDistributionAnnouncement(slug, Number(id)),
  })
  const item = query.data?.data
  if (query.isLoading) {
    return (
      <PublicLayout>
        <div className='mx-auto max-w-3xl space-y-5 py-12'>
          <Skeleton className='h-8 w-72' />
          <Skeleton className='h-4 w-40' />
          <Skeleton className='h-48 w-full' />
        </div>
      </PublicLayout>
    )
  }
  if (query.isError || !item) {
    return (
      <PublicLayout>
        <div className='mx-auto max-w-3xl py-24 text-center'>
          <h1 className='text-2xl font-semibold'>{t('Announcement not found')}</h1>
          <Link
            to='/distribution/$slug'
            params={{ slug }}
            className='text-primary mt-4 inline-flex items-center gap-2 text-sm hover:underline'
          >
            <ArrowLeft className='size-4' />
            {t('Back to distribution home')}
          </Link>
        </div>
      </PublicLayout>
    )
  }
  return (
    <PublicLayout>
      <article className='mx-auto max-w-3xl py-6 sm:py-12'>
        <Link
          to='/distribution/$slug'
          params={{ slug }}
          className='text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-2 text-sm'
        >
          <ArrowLeft className='size-4' />
          {t('Back to distribution home')}
        </Link>
        <header className='border-border space-y-3 border-b pb-6'>
          <div className='flex flex-wrap gap-2'>
            {item.pinned && <Badge variant='secondary'>{t('Pinned')}</Badge>}
            {item.platform && <Badge variant='outline'>{item.platform}</Badge>}
          </div>
          <h1 className='text-3xl font-bold tracking-tight'>{item.title}</h1>
          <p className='text-muted-foreground flex items-center gap-2 text-sm'>
            <CalendarDays className='size-4' />
            {formatDistributionDate(item.created_at, i18n.language, 'long')}
          </p>
        </header>
        <RichContent
          mode='markdown'
          content={item.body}
          className='prose-neutral dark:prose-invert mt-8 max-w-none'
        />
      </article>
    </PublicLayout>
  )
}
