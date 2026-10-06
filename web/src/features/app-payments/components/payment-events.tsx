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
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'

import { getPaymentEvents, retryPaymentEvent } from '../api'
import type { PaymentIdentity } from '../types'
import { PaymentErrorAlert } from './payment-error'

export function PaymentEvents(props: {
  clientID: string
  identity: PaymentIdentity
}) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(1)
  const [retryID, setRetryID] = useState('')
  const query = useQuery({
    queryKey: [
      'app-payment-events',
      props.clientID,
      props.identity.userID,
      props.identity.sessionID,
      page,
    ],
    queryFn: ({ signal }) =>
      getPaymentEvents(props.clientID, page, props.identity, signal),
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  const retry = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async () => {
      if (!retryID) return
      await retryPaymentEvent(props.clientID, retryID, props.identity)
      setRetryID('')
      await query.refetch()
    },
    meta: { errorToast: false },
  })
  return (
    <div className='flex min-w-0 flex-col gap-3'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='font-medium'>{t('Payment notifications')}</h3>
        <Button
          type='button'
          variant='outline'
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('Refresh')}
        </Button>
      </div>
      {query.isPending && (
        <Skeleton
          className='h-32 w-full'
          aria-label={t('Loading notifications')}
        />
      )}
      {query.isError && <PaymentErrorAlert error={query.error} />}
      {query.data?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('No payment notifications yet')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {query.data?.items.map((event) => (
        <Card key={event.id}>
          <CardHeader>
            <CardTitle className='break-all'>{event.type}</CardTitle>
            <div>
              <Badge variant='secondary'>
                {event.delivered_at > 0
                  ? t('Delivered')
                  : t('Awaiting delivery')}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className='flex min-w-0 flex-col gap-2 text-sm'>
            <p className='break-all'>
              {t('Order')}: {event.order_id}
            </p>
            <p className='text-muted-foreground break-all'>{event.id}</p>
            <p>
              {t('Delivery attempts: {{count}}', { count: event.attempts })}
            </p>
            {event.next_attempt_at > 0 && event.delivered_at === 0 && (
              <p>
                {t('Next attempt: {{time}}', {
                  time: new Date(event.next_attempt_at * 1000).toLocaleString(
                    toIntlLocale(i18n.language)
                  ),
                })}
              </p>
            )}
            {event.last_error && event.delivered_at === 0 && (
              <p className='text-destructive break-words'>
                {t(
                  'The last delivery failed. Check the notification address and retry.'
                )}
              </p>
            )}
            <Button
              type='button'
              variant='outline'
              disabled={event.delivered_at > 0 || retry.isPending}
              onClick={() => {
                retry.reset()
                setRetryID(event.id)
              }}
            >
              {t('Retry delivery')}
            </Button>
          </CardContent>
        </Card>
      ))}
      {query.data && (
        <div className='flex justify-end gap-2'>
          <Button
            type='button'
            variant='outline'
            disabled={page <= 1 || query.isFetching}
            onClick={() => setPage((value) => value - 1)}
          >
            {t('Previous')}
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={
              page * query.data.page_size >= query.data.total ||
              query.isFetching
            }
            onClick={() => setPage((value) => value + 1)}
          >
            {t('Next')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(retryID)}
        onOpenChange={(open) => {
          if (!open && !retry.isPending) setRetryID('')
        }}
        title={t('Retry payment notification')}
        desc={t(
          'Send this pending notification again. The application should handle repeated notifications safely.'
        )}
        confirmText={t('Retry delivery')}
        isLoading={retry.isPending}
        handleConfirm={() => void retry.mutateAsync().catch(() => undefined)}
      >
        {retry.isError && <PaymentErrorAlert error={retry.error} />}
      </ConfirmDialog>
    </div>
  )
}
