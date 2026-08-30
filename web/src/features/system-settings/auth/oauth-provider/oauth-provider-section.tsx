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
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'

import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import { SettingsSection } from '../../components/settings-section'
import { useResetForm } from '../../hooks/use-reset-form'
import { useUpdateOption } from '../../hooks/use-update-option'
import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../../components/settings-form-layout'
import { SettingsPageFormActions } from '../../components/settings-page-context'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import * as z from 'zod'
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
import type { UpdateOptionRequest } from '../../types'

import { ClientFormDialog, SecretRevealDialog } from './components/client-form-dialog'
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
    access_token_ttl_minutes: z
      .string()
      .refine((value) => {
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
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const { data: clients = [], isLoading } = useOauthClients()
  const [formDialogOpen, setFormDialogOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<OauthClient | null>(null)
  const [secretDialog, setSecretDialog] = useState<{
    clientId: string
    secret: string
  } | null>(null)
  const [resetTarget, setResetTarget] = useState<OauthClient | null>(null)
  const resetSecret = useResetOauthClientSecret()

  const handleResetSecret = async () => {
    if (!resetTarget) return
    try {
      const res = await resetSecret.mutateAsync(resetTarget.id)
      if (res.success && res.data?.client_secret) {
        setSecretDialog({
          clientId: resetTarget.client_id,
          secret: res.data.client_secret,
        })
      } else {
        toast.error(res.message || t('Failed to reset client secret'))
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('An error occurred')
      )
    }
    setResetTarget(null)
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
  const issuerBase = (watchedIssuer || props.defaultValues['oauth_provider.issuer'] || `${props.serverAddress}/oidc`).replace(/\/+$/, '')
  const discoveryUrl = `${issuerBase}/.well-known/openid-configuration`

  return (
    <SettingsSection title={t('Sign in with this site (OIDC Provider)')}>
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
                  <FormLabel>{t('Enable OIDC Provider')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Allow third-party websites and apps to authenticate users with this site.'
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
                <FormLabel>{t('Access token lifetime (minutes)')}</FormLabel>
                <FormControl>
                  <Input type='number' min={5} max={43200} {...field} />
                </FormControl>
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
            {t('Share this URL with the application integrating your login.')}
          </p>
          <div className='flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between'>
            <code className='bg-muted text-foreground min-w-0 truncate rounded px-1.5 py-0.5 text-xs'>
              {discoveryUrl}
            </code>
            <CopyButton value={discoveryUrl} size='icon' className='size-7' />
          </div>
        </AlertDescription>
      </Alert>

      {isLoading ? (
        <div className='text-muted-foreground py-8 text-center text-sm'>
          {t('Loading...')}
        </div>
      ) : (
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
        />
      )}

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
        onOpenChange={(open) => !open && setResetTarget(null)}
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
    </SettingsSection>
  )
}
