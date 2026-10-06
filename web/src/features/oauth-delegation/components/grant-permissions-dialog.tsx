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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'

import type { OAuthCapability, OAuthGrant } from '../types'

interface GrantPermissionsDialogProps {
  grant: OAuthGrant
  capabilities: OAuthCapability[]
  pending: boolean
  onClose: () => void
  onSave: (scopes: string[]) => void
}

export function GrantPermissionsDialog(props: GrantPermissionsDialogProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(props.grant.scopes)
  const changed = selected.length !== props.grant.scopes.length

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose()
      }}
    >
      <DialogContent
        className='flex max-h-[85dvh] flex-col sm:max-w-lg'
        showCloseButton={!props.pending}
      >
        <DialogHeader>
          <DialogTitle>{t('Manage application permissions')}</DialogTitle>
          <DialogDescription className='[overflow-wrap:anywhere]'>
            {t(
              'Remove permissions from {{name}}. Adding permissions requires a new authorization.',
              { name: props.grant.client_name }
            )}
          </DialogDescription>
        </DialogHeader>
        <FieldSet className='min-h-0 overflow-y-auto px-1 py-1'>
          <FieldLegend className='sr-only'>
            {t('Retained permissions')}
          </FieldLegend>
          <FieldGroup className='gap-3'>
            {props.grant.scopes.map((scope) => {
              const capability = props.capabilities.find(
                (entry) => entry.scope === scope
              )
              const id = `grant-${props.grant.id}-${scope}`
              return (
                <Field
                  key={scope}
                  orientation='horizontal'
                  data-disabled={props.pending}
                >
                  <Checkbox
                    id={id}
                    checked={selected.includes(scope)}
                    disabled={props.pending}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, scope]
                          : current.filter((entry) => entry !== scope)
                      )
                    }
                  />
                  <FieldContent className='min-w-0'>
                    <FieldLabel
                      htmlFor={id}
                      className='flex-wrap [overflow-wrap:anywhere]'
                    >
                      {capability ? t(capability.label) : scope}
                      {capability?.sensitive && (
                        <Badge variant='outline'>
                          {t('Sensitive permission')}
                        </Badge>
                      )}
                    </FieldLabel>
                    {capability && (
                      <FieldDescription className='[overflow-wrap:anywhere]'>
                        {t(capability.description)}
                      </FieldDescription>
                    )}
                    <code className='text-muted-foreground text-xs break-all'>
                      {scope}
                    </code>
                  </FieldContent>
                </Field>
              )
            })}
          </FieldGroup>
        </FieldSet>
        {selected.length === 0 && (
          <p role='status' className='text-muted-foreground text-sm'>
            {t(
              'To remove every permission, revoke application access instead.'
            )}
          </p>
        )}
        <DialogFooter>
          <Button
            variant='outline'
            disabled={props.pending}
            onClick={props.onClose}
          >
            {t('Cancel')}
          </Button>
          <Button
            disabled={props.pending || !changed || selected.length === 0}
            onClick={() => props.onSave(selected)}
          >
            {t('Save permissions')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
