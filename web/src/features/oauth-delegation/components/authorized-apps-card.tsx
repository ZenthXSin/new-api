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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimestamp } from '@/lib/format'
import { useAuthStore } from '@/stores/auth-store'

import {
  getOauthCapabilities,
  getOauthGrants,
  narrowOauthGrant,
  revokeOauthGrant,
} from '../api'
import type { OAuthGrant } from '../types'
import { GrantPermissionsDialog } from './grant-permissions-dialog'

export function AuthorizedAppsCard() {
  const identity = useAuthStore(
    (state) => `${state.auth.user?.id ?? ''}:${state.auth.session?.sid ?? ''}`
  )
  return <AuthorizedAppsContent key={identity} />
}

function AuthorizedAppsContent() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const userId = useAuthStore((state) => state.auth.user?.id)
  const sessionId = useAuthStore((state) => state.auth.session?.sid)
  const [editTarget, setEditTarget] = useState<OAuthGrant | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<OAuthGrant | null>(null)
  const queryKey = ['profile', 'oauth-grants', userId, sessionId] as const
  const grants = useQuery({
    queryKey,
    queryFn: ({ signal }) => getOauthGrants(signal),
    enabled: !!userId,
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  const capabilities = useQuery({
    queryKey: ['oauth-capabilities', userId, sessionId],
    queryFn: ({ signal }) => getOauthCapabilities(signal),
    enabled: !!userId,
    gcTime: 0,
    retry: false,
    meta: { errorToast: false },
  })
  const revoke = useMutation({
    mutationFn: revokeOauthGrant,
    onSuccess: async () => {
      if (!active.current) return
      setRevokeTarget(null)
      toast.success(t('Application access revoked'))
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: () => {
      if (active.current) toast.error(t('Unable to revoke application access'))
    },
  })
  const narrow = useMutation({
    mutationFn: (input: { id: number; scopes: string[] }) =>
      narrowOauthGrant(input.id, input.scopes),
    onSuccess: async () => {
      if (!active.current) return
      setEditTarget(null)
      toast.success(t('Application permissions updated'))
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: () => {
      if (active.current) {
        toast.error(t('Unable to update application permissions'))
      }
    },
  })
  const currentGrants = grants.data ?? []
  const capabilityList = capabilities.data?.capabilities ?? []

  return (
    <>
      <Card data-card-hover='false' className='max-w-full min-w-0'>
        <CardHeader className='min-w-0 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]'>
          <CardTitle className='min-w-0 [overflow-wrap:anywhere]'>
            {t('Authorized applications')}
          </CardTitle>
          <CardDescription className='min-w-0 [overflow-wrap:anywhere]'>
            {t(
              'Review the applications that can use your account and revoke access at any time.'
            )}
          </CardDescription>
          <CardAction>
            <Button
              variant='outline'
              size='sm'
              disabled={grants.isFetching}
              onClick={() => void grants.refetch()}
            >
              {t('Refresh')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className='min-w-0'>
          {grants.isPending && (
            <div aria-label={t('Loading authorized applications')}>
              <Skeleton className='h-24 w-full' />
            </div>
          )}
          {grants.isError && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {t('Unable to load authorized applications')}
                </EmptyTitle>
                <EmptyDescription>
                  {t('Refresh the list and try again.')}
                </EmptyDescription>
              </EmptyHeader>
              <Button variant='outline' onClick={() => void grants.refetch()}>
                {t('Retry')}
              </Button>
            </Empty>
          )}
          {!grants.isPending &&
            !grants.isError &&
            currentGrants.length === 0 && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('No authorized applications')}</EmptyTitle>
                  <EmptyDescription>
                    {t(
                      'Applications appear here after you approve their access.'
                    )}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          {!grants.isPending && !grants.isError && currentGrants.length > 0 && (
            <div className='flex flex-col gap-4'>
              {currentGrants.map((grant, index) => (
                <div key={grant.id} className='min-w-0'>
                  {index > 0 && <Separator className='mb-4' />}
                  <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
                    <div className='min-w-0 flex-1 space-y-2'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <h3 className='max-w-full min-w-0 font-medium [overflow-wrap:anywhere]'>
                          {grant.client_name || grant.client_id}
                        </h3>
                        <Badge variant={grant.active ? 'secondary' : 'outline'}>
                          {grant.active ? t('Active') : t('Inactive')}
                        </Badge>
                      </div>
                      <p className='text-muted-foreground text-xs break-all'>
                        {grant.client_id}
                      </p>
                      <p className='text-muted-foreground text-xs'>
                        {t('Authorized on {{date}}', {
                          date: formatTimestamp(grant.created_at),
                        })}
                      </p>
                      {grant.expires_at > 0 && (
                        <p className='text-muted-foreground text-xs'>
                          {t('Access expires on {{date}}', {
                            date: formatTimestamp(grant.expires_at),
                          })}
                        </p>
                      )}
                      <details>
                        <summary className='cursor-pointer text-sm'>
                          {t('View {{count}} permissions', {
                            count: grant.scopes.length,
                          })}
                        </summary>
                        <ul className='mt-2 space-y-1'>
                          {grant.scopes.map((scope) => {
                            const capability = capabilityList.find(
                              (entry) => entry.scope === scope
                            )
                            return (
                              <li
                                key={scope}
                                className='text-sm [overflow-wrap:anywhere]'
                              >
                                {capability ? t(capability.label) : scope}
                              </li>
                            )
                          })}
                        </ul>
                      </details>
                    </div>
                    {grant.active && (
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={narrow.isPending || revoke.isPending}
                          onClick={() => setEditTarget(grant)}
                        >
                          {t('Manage permissions')}
                        </Button>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={narrow.isPending || revoke.isPending}
                          onClick={() => setRevokeTarget(grant)}
                        >
                          {t('Revoke access')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {editTarget && (
        <GrantPermissionsDialog
          key={editTarget.id}
          grant={editTarget}
          capabilities={capabilityList}
          pending={narrow.isPending}
          onClose={() => setEditTarget(null)}
          onSave={(scopes) => narrow.mutate({ id: editTarget.id, scopes })}
        />
      )}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setRevokeTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Revoke application access?')}
            </AlertDialogTitle>
            <AlertDialogDescription className='[overflow-wrap:anywhere]'>
              {t(
                '{{name}} will lose access immediately. Its existing tokens will stop working.',
                {
                  name:
                    revokeTarget?.client_name || revokeTarget?.client_id || '',
                }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              {t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={revoke.isPending}
              onClick={() => {
                if (revokeTarget) revoke.mutate(revokeTarget.id)
              }}
            >
              {t('Revoke access')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
