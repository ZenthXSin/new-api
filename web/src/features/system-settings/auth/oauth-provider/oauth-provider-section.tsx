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
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { PaymentApplicationSettings } from '@/features/app-payments/application-settings'
import { useAuthStore } from '@/stores/auth-store'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../../components/settings-form-layout'
import { SettingsPageFormActions } from '../../components/settings-page-context'
import { SettingsSection } from '../../components/settings-section'
import { useResetForm } from '../../hooks/use-reset-form'
import { useUpdateOption } from '../../hooks/use-update-option'
import type { UpdateOptionRequest } from '../../types'
import {
  ClientFormDialog,
  SecretRevealDialog,
} from './components/client-form-dialog'
import { ClientTable } from './components/client-table'
import {
  useOauthClients,
  useResetOauthClientSecret,
} from './hooks/use-oauth-clients'
import type { OauthClient } from './types'

/**
 * react-hook-form 7 treats dotted `name` strings as nested paths. The
 * `oauth_provider.*` fields are therefore modeled as a nested object here and
 * flattened back to dotted server keys only when persisting (same pattern as
 * the discord/oidc fields in ../oauth-section.tsx).
 */
const oauthProviderSchema = z.object({
  oauth_provider: z.object({
    enabled: z.boolean(),
    issuer: z.string(),
    access_token_ttl_minutes: z.string().refine((value) => {
      const parsed = Number.parseInt(value, 10)
      return Number.isFinite(parsed) && parsed >= 5 && parsed <= 43200
    }, 'Must be between 5 and 43200'),
  }),
})

type OauthProviderFormValues = z.infer<typeof oauthProviderSchema>

type OauthProviderSectionProps = {
  defaultValues: {
    'oauth_provider.enabled': boolean
    'oauth_provider.issuer': string
    'oauth_provider.access_token_ttl_minutes': number
  }
  serverAddress: string
}

export function OauthProviderSection(props: OauthProviderSectionProps) {
  const user = useAuthStore((state) => state.auth.user)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  return (
    <OauthProviderSectionContent
      key={`${user?.id}:${user?.role}:${sessionID}`}
      {...props}
    />
  )
}

function OauthProviderSectionContent(props: OauthProviderSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const clientQuery = useOauthClients()
  const clients = clientQuery.data ?? []
  const [formDialogOpen, setFormDialogOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<OauthClient | null>(null)
  const [secretDialog, setSecretDialog] = useState<{
    clientId: string
    secret: string
  } | null>(null)
  const [resetTarget, setResetTarget] = useState<OauthClient | null>(null)
  const [paymentTarget, setPaymentTarget] = useState<OauthClient | null>(null)
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  const resetSecret = useResetOauthClientSecret((id, secret) => {
    const client = clients.find((item) => item.id === id)
    if (client) setSecretDialog({ clientId: client.client_id, secret })
  })

  const handleResetSecret = async () => {
    if (!resetTarget || resetSecret.isPending) return
    try {
      await resetSecret.mutateAsync(resetTarget.id)
      setResetTarget(null)
    } catch {
      toast.error(t('Failed to reset client secret'))
    }
  }

  const { defaultValues } = props
  const formDefaults = useMemo<OauthProviderFormValues>(
    () => ({
      oauth_provider: {
        enabled: defaultValues['oauth_provider.enabled'],
        issuer: defaultValues['oauth_provider.issuer'],
        access_token_ttl_minutes: String(
          defaultValues['oauth_provider.access_token_ttl_minutes']
        ),
      },
    }),
    [defaultValues]
  )

  const form = useForm<OauthProviderFormValues>({
    resolver: zodResolver(oauthProviderSchema),
    defaultValues: formDefaults,
  })

  useResetForm(form, formDefaults)

  const onSubmit = async (data: OauthProviderFormValues) => {
    const updates: UpdateOptionRequest[] = []
    const { enabled, issuer, access_token_ttl_minutes } = data.oauth_provider
    if (enabled !== props.defaultValues['oauth_provider.enabled']) {
      updates.push({ key: 'oauth_provider.enabled', value: enabled })
    }
    if (issuer !== props.defaultValues['oauth_provider.issuer']) {
      updates.push({ key: 'oauth_provider.issuer', value: issuer })
    }
    const ttl = Number.parseInt(access_token_ttl_minutes, 10)
    const previousTtl = Number.parseInt(
      String(props.defaultValues['oauth_provider.access_token_ttl_minutes']),
      10
    )
    if (Number.isFinite(previousTtl) && ttl !== previousTtl) {
      updates.push({
        key: 'oauth_provider.access_token_ttl_minutes',
        value: ttl,
      })
    }
    for (const update of updates) {
      await updateOption.mutateAsync(update)
    }
    if (updates.length > 0) {
      toast.success(t('Saved successfully'))
    }
  }

  const watchedIssuer = form.watch('oauth_provider.issuer')
  const issuerBase = (
    watchedIssuer ||
    props.defaultValues['oauth_provider.issuer'] ||
    `${props.serverAddress}/oidc`
  ).replace(/\/+$/, '')
  const discoveryUrl = `${issuerBase}/.well-known/openid-configuration`

  return (
    <SettingsSection title={t('OAuth applications and sign-in')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
          />
          <FormField
            control={form.control}
            name='oauth_provider.enabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable OAuth and OIDC provider')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Allow your own and third-party applications to sign in and use explicitly authorized site features.'
                    )}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </SettingsSwitchItem>
            )}
          />
          <FormField
            control={form.control}
            name='oauth_provider.issuer'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Issuer URL')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={`${props.serverAddress}/oidc`}
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Third parties only need this URL; discovery and endpoints are derived from it.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='oauth_provider.access_token_ttl_minutes'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('ID token lifetime (minutes)')}</FormLabel>
                <FormControl>
                  <Input type='number' min={5} max={43200} {...field} />
                </FormControl>
                <FormDescription>
                  {t(
                    'Access tokens expire after 15 minutes. This setting controls identity tokens.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </SettingsForm>
      </Form>

      <Alert>
        <AlertTitle>{t('Discovery URL')}</AlertTitle>
        <AlertDescription className='space-y-3 text-sm'>
          <p>
            {t(
              'Share this discovery URL with applications integrating sign-in and delegated access.'
            )}
          </p>
          <div className='flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between'>
            <code className='bg-muted text-foreground min-w-0 truncate rounded px-1.5 py-0.5 text-xs'>
              {discoveryUrl}
            </code>
            <CopyButton value={discoveryUrl} size='icon' className='size-7' />
          </div>
        </AlertDescription>
      </Alert>

      {clientQuery.isError ? (
        <Alert variant='destructive'>
          <AlertTitle>{t('Failed to load OAuth clients')}</AlertTitle>
          <AlertDescription>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void clientQuery.refetch()}
            >
              {t('Retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {clientQuery.isLoading ? (
        <Skeleton className='h-32 w-full' aria-label={t('Loading...')} />
      ) : null}
      {!clientQuery.isError && !clientQuery.isLoading ? (
        <ClientTable
          clients={clients}
          onEdit={(client) => {
            setEditingClient(client)
            setFormDialogOpen(true)
          }}
          onCreate={() => {
            setEditingClient(null)
            setFormDialogOpen(true)
          }}
          onResetSecret={(client) => setResetTarget(client)}
          onPayments={role >= 100 ? setPaymentTarget : undefined}
        />
      ) : null}

      <ClientFormDialog
        open={formDialogOpen}
        onOpenChange={(open) => {
          setFormDialogOpen(open)
          if (!open) setEditingClient(null)
        }}
        client={editingClient}
        onSecretCreated={(clientId, secret) => {
          setSecretDialog({ clientId, secret })
        }}
      />
      <ConfirmDialog
        open={!!resetTarget}
        onOpenChange={(open) =>
          !open && !resetSecret.isPending && setResetTarget(null)
        }
        title={t('Reset client secret')}
        desc={t(
          'The current secret stops working immediately. Applications must be updated with the new secret.'
        )}
        confirmText={t('Reset secret')}
        destructive
        handleConfirm={handleResetSecret}
        isLoading={resetSecret.isPending}
      />
      <SecretRevealDialog
        open={!!secretDialog}
        onOpenChange={(open) => !open && setSecretDialog(null)}
        clientId={secretDialog?.clientId ?? ''}
        secret={secretDialog?.secret ?? ''}
      />
      {paymentTarget && (
        <PaymentApplicationSettings
          clientID={paymentTarget.client_id}
          clientName={paymentTarget.name}
          open
          onOpenChange={(open) => !open && setPaymentTarget(null)}
        />
      )}
    </SettingsSection>
  )
}
