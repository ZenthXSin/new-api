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
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'

import type { ConsentCapability } from '../api'

export function ConsentPermissions(props: {
  capabilities: ConsentCapability[]
  resources: string[]
  selectedScopes: string[]
  disabled: boolean
  onChange: (scopes: string[]) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const selected = new Set(props.selectedScopes)
  const allSelected = props.capabilities.every((item) =>
    selected.has(item.scope)
  )
  const sensitive = props.capabilities.some(
    (item) => item.sensitive && selected.has(item.scope)
  )

  return (
    <FieldSet disabled={props.disabled}>
      <FieldLegend>{t('Requested permissions')}</FieldLegend>
      <FieldDescription>
        {t(
          'Select the permissions to share. This authorization only includes the permissions shown here; future permissions require new approval.'
        )}
      </FieldDescription>
      {props.resources.length > 0 && (
        <FieldDescription>
          {t('Access targets')}
          {': '}
          {props.resources.map((resource) => (
            <Badge key={resource} variant='secondary' className='mr-1'>
              {resource === 'urn:new-api:relay'
                ? t('Model API')
                : t('Account and administration API')}
            </Badge>
          ))}
        </FieldDescription>
      )}
      <FieldGroup className='gap-4'>
        <Field orientation='horizontal' data-disabled={props.disabled}>
          <Checkbox
            id={`${id}-all`}
            checked={allSelected}
            indeterminate={!allSelected && selected.size > 0}
            disabled={props.disabled}
            onCheckedChange={(checked) =>
              props.onChange(
                checked ? props.capabilities.map((item) => item.scope) : []
              )
            }
          />
          <FieldLabel htmlFor={`${id}-all`}>
            {t('Select all requested permissions')}
          </FieldLabel>
        </Field>
        <FieldGroup className='gap-4'>
          {props.capabilities.map((capability) => (
            <Field
              key={capability.scope}
              orientation='horizontal'
              data-disabled={props.disabled}
            >
              <Checkbox
                id={`${id}-${capability.scope}`}
                aria-describedby={`${id}-${capability.scope}-description`}
                checked={selected.has(capability.scope)}
                disabled={props.disabled}
                onCheckedChange={(checked) => {
                  const next = new Set(selected)
                  if (checked) next.add(capability.scope)
                  else next.delete(capability.scope)
                  props.onChange(
                    props.capabilities
                      .filter((item) => next.has(item.scope))
                      .map((item) => item.scope)
                  )
                }}
              />
              <FieldContent className='min-w-0'>
                <FieldLabel
                  htmlFor={`${id}-${capability.scope}`}
                  className='flex-wrap break-words'
                >
                  {t(capability.label)}{' '}
                  {capability.sensitive && (
                    <Badge variant='warning'>{t('Sensitive')}</Badge>
                  )}
                </FieldLabel>
                <FieldDescription
                  id={`${id}-${capability.scope}-description`}
                  className='break-words'
                >
                  {capability.description
                    ? t(capability.description)
                    : capability.scope}
                </FieldDescription>
                {capability.description && (
                  <code className='text-muted-foreground text-xs break-all'>
                    {capability.scope}
                  </code>
                )}
              </FieldContent>
            </Field>
          ))}
        </FieldGroup>
      </FieldGroup>
      {sensitive && (
        <Alert variant='destructive'>
          <AlertTitle>{t('Sensitive permissions selected')}</AlertTitle>
          <AlertDescription>
            {t(
              'These permissions can change account data, spend balance, or administer the service. Only approve applications you trust. Some actions require verification here.'
            )}
          </AlertDescription>
        </Alert>
      )}
    </FieldSet>
  )
}
