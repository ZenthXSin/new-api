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
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  LoaderCircle,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ImageDialog } from './dialogs/image-dialog'
import { useLogsViewScope } from './usage-logs-provider'

type ImagePreview = { id: string; url: string; local: boolean; mime: string }
type ImageTask = {
  id: string
  model: string
  status:
    | 'connecting'
    | 'generating'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'no_output'
  expected_count: number
  completed_count: number
  created_at: number
  failure: string
  images: ImagePreview[]
}
export type ImageTasksPage = {
  items: ImageTask[]
  total: number
  counts: {
    connecting_images: number
    generating_images: number
    active_requests: number
  }
}
const statusLabels = {
  connecting: 'Connecting',
  generating: 'Generating images',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  no_output: 'No image returned',
} as const

function GeneratedImagePreview(props: { image: ImagePreview; taskId: string }) {
  const { t } = useTranslation()
  const owner = useAuthStore((state) => state.auth.user?.id)
  const [objectUrl, setObjectUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['image-task-preview', owner, props.image.url],
    queryFn: async ({ signal }) => {
      const response = await api.get<Blob>(props.image.url, {
        responseType: 'blob',
        signal,
      })
      return response.data
    },
    enabled: props.image.local,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  })
  useEffect(() => {
    if (!query.data) return
    const address = URL.createObjectURL(query.data)
    setObjectUrl(address)
    setFailed(false)
    return () => URL.revokeObjectURL(address)
  }, [query.data])
  const source = props.image.local ? objectUrl : props.image.url
  if (failed || query.isError) {
    return (
      <button
        type='button'
        className='bg-muted text-muted-foreground flex h-20 w-28 items-center justify-center rounded-lg text-xs'
        onClick={() => {
          setFailed(false)
          if (props.image.local) {
            void query.refetch()
          }
        }}
      >
        {t('Retry image preview')}
      </button>
    )
  }
  return (
    <>
      <button
        type='button'
        className='bg-muted relative flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg transition-opacity hover:opacity-80 motion-reduce:transition-none'
        disabled={!source}
        aria-label={t('Open generated image')}
        onClick={() => setOpen(true)}
      >
        {source ? (
          <img
            src={source}
            alt={t('Generated image')}
            loading='lazy'
            referrerPolicy='no-referrer'
            className='size-full object-cover'
            onError={() => setFailed(true)}
          />
        ) : (
          <LoaderCircle
            className='size-4 animate-spin motion-reduce:animate-none'
            aria-label={t('Loading')}
          />
        )}
      </button>
      {source && open && (
        <ImageDialog
          imageUrl={source}
          taskId={props.taskId}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  )
}

export function ImageTasksPanel() {
  const { t } = useTranslation()
  const { isAdminView } = useLogsViewScope()
  const owner = useAuthStore((state) => state.auth.user?.id)
  const [page, setPage] = useState(1)
  const scope = isAdminView ? 'all' : 'self'
  const query = useQuery({
    queryKey: ['image-tasks', owner, scope, page],
    queryFn: async ({ signal }) => {
      const response = await api.get<{
        success: boolean
        message?: string
        data: ImageTasksPage
      }>('/api/image-tasks', {
        params: { p: page, page_size: 12, scope },
        signal,
      })
      if (!response.data.success) throw new Error(response.data.message)
      return response.data.data
    },
    placeholderData: (previous, previousQuery) => {
      if (
        previousQuery &&
        previousQuery.queryKey[1] === owner &&
        previousQuery.queryKey[2] === scope
      ) {
        return keepPreviousData(previous)
      }
      return undefined
    },
    refetchInterval: (query) =>
      query.state.data?.counts.active_requests ? 2000 : 5000,
    retry: false,
  })
  useEffect(() => setPage(1), [scope])
  const data = query.data
  const counts = data?.counts
  return (
    <section
      className='space-y-3 rounded-xl border p-3'
      aria-label={t('Image generation tasks')}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h2 className='text-sm font-medium'>{t('Image generation tasks')}</h2>
        <p
          role='status'
          className='text-muted-foreground flex items-center gap-2 text-xs tabular-nums'
        >
          {!!counts?.active_requests && (
            <LoaderCircle
              className='size-3.5 animate-spin motion-reduce:animate-none'
              aria-hidden
            />
          )}
          {t('{{connecting}} connecting · {{generating}} generating', {
            connecting: counts?.connecting_images ?? 0,
            generating: counts?.generating_images ?? 0,
          })}
        </p>
      </div>
      {query.isPending && (
        <p className='text-muted-foreground text-xs'>{t('Loading')}</p>
      )}
      {query.isError && (
        <p role='alert' className='text-destructive text-xs'>
          {t('Could not load image tasks')}
        </p>
      )}
      {data && !data.items.length && (
        <p className='text-muted-foreground text-xs'>
          {t('Image requests through New API appear here automatically.')}
        </p>
      )}
      <ul className='max-h-[55vh] divide-y overflow-y-auto'>
        {data?.items.map((task) => (
          <li key={task.id} className='space-y-2 py-2.5 first:pt-0 last:pb-0'>
            <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs'>
              <span className='min-w-0 flex-1 truncate font-medium'>
                {task.model}
              </span>
              <span
                className={
                  task.status === 'failed'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }
              >
                {t(statusLabels[task.status])}
              </span>
              <span className='text-muted-foreground tabular-nums'>
                {task.completed_count} / {task.expected_count}
              </span>
              <time
                className='text-muted-foreground'
                dateTime={new Date(task.created_at * 1000).toISOString()}
              >
                {new Date(task.created_at * 1000).toLocaleTimeString()}
              </time>
            </div>
            {!!task.images.length && (
              <div className='flex gap-2 overflow-x-auto pb-1'>
                {task.images.map((image) => (
                  <GeneratedImagePreview
                    key={image.id}
                    image={image}
                    taskId={task.id}
                  />
                ))}
              </div>
            )}
            {task.failure && (
              <p className='text-destructive text-xs'>{t(task.failure)}</p>
            )}
            {task.status === 'no_output' && (
              <p className='text-muted-foreground flex items-center gap-1 text-xs'>
                <ImageIcon className='size-3.5' aria-hidden />
                {t('No image returned')}
              </p>
            )}
          </li>
        ))}
      </ul>
      {!!data?.total && (
        <div className='flex items-center justify-end gap-2 text-xs'>
          <span className='text-muted-foreground'>
            {t('Page {{page}}', { page })}
          </span>
          <Button
            size='icon-sm'
            variant='ghost'
            disabled={page === 1 || query.isFetching}
            aria-label={t('Previous page')}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className='size-4' />
          </Button>
          <Button
            size='icon-sm'
            variant='ghost'
            disabled={page * 12 >= data.total || query.isFetching}
            aria-label={t('Next page')}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className='size-4' />
          </Button>
        </div>
      )}
    </section>
  )
}
