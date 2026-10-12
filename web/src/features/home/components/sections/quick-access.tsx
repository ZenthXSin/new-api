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
import { Link } from '@tanstack/react-router'
import { ArrowRight, HardDriveDownload, Megaphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAnnouncements } from '@/features/dashboard/hooks/use-status-data'
import { getPreviewText } from '@/features/dashboard/lib'
import { getAnnouncementColorClass } from '@/lib/colors'
import { formatDateTimeObject } from '@/lib/time'
import { cn } from '@/lib/utils'

const MAX_HOME_ANNOUNCEMENTS = 3

export function QuickAccess() {
  const { t } = useTranslation()
  const { items: announcements, loading } = useAnnouncements()
  const latestAnnouncements = announcements.slice(0, MAX_HOME_ANNOUNCEMENTS)

  return (
    <section className='relative z-10 px-6 pb-12 md:pb-16'>
      <div className='mx-auto max-w-6xl'>
        <p className='text-muted-foreground mb-5 text-xs font-medium tracking-widest uppercase'>
          {t('Quick Access')}
        </p>

        <div className='grid gap-4 md:grid-cols-2'>
          {/* Download Center portal */}
          <Link
            to='/downloads'
            className='group border-border/40 hover:bg-muted/20 bg-background flex flex-col justify-between gap-5 rounded-xl border p-7 transition-colors duration-300 md:p-8'
          >
            <div className='flex items-start justify-between'>
              <span className='border-border/50 bg-muted/30 flex size-12 items-center justify-center rounded-xl border text-blue-500 dark:text-blue-400'>
                <HardDriveDownload className='size-5' strokeWidth={1.5} />
              </span>
              <ArrowRight className='text-muted-foreground/40 group-hover:text-foreground size-4 transition-all duration-200 group-hover:translate-x-0.5' />
            </div>
            <div>
              <h3 className='mb-1.5 text-sm font-semibold'>
                {t('Download Center')}
              </h3>
              <p className='text-muted-foreground text-sm leading-relaxed'>
                {t(
                  'Get the latest installers, release notes and announcements'
                )}
              </p>
            </div>
          </Link>

          {/* Announcements board */}
          <div className='border-border/40 bg-background flex flex-col rounded-xl border p-7 md:p-8'>
            <div className='mb-4 flex items-center gap-3'>
              <span className='border-border/50 bg-muted/30 text-muted-foreground flex size-12 shrink-0 items-center justify-center rounded-xl border'>
                <Megaphone className='size-5' strokeWidth={1.5} />
              </span>
              <h3 className='text-sm font-semibold'>{t('Announcements')}</h3>
            </div>

            {loading ? (
              <div aria-hidden className='flex flex-col gap-3 py-1'>
                <div className='bg-muted h-4 w-11/12 animate-pulse rounded' />
                <div className='bg-muted h-4 w-8/12 animate-pulse rounded' />
                <div className='bg-muted h-4 w-10/12 animate-pulse rounded' />
              </div>
            ) : null}

            {!loading && latestAnnouncements.length === 0 ? (
              <p className='text-muted-foreground py-1 text-sm'>
                {t('No announcements yet')}
              </p>
            ) : null}

            {!loading && latestAnnouncements.length > 0 ? (
              <ul className='flex flex-col gap-3'>
                {latestAnnouncements.map((item, idx) => (
                  <li key={item.id ?? idx} className='flex items-start gap-2.5'>
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 inline-block size-2 shrink-0 rounded-full',
                        getAnnouncementColorClass(item.type)
                      )}
                    />
                    <div className='min-w-0 flex-1'>
                      <p className='line-clamp-1 text-sm font-medium'>
                        {getPreviewText(item.content)}
                      </p>
                      {item.publishDate ? (
                        <time
                          dateTime={item.publishDate}
                          className='text-muted-foreground/60 text-xs'
                        >
                          {formatDateTimeObject(new Date(item.publishDate))}
                        </time>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
