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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'
import { useAuthStore } from '@/stores/auth-store'

import { getPaymentOrders } from './api'
import { PaymentErrorAlert } from './components/payment-error'
import { PaymentStatusBadge } from './components/payment-status'
import { formatPaymentAmount } from './lib/payment-display'

export function PaymentOrders() {
  const { t } = useTranslation()
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {t('My payment orders')}
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <PaymentOrderList />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

export function PaymentOrderList(props: { clientID?: string }) {
  const userID = useAuthStore((state) => state.auth.user?.id)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  if (!userID || !sessionID || (props.clientID && role < 100)) return null
  return (
    <OrderListSession
      key={`${userID}:${sessionID}:${props.clientID ?? ''}`}
      identity={{ userID, sessionID }}
      clientID={props.clientID}
    />
  )
}

function OrderListSession(props: {
  identity: { userID: number; sessionID: string }
  clientID?: string
}) {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState(1)
  const query = useQuery({
    queryKey: [
      'app-payment-orders',
      props.identity.userID,
      props.identity.sessionID,
      props.clientID,
      page,
    ],
    queryFn: ({ signal }) =>
      getPaymentOrders(page, props.identity, props.clientID, signal),
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  return (
    <div className='flex min-w-0 flex-col gap-4'>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-muted-foreground text-sm'>
          {t('View the confirmed status of your application purchases.')}
        </p>
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
        <Skeleton className='h-48 w-full' aria-label={t('Loading orders')} />
      )}
      {query.isError && <PaymentErrorAlert error={query.error} />}
      {query.data?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t('No payment orders yet')}</EmptyTitle>
            <EmptyDescription>
              {t('Orders appear here after you start a payment.')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {query.data?.items.map((order) => (
        <Card key={order.id}>
          <CardHeader className='gap-2'>
            <CardTitle className='break-words'>{order.title}</CardTitle>
            <div>
              <PaymentStatusBadge status={order.status} />
            </div>
          </CardHeader>
          <CardContent className='flex flex-col gap-3 text-sm'>
            <p className='text-lg font-semibold tabular-nums'>
              {formatPaymentAmount(order.amount, order.currency)}
            </p>
            <dl className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2'>
              <dt className='text-muted-foreground'>{t('Order number')}</dt>
              <dd className='text-right break-all'>{order.out_trade_no}</dd>
              <dt className='text-muted-foreground'>{t('Created at')}</dt>
              <dd className='text-right'>
                {new Date(order.created_at * 1000).toLocaleString(
                  toIntlLocale(i18n.language)
                )}
              </dd>
            </dl>
            <div className='flex justify-end'>
              <Button
                nativeButton={false}
                variant='outline'
                render={
                  <Link
                    to='/payments/checkout/$orderId'
                    params={{ orderId: order.id }}
                  />
                }
              >
                {t('View order')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {query.data && (
        <div className='flex items-center justify-end gap-3'>
          <Button
            type='button'
            variant='outline'
            disabled={page <= 1 || query.isFetching}
            onClick={() => setPage((value) => value - 1)}
          >
            {t('Previous')}
          </Button>
          <span className='text-sm'>{t('Page {{page}}', { page })}</span>
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
    </div>
  )
}
