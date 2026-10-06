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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { toIntlLocale } from '@/i18n/languages'
import { useAuthStore } from '@/stores/auth-store'

import { confirmPayment, getPaymentCheckout, getPaymentStatus } from './api'
import { PaymentErrorAlert } from './components/payment-error'
import { PaymentStatusBadge } from './components/payment-status'
import {
  formatPaymentAmount,
  safePaymentDestination,
} from './lib/payment-display'
import type {
  PaymentCheckoutData,
  PaymentIdentity,
  PaymentSession,
} from './types'

export function PaymentCheckout(props: { orderID: string }) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  if (!userID || !sessionID) {
    return (
      <Alert>
        <AlertDescription>{t('Sign in to view this order.')}</AlertDescription>
      </Alert>
    )
  }
  return (
    <PaymentCheckoutSession
      key={`${props.orderID}:${userID}:${sessionID}`}
      orderID={props.orderID}
      identity={{ userID, sessionID }}
    />
  )
}

function PaymentCheckoutSession(props: {
  orderID: string
  identity: PaymentIdentity
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const username = useAuthStore((state) => state.auth.user?.username)
  const [method, setMethod] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [payment, setPayment] = useState<PaymentSession>()
  const [, setClock] = useState(0)
  const active = useRef(true)
  const lock = useRef(false)
  const queryKey = [
    'app-payment-checkout',
    props.orderID,
    props.identity.userID,
    props.identity.sessionID,
  ]
  const statusKey = [...queryKey, 'status']
  const checkout = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getPaymentCheckout(props.orderID, props.identity, signal),
    gcTime: 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: { errorToast: false },
  })
  const status = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) =>
      getPaymentStatus(props.orderID, props.identity, signal),
    enabled: Boolean(checkout.data),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (lock.current) return false
      const state =
        query.state.data?.order.status ?? checkout.data?.order.status
      return state && ['pending', 'processing', 'refunding'].includes(state)
        ? 3000
        : false
    },
    refetchIntervalInBackground: false,
    meta: { errorToast: false },
  })
  const data = checkout.data
  const order = status.data?.order ?? data?.order
  const expired = Boolean(
    order && order.expires_at * 1000 <= Date.now() && order.status === 'pending'
  )
  const nonceExpired = Boolean(
    data && data.confirmation_expires_at * 1000 <= Date.now()
  )
  const effectiveMethod =
    order?.status === 'processing' ? order.payment_method : method
  const selectedMethod = data?.methods.find(
    (item) => item.id === effectiveMethod
  )
  const currentPayment = payment ?? data?.payment
  const destination = safePaymentDestination(currentPayment?.checkout_url)
  const returnURL = safePaymentDestination(order?.return_url)
  const showPayment = order?.status === 'processing'

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (!data || !order || !['pending', 'processing'].includes(order.status)) {
      return
    }
    const next = Math.min(order.expires_at, data.confirmation_expires_at) * 1000
    if (next <= Date.now()) return
    const timeout = window.setTimeout(
      () => setClock((value) => value + 1),
      Math.min(next - Date.now() + 1, 2147483647)
    )
    return () => window.clearTimeout(timeout)
  }, [data, order])

  const mutation = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async () => {
      if (
        !data ||
        !selectedMethod ||
        !order ||
        expired ||
        nonceExpired ||
        !['pending', 'processing'].includes(order.status)
      ) {
        return
      }
      await queryClient.cancelQueries({ queryKey })
      const response = await confirmPayment(
        props.orderID,
        effectiveMethod,
        data.confirmation_nonce,
        props.identity
      )
      if (!active.current) return
      setPayment(response.payment)
      setConfirmOpen(false)
      queryClient.setQueryData(queryKey, {
        ...data,
        order: response.order,
      } satisfies PaymentCheckoutData)
      queryClient.setQueryData(statusKey, { order: response.order })
      await queryClient.invalidateQueries({ queryKey: ['app-payment-orders'] })
    },
    meta: { errorToast: false },
  })
  const submit = async () => {
    if (lock.current) return
    lock.current = true
    try {
      await mutation.mutateAsync()
    } catch {
      /* A safe error is rendered below. */
    } finally {
      lock.current = false
    }
  }
  const reload = async () => {
    mutation.reset()
    const refreshed = await checkout.refetch()
    if (refreshed.data) {
      queryClient.setQueryData(statusKey, { order: refreshed.data.order })
    }
    await status.refetch()
  }

  return (
    <main className='bg-muted/30 flex min-h-svh items-start justify-center px-4 py-8 sm:py-14'>
      <div className='flex w-full max-w-xl min-w-0 flex-col gap-4'>
        <Card>
          <CardHeader>
            <CardTitle>{t('Checkout')}</CardTitle>
            <CardDescription>
              {t('Review your order and choose how to pay.')}
            </CardDescription>
          </CardHeader>
          <CardContent className='flex min-w-0 flex-col gap-5'>
            {checkout.isPending && (
              <Skeleton
                className='h-52 w-full'
                aria-label={t('Loading order')}
              />
            )}
            {checkout.isError && <PaymentErrorAlert error={checkout.error} />}
            {data && order && (
              <>
                <div className='flex min-w-0 flex-col gap-2'>
                  <p className='text-muted-foreground text-sm break-all'>
                    {data.application.name}
                  </p>
                  <h1 className='text-xl font-semibold break-words'>
                    {order.title}
                  </h1>
                  <p className='text-3xl font-semibold tabular-nums'>
                    {formatPaymentAmount(order.amount, order.currency)}
                  </p>
                  <div>
                    <PaymentStatusBadge
                      status={expired ? 'expired' : order.status}
                    />
                  </div>
                </div>
                <dl className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm'>
                  <dt className='text-muted-foreground'>{t('Account')}</dt>
                  <dd className='text-right break-all'>{username}</dd>
                  <dt className='text-muted-foreground'>{t('Order number')}</dt>
                  <dd className='text-right break-all'>{order.out_trade_no}</dd>
                  <dt className='text-muted-foreground'>{t('Expires at')}</dt>
                  <dd className='text-right'>
                    {new Date(order.expires_at * 1000).toLocaleString(
                      toIntlLocale(i18n.language)
                    )}
                  </dd>
                </dl>
                {order.status === 'paid' && (
                  <Alert>
                    <AlertDescription>
                      {t(
                        'Your payment is confirmed. You can return to the app.'
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {order.status === 'refunding' && (
                  <Alert>
                    <AlertDescription>
                      {t(
                        'Your refund is being processed. Check this page for updates.'
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {order.status === 'refunded' && (
                  <Alert>
                    <AlertDescription>
                      {t('This order has been refunded.')}
                    </AlertDescription>
                  </Alert>
                )}
                {order.status === 'canceled' && (
                  <Alert>
                    <AlertDescription>
                      {t(
                        'This order was canceled. Start a new order in the app to pay.'
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {(expired || order.status === 'expired') && (
                  <Alert>
                    <AlertDescription>
                      {t(
                        'This order has expired. Start a new order in the app.'
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {order.status === 'pending' && !expired && (
                  <>
                    <FieldSet disabled={mutation.isPending}>
                      <FieldLegend>{t('Payment method')}</FieldLegend>
                      <RadioGroup
                        value={method}
                        onValueChange={(value) => {
                          setMethod(String(value))
                          mutation.reset()
                        }}
                        aria-label={t('Payment method')}
                      >
                        {data.methods.map((item) => (
                          <Field
                            key={item.id}
                            orientation='horizontal'
                            className='rounded-lg border p-3'
                          >
                            <RadioGroupItem
                              id={`pay-${item.id}`}
                              value={item.id}
                              disabled={
                                mutation.isPending ||
                                (item.id === 'balance' &&
                                  !data.balance.sufficient)
                              }
                            />
                            <FieldLabel
                              htmlFor={`pay-${item.id}`}
                              className='min-w-0 flex-1 break-words'
                            >
                              {item.id === 'balance'
                                ? t('Account balance')
                                : t(item.label)}
                            </FieldLabel>
                          </Field>
                        ))}
                      </RadioGroup>
                    </FieldSet>
                    {data.methods.some((item) => item.id === 'balance') && (
                      <div className='bg-muted rounded-lg p-3 text-sm'>
                        <p>
                          {t('Available balance: {{amount}}', {
                            amount: data.balance.available_display,
                          })}
                        </p>
                        <p>
                          {t('Balance charge for this order: {{amount}}', {
                            amount: data.balance.required_display,
                          })}
                        </p>
                        {!data.balance.sufficient && (
                          <p className='text-destructive mt-1'>
                            {t(
                              'Your balance is insufficient. Choose another payment method.'
                            )}
                          </p>
                        )}
                      </div>
                    )}
                    {data.methods.length === 0 && (
                      <Alert>
                        <AlertDescription>
                          {t(
                            'No payment methods are available for this order.'
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                    {nonceExpired && (
                      <Alert>
                        <AlertDescription>
                          {t(
                            'Your payment confirmation expired. Reload the order to continue.'
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                    <Button
                      type='button'
                      disabled={
                        !selectedMethod || mutation.isPending || nonceExpired
                      }
                      onClick={() => setConfirmOpen(true)}
                    >
                      {t('Review payment')}
                    </Button>
                  </>
                )}
                {showPayment && (
                  <div className='flex flex-col items-center gap-4'>
                    <p
                      role='status'
                      className='text-muted-foreground text-center text-sm'
                    >
                      {t('Waiting for payment confirmation')}
                    </p>
                    {currentPayment?.code_url && (
                      <>
                        <div className='rounded-lg border bg-white p-3'>
                          <QRCodeSVG
                            value={currentPayment.code_url}
                            size={224}
                            role='img'
                            aria-label={t('Payment QR code')}
                          />
                        </div>
                        <p className='text-center text-sm'>
                          {t(
                            'Scan the QR code with WeChat to complete payment'
                          )}
                        </p>
                      </>
                    )}
                    {!destination &&
                      !currentPayment?.code_url &&
                      selectedMethod &&
                      !nonceExpired && (
                        <Button
                          type='button'
                          disabled={mutation.isPending}
                          onClick={() => setConfirmOpen(true)}
                        >
                          {t('Retry')}
                        </Button>
                      )}
                    {destination && (
                      <Button
                        nativeButton={false}
                        render={
                          <a
                            href={destination}
                            referrerPolicy='no-referrer'
                            rel='noreferrer'
                          />
                        }
                      >
                        {t('Continue to payment')}
                      </Button>
                    )}
                    <p className='text-muted-foreground text-center text-xs'>
                      {t(
                        'Payment is confirmed only after the payment service verifies it.'
                      )}
                    </p>
                  </div>
                )}
                {status.isError && <PaymentErrorAlert error={status.error} />}
                {mutation.isError && (
                  <PaymentErrorAlert error={mutation.error} />
                )}
              </>
            )}
          </CardContent>
          <CardFooter className='flex flex-wrap justify-end gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={
                checkout.isFetching || status.isFetching || mutation.isPending
              }
              onClick={() => void reload()}
            >
              {t('Refresh status')}
            </Button>
            {order &&
              returnURL &&
              ['paid', 'canceled', 'expired', 'refunded', 'failed'].includes(
                order.status
              ) && (
                <Button
                  nativeButton={false}
                  render={
                    <a
                      href={returnURL}
                      referrerPolicy='no-referrer'
                      rel='noreferrer'
                    />
                  }
                >
                  {t('Return to app')}
                </Button>
              )}
          </CardFooter>
        </Card>
        <Button
          variant='link'
          nativeButton={false}
          render={<Link to='/payments/orders' />}
        >
          {t('My payment orders')}
        </Button>
      </div>
      <ConfirmDialog
        open={
          confirmOpen &&
          Boolean(
            order &&
            ['pending', 'processing'].includes(order.status) &&
            !expired
          )
        }
        onOpenChange={(open) => {
          if (!mutation.isPending) setConfirmOpen(open)
        }}
        title={t('Confirm payment')}
        desc={
          data && order
            ? t('Pay {{amount}} to {{app}} for {{title}} using {{method}}.', {
                amount: formatPaymentAmount(order.amount, order.currency),
                app: data.application.name,
                title: order.title,
                method:
                  selectedMethod?.id === 'balance'
                    ? t('Account balance')
                    : t(selectedMethod?.label ?? ''),
              })
            : ''
        }
        confirmText={mutation.isPending ? t('Processing...') : t('Pay now')}
        handleConfirm={() => void submit()}
        isLoading={mutation.isPending}
        disabled={nonceExpired || expired}
      >
        {method === 'balance' && data && (
          <p className='text-sm'>
            {t('Your account balance will be charged {{amount}}.', {
              amount: data.balance.required_display,
            })}
          </p>
        )}
        {mutation.isError && <PaymentErrorAlert error={mutation.error} />}
      </ConfirmDialog>
    </main>
  )
}
