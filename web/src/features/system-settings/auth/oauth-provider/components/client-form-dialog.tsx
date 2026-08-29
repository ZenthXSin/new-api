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
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import {
  useCreateOauthClient,
  useUpdateOauthClient,
} from '../hooks/use-oauth-clients'
import {
  OAUTH_SCOPE_OPTIONS,
  type OauthClient,
  type OauthClientFormValues,
  oauthClientFormSchema,
} from '../types'

type ClientFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  client: OauthClient | null
  onSecretCreated: (clientId: string, secret: string) => void
}

export function ClientFormDialog(props: ClientFormDialogProps) {
  const { t } = useTranslation()
  const createClient = useCreateOauthClient()
  const updateClient = useUpdateOauthClient()
  const isUpdate = !!props.client

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
    if (props.client) {
      form.reset({
        name: props.client.name,
        description: props.client.description,
        redirect_uris:
          props.client.redirect_uris.length > 0
            ? props.client.redirect_uris
            : [''],
        scopes: props.client.scopes,
        is_public: props.client.is_public,
        enabled: props.client.enabled,
      })
    } else {
      form.reset({
        name: '',
        description: '',
        redirect_uris: [''],
        scopes: ['openid', 'profile', 'email'],
        is_public: false,
        enabled: true,
      })
    }
  }, [props.open, props.client, form])

  const isPublic = form.watch('is_public')

  const onSubmit = async (values: OauthClientFormValues) => {
    const cleaned: OauthClientFormValues = {
      ...values,
      redirect_uris: values.redirect_uris
        .map((uri) => uri.trim())
        .filter(Boolean),
    }
    try {
      if (isUpdate && props.client) {
        const res = await updateClient.mutateAsync({
          id: props.client.id,
          values: cleaned,
        })
        if (!res.success) {
          toast.error(res.message || t('Failed to update client'))
          return
        }
      } else {
        const res = await createClient.mutateAsync(cleaned)
        if (!res.success) {
          toast.error(res.message || t('Failed to create client'))
          return
        }
        if (res.data?.client_secret) {
          props.onSecretCreated(
            res.data.client.client_id,
            res.data.client_secret
          )
        }
      }
      props.onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('An error occurred')
      )
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className='sm:max-w-[560px]'>
        <DialogHeader>
          <DialogTitle>
            {isUpdate ? t('Edit Client') : t('Add Client')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Register a third-party application for "Sign in with this site".'
            )}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className='space-y-4'
          >
            <FormField
              control={form.control}
              name='name'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Name')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t('Application name')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='description'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Description')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t('Optional')} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='redirect_uris'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Redirect URIs')}</FormLabel>
                  <FormControl>
                    <Textarea
                      value={(field.value || []).join('\n')}
                      onChange={(event) =>
                        field.onChange(event.target.value.split('\n'))
                      }
                      placeholder="https://app.example.com/callback"
                      rows={3}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'One exact callback URL per line. Exact match is enforced.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='scopes'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Allowed Scopes')}</FormLabel>
                  <div className='space-y-2'>
                    {OAUTH_SCOPE_OPTIONS.map((option) => {
                      const checked = (field.value || []).includes(
                        option.value
                      )
                      return (
                        <label
                          key={option.value}
                          className='flex items-center gap-2 text-sm'
                        >
                          <input
                            type='checkbox'
                            checked={checked}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...(field.value || []), option.value]
                                : (field.value || []).filter(
                                    (scope) => scope !== option.value
                                  )
                              field.onChange(next)
                            }}
                          />
                          <span>{t(option.labelKey)}</span>
                        </label>
                      )
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='is_public'
              render={({ field }) => (
                <FormItem className='flex items-center justify-between rounded-md border p-3'>
                  <div className='space-y-0.5'>
                    <FormLabel>{t('Public client (PKCE)')}</FormLabel>
                    <FormDescription>
                      {t(
                        'For mobile/desktop apps that cannot keep a secret. PKCE is required.'
                      )}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            {!isPublic ? (
              <p className='text-muted-foreground text-sm'>
                {t(
                  'A client secret is generated automatically and shown only once after creation.'
                )}
              </p>
            ) : null}
            <FormField
              control={form.control}
              name='enabled'
              render={({ field }) => (
                <FormItem className='flex items-center justify-between rounded-md border p-3'>
                  <div className='space-y-0.5'>
                    <FormLabel>{t('Enabled')}</FormLabel>
                    <FormDescription>
                      {t('Disabled clients cannot start new authorizations.')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => props.onOpenChange(false)}
              >
                {t('Cancel')}
              </Button>
              <Button
                type='submit'
                disabled={createClient.isPending || updateClient.isPending}
              >
                {isUpdate ? t('Save') : t('Create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
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
      <DialogContent className='sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>{t('Client secret')}</DialogTitle>
          <DialogDescription>
            {t(
              'Copy this secret now. It is stored hashed and cannot be shown again.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-3'>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-muted-foreground text-sm'>
              {t('Client ID')}
            </span>
            <span className='flex min-w-0 items-center gap-2'>
              <code className='bg-muted min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-xs'>
                {props.clientId}
              </code>
              <CopyButton value={props.clientId} size='icon' className='size-7' />
            </span>
          </div>
          <div className='flex items-center justify-between gap-2'>
            <span className='text-muted-foreground text-sm'>
              {t('Client secret')}
            </span>
            <span className='flex min-w-0 items-center gap-2'>
              <code className='bg-muted min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-xs'>
                {props.secret}
              </code>
              <CopyButton value={props.secret} size='icon' className='size-7' />
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => props.onOpenChange(false)}>
            {t('Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
