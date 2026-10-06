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
import { useEffect, useId } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import {
  useCreateOauthClient,
  useOauthClientCapabilities,
  useUpdateOauthClient,
} from '../hooks/use-oauth-clients'
import {
  type OauthClient,
  type OauthClientFormValues,
  oauthClientFormSchema,
} from '../types'
import { ClientScopeSelector } from './client-scope-selector'

type ClientFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  client: OauthClient | null
  onSecretCreated: (clientId: string, secret: string) => void
}

export function ClientFormDialog(props: ClientFormDialogProps) {
  const { t } = useTranslation()
  const id = useId()
  const createClient = useCreateOauthClient(props.onSecretCreated)
  const updateClient = useUpdateOauthClient()
  const catalog = useOauthClientCapabilities(props.open)
  const isUpdate = !!props.client
  const isPending = createClient.isPending || updateClient.isPending
  const form = useForm<OauthClientFormValues>({
    resolver: zodResolver(oauthClientFormSchema),
    defaultValues: {
      name: '',
      description: '',
      redirect_uris: [''],
      scopes: ['openid', 'profile', 'email'],
      is_public: false,
      enabled: true,
    },
  })

  useEffect(() => {
    if (!props.open) return
    form.reset({
      name: props.client?.name ?? '',
      description: props.client?.description ?? '',
      redirect_uris: props.client?.redirect_uris.length
        ? props.client.redirect_uris
        : [''],
      scopes: props.client?.scopes ?? ['openid', 'profile', 'email'],
      is_public: props.client?.is_public ?? false,
      enabled: props.client?.enabled ?? true,
    })
  }, [props.open, props.client, form])

  const onSubmit = async (values: OauthClientFormValues) => {
    if (!catalog.data || catalog.isError || isPending) return
    const supported = new Set(
      catalog.data.capabilities.map((item) => item.scope)
    )
    if (values.scopes.some((scope) => !supported.has(scope))) {
      form.setError('scopes', { message: 'Select a supported permission' })
      return
    }
    try {
      if (props.client) {
        await updateClient.mutateAsync({ id: props.client.id, values })
      } else await createClient.mutateAsync(values)
      props.onOpenChange(false)
    } catch {
      toast.error(
        isUpdate ? t('Failed to update client') : t('Failed to create client')
      )
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!isPending) props.onOpenChange(open)
      }}
    >
      <DialogContent
        className='max-h-[90dvh] overflow-y-auto sm:max-w-2xl'
        showCloseButton={!isPending}
      >
        <DialogHeader>
          <DialogTitle>
            {isUpdate ? t('Edit Client') : t('Add Client')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Register your own application or a third-party application for sign-in and delegated access.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <FieldGroup className='mb-5'>
            <Field data-invalid={!!form.formState.errors.name}>
              <FieldLabel htmlFor={`${id}-name`}>{t('Name')}</FieldLabel>
              <Input
                id={`${id}-name`}
                {...form.register('name')}
                maxLength={128}
                disabled={isPending}
                aria-invalid={!!form.formState.errors.name}
                placeholder={t('Application name')}
              />
              {form.formState.errors.name?.message ? (
                <FieldError>{t(form.formState.errors.name.message)}</FieldError>
              ) : null}
            </Field>
            <Field data-invalid={!!form.formState.errors.description}>
              <FieldLabel htmlFor={`${id}-description`}>
                {t('Description')}
              </FieldLabel>
              <Input
                id={`${id}-description`}
                {...form.register('description')}
                maxLength={512}
                disabled={isPending}
                aria-invalid={!!form.formState.errors.description}
                placeholder={t('Optional')}
              />
              {form.formState.errors.description?.message ? (
                <FieldError>
                  {t(form.formState.errors.description.message)}
                </FieldError>
              ) : null}
            </Field>
            <Controller
              control={form.control}
              name='redirect_uris'
              render={({ field, fieldState }) => (
                <Field data-invalid={!!fieldState.error}>
                  <FieldLabel htmlFor={`${id}-redirect`}>
                    {t('Redirect URIs')}
                  </FieldLabel>
                  <Textarea
                    ref={field.ref}
                    id={`${id}-redirect`}
                    name={field.name}
                    onBlur={field.onBlur}
                    value={field.value.join('\n')}
                    onChange={(event) =>
                      field.onChange(event.target.value.split('\n'))
                    }
                    disabled={isPending}
                    aria-invalid={!!fieldState.error}
                    aria-describedby={`${id}-redirect-description`}
                    placeholder='https://app.example.com/callback'
                    rows={3}
                  />
                  <FieldDescription id={`${id}-redirect-description`}>
                    {t(
                      'One exact HTTPS callback per line. HTTP is allowed only for localhost and loopback addresses.'
                    )}
                  </FieldDescription>
                  {fieldState.error ? (
                    <FieldError>
                      {t(
                        fieldState.error.message ??
                          'Use an HTTPS callback or a loopback HTTP callback without credentials, fragments, or wildcards'
                      )}
                    </FieldError>
                  ) : null}
                </Field>
              )}
            />
            {catalog.isError ? (
              <Alert variant='destructive'>
                <AlertDescription>
                  {t('Unable to load application permissions')}
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => void catalog.refetch()}
                  >
                    {t('Retry')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {!catalog.data && !catalog.isError ? (
              <Skeleton
                className='h-40 w-full'
                aria-label={t('Loading permissions')}
              />
            ) : null}
            {catalog.data && !catalog.isError ? (
              <Controller
                control={form.control}
                name='scopes'
                render={({ field, fieldState }) => (
                  <ClientScopeSelector
                    capabilities={catalog.data.capabilities}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={isPending}
                    error={fieldState.error?.message}
                  />
                )}
              />
            ) : null}
            <Controller
              control={form.control}
              name='is_public'
              render={({ field }) => (
                <Field
                  orientation='horizontal'
                  data-disabled={isUpdate || isPending}
                >
                  <FieldContent>
                    <FieldLabel htmlFor={`${id}-public`}>
                      {t('Public client (PKCE)')}
                    </FieldLabel>
                    <FieldDescription>
                      {t(
                        'For mobile/desktop apps that cannot keep a secret. PKCE is required.'
                      )}
                    </FieldDescription>
                    {isUpdate ? (
                      <FieldDescription>
                        {t(
                          'Client authentication type cannot be changed after creation.'
                        )}
                      </FieldDescription>
                    ) : null}
                  </FieldContent>
                  <Switch
                    id={`${id}-public`}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={isUpdate || isPending}
                  />
                </Field>
              )}
            />
            {!form.watch('is_public') && !isUpdate ? (
              <FieldDescription>
                {t(
                  'A client secret is generated automatically and shown only once after creation.'
                )}
              </FieldDescription>
            ) : null}
            <Controller
              control={form.control}
              name='enabled'
              render={({ field }) => (
                <Field orientation='horizontal' data-disabled={isPending}>
                  <FieldContent>
                    <FieldLabel htmlFor={`${id}-enabled`}>
                      {t('Enabled')}
                    </FieldLabel>
                    <FieldDescription>
                      {t(
                        'Disabled clients lose access and cannot refresh tokens or start new authorizations.'
                      )}
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id={`${id}-enabled`}
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={isPending}
                  />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={isPending}
              onClick={() => props.onOpenChange(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='submit'
              disabled={isPending || !catalog.data || catalog.isError}
            >
              {isUpdate ? t('Save') : t('Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type SecretRevealDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientId: string
  secret: string
}

export function SecretRevealDialog(props: SecretRevealDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className='min-w-0 grid-cols-[minmax(0,1fr)] sm:max-w-[520px]'>
        <DialogHeader className='min-w-0'>
          <DialogTitle>{t('Client secret')}</DialogTitle>
          <DialogDescription className='min-w-0 [overflow-wrap:anywhere]'>
            {t(
              'Copy this secret now. It is stored hashed and cannot be shown again.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className='flex min-w-0 flex-col gap-3'>
          <div className='flex min-w-0 items-center justify-between gap-2'>
            <span className='text-muted-foreground shrink-0 text-sm'>
              {t('Client ID')}
            </span>
            <span className='flex min-w-0 flex-1 items-center justify-end gap-2'>
              <code className='bg-muted min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-xs'>
                {props.clientId}
              </code>
              <CopyButton
                value={props.clientId}
                aria-label={t('Copy client ID')}
                size='icon'
                className='size-7'
              />
            </span>
          </div>
          <div className='flex min-w-0 items-center justify-between gap-2'>
            <span className='text-muted-foreground shrink-0 text-sm'>
              {t('Client secret')}
            </span>
            <span className='flex min-w-0 flex-1 items-center justify-end gap-2'>
              <code className='bg-muted min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-xs'>
                {props.secret}
              </code>
              <CopyButton
                value={props.secret}
                aria-label={t('Copy client secret')}
                size='icon'
                className='size-7'
              />
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => props.onOpenChange(false)}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
