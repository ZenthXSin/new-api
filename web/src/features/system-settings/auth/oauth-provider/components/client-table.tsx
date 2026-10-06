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
import { KeyRound, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { BadgeCell } from '@/components/data-table/core/badge-cell'
import { StaticDataTable } from '@/components/data-table/static/static-data-table'
import { StaticRowActions } from '@/components/data-table/static/static-row-actions'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'

import { useDeleteOauthClient } from '../hooks/use-oauth-clients'
import type { OauthClient } from '../types'

type ClientTableProps = {
  clients: OauthClient[]
  onEdit: (client: OauthClient) => void
  onCreate: () => void
  onResetSecret: (client: OauthClient) => void
  onPayments?: (client: OauthClient) => void
}

export function ClientTable(props: ClientTableProps) {
  const { t } = useTranslation()
  const deleteClient = useDeleteOauthClient()
  const [deleteTarget, setDeleteTarget] = useState<OauthClient | null>(null)

  const handleDelete = async () => {
    if (!deleteTarget || deleteClient.isPending) return
    try {
      await deleteClient.mutateAsync(deleteTarget.id)
      setDeleteTarget(null)
    } catch {
      toast.error(t('Failed to delete client'))
    }
  }

  return (
    <>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <p className='text-muted-foreground text-sm'>
          {t(
            'Manage applications that can request sign-in and delegated access to this site.'
          )}
        </p>
        <Button size='sm' onClick={props.onCreate}>
          <Plus className='size-4' aria-hidden='true' />
          {t('Add Client')}
        </Button>
      </div>

      <StaticDataTable
        data={props.clients}
        getRowKey={(client) => client.id}
        emptyClassName='text-sm'
        emptyContent={t('No OAuth clients configured yet.')}
        columns={[
          {
            id: 'name',
            header: t('Name'),
            cellClassName: 'font-medium',
            cell: (client) => (
              <div className='min-w-0'>
                <div className='truncate'>{client.name}</div>
                {client.description ? (
                  <div className='text-muted-foreground truncate text-xs'>
                    {client.description}
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            id: 'client-id',
            header: t('Client ID'),
            cellClassName:
              'text-muted-foreground max-w-[140px] truncate font-mono',
            cell: (client) => client.client_id,
          },
          {
            id: 'type',
            header: t('Type'),
            cell: (client) => (
              <BadgeCell>
                <StatusBadge
                  label={
                    client.is_public ? t('Public (PKCE)') : t('Confidential')
                  }
                  variant='neutral'
                  copyable={false}
                />
              </BadgeCell>
            ),
          },
          {
            id: 'permissions',
            header: t('Allowed permissions'),
            cell: (client) => (
              <details className='max-w-64 text-sm'>
                <summary className='cursor-pointer'>
                  {t('{{count}} permissions', { count: client.scopes.length })}
                </summary>
                <ul className='mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto font-mono text-xs break-all'>
                  {client.scopes.map((scope) => (
                    <li key={scope}>{scope}</li>
                  ))}
                </ul>
              </details>
            ),
          },
          {
            id: 'status',
            header: t('Status'),
            cell: (client) => (
              <BadgeCell>
                <StatusBadge
                  label={client.enabled ? t('Enabled') : t('Disabled')}
                  variant={client.enabled ? 'success' : 'neutral'}
                  copyable={false}
                />
              </BadgeCell>
            ),
          },
          {
            id: 'actions',
            header: t('Actions'),
            className: 'text-right',
            cellClassName: 'flex justify-end gap-1',
            cell: (client) => (
              <div className='flex justify-end gap-1'>
                {props.onPayments && !client.is_public && (
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => props.onPayments?.(client)}
                  >
                    {t('Payment settings')}
                  </Button>
                )}
                <Button
                  variant='ghost'
                  size='icon-sm'
                  disabled={client.is_public}
                  aria-label={
                    client.is_public
                      ? t('Public clients have no secret')
                      : t('Reset secret')
                  }
                  title={
                    client.is_public
                      ? t('Public clients have no secret')
                      : t('Reset secret')
                  }
                  onClick={() => props.onResetSecret(client)}
                >
                  <KeyRound className='size-4' aria-hidden='true' />
                </Button>
                <StaticRowActions
                  editLabel={t('Edit')}
                  deleteLabel={t('Delete')}
                  menuLabel={t('Open menu')}
                  onEdit={() => props.onEdit(client)}
                  onDelete={() => setDeleteTarget(client)}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) =>
          !open && !deleteClient.isPending && setDeleteTarget(null)
        }
        title={t('Delete Client')}
        desc={t(
          'Are you sure you want to delete "{{name}}"? Applications using this client will immediately lose access.',
          { name: deleteTarget?.name || '' }
        )}
        confirmText={t('Delete')}
        destructive
        handleConfirm={handleDelete}
        isLoading={deleteClient.isPending}
      />
    </>
  )
}
