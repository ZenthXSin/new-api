/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'

import {
  clearAppCenterCustomMessages,
  formatMessageTime,
  getAppCenterCustomMessages,
  getMessagePageBounds,
  joinMessageRegion,
  MESSAGE_PAGE_SIZE,
} from '../api'

export function CustomMessagesPanel({ appId }: { appId: number }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [confirmOpen, setConfirmOpen] = useState(false)
  useEffect(() => {
    setPage(1)
  }, [appId])
  const messagesQuery = useQuery({
    queryKey: ['app-center-custom-messages', appId, page, MESSAGE_PAGE_SIZE],
    queryFn: () => getAppCenterCustomMessages(appId, page, MESSAGE_PAGE_SIZE),
    enabled: appId > 0,
  })
  const clearMessages = useMutation({
    mutationFn: () => clearAppCenterCustomMessages(appId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['app-center-custom-messages', appId],
      })
      setConfirmOpen(false)
      setPage(1)
      toast.success(t('Cleared'))
    },
    onError: () => toast.error(t('Failed to load')),
  })
  const pageData = messagesQuery.data?.data
  const items = pageData?.items ?? []
  const total = pageData?.total ?? 0
  const bounds = getMessagePageBounds(total, page, MESSAGE_PAGE_SIZE)
  let body: ReactElement
  if (messagesQuery.isLoading) {
    body = (
      <p className='py-8 text-center text-sm'>{t('Loading')}</p>
    )
  } else if (messagesQuery.isError) {
    body = (
      <p className='text-destructive py-8 text-center text-sm'>
        {t('Failed to load')}
      </p>
    )
  } else if (total === 0) {
    body = (
      <p className='text-muted-foreground py-8 text-center text-sm'>
        {t('No custom messages yet')}
      </p>
    )
  } else {
    body = (
      <>
        <div className='overflow-x-auto rounded-md border'>
          <table className='w-full text-sm'>
            <thead className='bg-muted/50'>
              <tr>
                <th className='px-3 py-1.5 text-left font-medium'>
                  {t('Time')}
                </th>
                <th className='px-3 py-1.5 text-left font-medium'>
                  {t('Source IP')}
                </th>
                <th className='px-3 py-1.5 text-left font-medium'>
                  {t('Region')}
                </th>
                <th className='px-3 py-1.5 text-left font-medium'>
                  {t('Category')}
                </th>
                <th className='px-3 py-1.5 text-left font-medium'>
                  {t('Content')}
                </th>
              </tr>
            </thead>
            <tbody className='divide-y'>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className='px-3 py-1.5 whitespace-nowrap tabular-nums'>
                    {formatMessageTime(item.created_at)}
                  </td>
                  <td className='px-3 py-1.5 font-mono'>{item.source_ip || '-'}</td>
                  <td className='px-3 py-1.5'>
                    {joinMessageRegion(item) || '-'}
                  </td>
                  <td className='px-3 py-1.5'>{item.name || '-'}</td>
                  <td className='px-3 py-1.5 whitespace-pre-wrap break-words'>
                    {item.content}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className='flex items-center justify-end gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={!bounds.hasPrevious}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            {t('Previous')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={!bounds.hasNext}
            onClick={() => setPage((current) => current + 1)}
          >
            {t('Next')}
          </Button>
        </div>
      </>
    )
  }
  return (
    <section className='space-y-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h2 className='font-semibold'>{t('Custom Messages')}</h2>
        <Button
          variant='outline'
          size='sm'
          disabled={total === 0 || clearMessages.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className='mr-1 size-4' aria-hidden />
          {t('Clear')}
        </Button>
      </div>
      {body}
      <ConfirmDialog
        destructive
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('Clear all custom messages?')}
        desc={t('This action cannot be undone.')}
        confirmText={t('Clear')}
        handleConfirm={() => clearMessages.mutate()}
        isLoading={clearMessages.isPending}
      />
    </section>
  )
}
