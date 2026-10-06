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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAuthStore } from '@/stores/auth-store'

import {
  getPaymentApplication,
  rotatePaymentSecret,
  savePaymentApplication,
} from './api'
import { PaymentErrorAlert } from './components/payment-error'
import { PaymentEvents } from './components/payment-events'
import { PaymentOrderList } from './orders'
import type {
  PaymentApplication,
  PaymentApplicationInput,
  PaymentIdentity,
} from './types'

const schema = z.object({
  enabled: z.boolean(),
  webhook_url: z
    .string()
    .trim()
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.hash
        )
      } catch {
        return false
      }
    }, 'Enter an HTTPS notification URL without credentials or fragments.'),
  methods: z.array(z.string()).min(1, 'Select at least one payment method.'),
})

export function PaymentApplicationSettings(props: {
  clientID: string
  clientName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const userID = useAuthStore((state) => state.auth.user?.id)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  if (role < 100 || !userID || !sessionID || !props.open) return null
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{t('Application payments')}</DialogTitle>
          <DialogDescription>{props.clientName}</DialogDescription>
        </DialogHeader>
        <ApplicationSettingsSession
          key={`${props.clientID}:${userID}:${sessionID}`}
          clientID={props.clientID}
          identity={{ userID, sessionID }}
        />
      </DialogContent>
    </Dialog>
  )
}

function ApplicationSettingsSession(props: {
  clientID: string
  identity: PaymentIdentity
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const queryKey = [
    'app-payment-application',
    props.clientID,
    props.identity.userID,
    props.identity.sessionID,
  ]
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getPaymentApplication(props.clientID, props.identity, signal),
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  const [secret, setSecret] = useState('')
  const [rotateOpen, setRotateOpen] = useState(false)
  const [showOrders, setShowOrders] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const save = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async (input: PaymentApplicationInput) => {
      const response = await savePaymentApplication(
        props.clientID,
        input,
        props.identity
      )
      if (!active.current) return
      const { webhook_secret: newSecret, ...application } = response
      queryClient.setQueryData(queryKey, application)
      if (newSecret) setSecret(newSecret)
    },
    meta: { errorToast: false },
  })
  const rotate = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async () => {
      const response = await rotatePaymentSecret(props.clientID, props.identity)
      if (active.current) {
        setSecret(response.webhook_secret)
        setRotateOpen(false)
      }
    },
    meta: { errorToast: false },
  })
  const submit = async (input: PaymentApplicationInput) => {
    try {
      await save.mutateAsync(input)
    } catch {
      /* Displayed below. */
    }
  }
  return (
    <div className='flex min-w-0 flex-col gap-5'>
      {query.isPending && (
        <Skeleton
          className='h-64 w-full'
          aria-label={t('Loading payment settings')}
        />
      )}
      {query.isError && (
        <>
          <PaymentErrorAlert error={query.error} />
          <Button
            type='button'
            variant='outline'
            onClick={() => void query.refetch()}
          >
            {t('Retry')}
          </Button>
        </>
      )}
      {query.data && (
        <>
          <PaymentSettingsForm
            key={query.dataUpdatedAt}
            application={query.data}
            pending={save.isPending || rotate.isPending}
            onSubmit={submit}
          />
          {save.isSuccess && (
            <p role='status' className='text-sm'>
              {t('Saved successfully')}
            </p>
          )}
          {save.isError && <PaymentErrorAlert error={save.error} />}
          {secret && (
            <Alert>
              <AlertDescription>
                <p>
                  {t(
                    'Copy this notification secret now. It will not be shown again.'
                  )}
                </p>
                <div className='flex min-w-0 items-center gap-2'>
                  <Input
                    aria-label={t('Notification secret')}
                    value={secret}
                    readOnly
                    autoComplete='off'
                  />
                  <CopyButton
                    value={secret}
                    aria-label={t('Copy notification secret')}
                  />
                </div>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => {
                    setSecret('')
                    save.reset()
                    rotate.reset()
                  }}
                >
                  {t('Clear secret')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={
                !query.data.has_webhook_secret ||
                save.isPending ||
                rotate.isPending
              }
              onClick={() => setRotateOpen(true)}
            >
              {t('Rotate notification secret')}
            </Button>
            <Button
              type='button'
              variant='outline'
              onClick={() => setShowOrders((value) => !value)}
              aria-expanded={showOrders}
            >
              {t('Application orders')}
            </Button>
            <Button
              type='button'
              variant='outline'
              onClick={() => setShowEvents((value) => !value)}
              aria-expanded={showEvents}
            >
              {t('Payment notifications')}
            </Button>
          </div>
          {showOrders && <PaymentOrderList clientID={props.clientID} />}
          {showEvents && (
            <PaymentEvents
              clientID={props.clientID}
              identity={props.identity}
            />
          )}
        </>
      )}
      <ConfirmDialog
        open={rotateOpen}
        onOpenChange={(open) => {
          if (!rotate.isPending) setRotateOpen(open)
        }}
        title={t('Rotate notification secret')}
        desc={t(
          'New notifications use the new secret. Keep the previous secret until queued notifications have been delivered.'
        )}
        confirmText={t('Rotate secret')}
        isLoading={rotate.isPending}
        handleConfirm={() => {
          void rotate.mutateAsync().catch(() => undefined)
        }}
      >
        {rotate.isError && <PaymentErrorAlert error={rotate.error} />}
      </ConfirmDialog>
    </div>
  )
}

function PaymentSettingsForm(props: {
  application: PaymentApplication
  pending: boolean
  onSubmit: (input: PaymentApplicationInput) => Promise<void>
}) {
  const { t } = useTranslation()
  const form = useForm<PaymentApplicationInput>({
    resolver: zodResolver(schema),
    defaultValues: {
      enabled: props.application.enabled,
      webhook_url: props.application.webhook_url,
      methods: props.application.methods,
    },
  })
  return (
    <form
      className='flex flex-col gap-5'
      onSubmit={form.handleSubmit(props.onSubmit)}
    >
      <Controller
        control={form.control}
        name='enabled'
        render={({ field }) => (
          <Field orientation='horizontal' data-disabled={props.pending}>
            <FieldLabel htmlFor='payment-enabled'>
              {t('Enable application payments')}
            </FieldLabel>
            <Switch
              id='payment-enabled'
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={props.pending}
            />
          </Field>
        )}
      />
      <Field data-invalid={Boolean(form.formState.errors.webhook_url)}>
        <FieldLabel htmlFor='payment-webhook'>
          {t('Payment notification URL')}
        </FieldLabel>
        <Input
          id='payment-webhook'
          {...form.register('webhook_url')}
          placeholder='https://app.example.com/payment-notifications'
          disabled={props.pending}
          aria-invalid={Boolean(form.formState.errors.webhook_url)}
        />
        <FieldDescription>
          {t(
            'Payment and refund notifications are sent to this application address.'
          )}
        </FieldDescription>
        {form.formState.errors.webhook_url && (
          <FieldError>
            {t(form.formState.errors.webhook_url.message ?? '')}
          </FieldError>
        )}
      </Field>
      <FieldSet disabled={props.pending}>
        <FieldLegend>{t('Accepted payment methods')}</FieldLegend>
        <Controller
          control={form.control}
          name='methods'
          render={({ field }) => (
            <div className='grid gap-3 sm:grid-cols-2'>
              {props.application.available_methods.map((method) => (
                <Field key={method.id} orientation='horizontal'>
                  <Checkbox
                    id={`accept-${method.id}`}
                    checked={field.value.includes(method.id)}
                    onCheckedChange={(checked) =>
                      field.onChange(
                        checked
                          ? [...field.value, method.id]
                          : field.value.filter((value) => value !== method.id)
                      )
                    }
                    disabled={props.pending}
                  />
                  <FieldLabel htmlFor={`accept-${method.id}`}>
                    {method.id === 'balance'
                      ? t('Account balance')
                      : t(method.label)}
                  </FieldLabel>
                </Field>
              ))}
            </div>
          )}
        />
        {form.formState.errors.methods && (
          <FieldError>
            {t(form.formState.errors.methods.message ?? '')}
          </FieldError>
        )}
      </FieldSet>
      <p className='text-muted-foreground text-sm'>
        {t(
          'Customers use the site payment accounts. The application receives order notifications.'
        )}
      </p>
      <Button type='submit' disabled={props.pending}>
        {props.pending ? t('Saving...') : t('Save payment settings')}
      </Button>
    </form>
  )
}
