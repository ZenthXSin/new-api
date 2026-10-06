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
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { OAuthCapability } from '@/features/oauth-delegation/types'

interface ClientScopeSelectorProps {
  capabilities: OAuthCapability[]
  value: string[]
  onChange: (value: string[]) => void
  disabled?: boolean
  error?: string
}

export function ClientScopeSelector(props: ClientScopeSelectorProps) {
  const { t } = useTranslation()
  const id = useId()
  const [search, setSearch] = useState('')
  const selected = new Set(props.value)
  const unknown = props.value.filter(
    (scope) => !props.capabilities.some((item) => item.scope === scope)
  )
  const filtered = props.capabilities.filter((item) =>
    `${item.scope} ${t(item.label)} ${t(item.description)}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )

  return (
    <FieldSet disabled={props.disabled} aria-describedby={`${id}-description`}>
      <FieldLegend>{t('Allowed permissions')}</FieldLegend>
      <FieldDescription id={`${id}-description`}>
        {t(
          'Choose what this application may request. Each user still approves permissions within their own account access.'
        )}
      </FieldDescription>
      <FieldGroup className='gap-3'>
        <Field>
          <FieldLabel htmlFor={`${id}-search`}>
            {t('Search permissions')}
          </FieldLabel>
          <Input
            id={`${id}-search`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={props.disabled}
          />
        </Field>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={props.disabled}
            onClick={() =>
              props.onChange(props.capabilities.map((item) => item.scope))
            }
          >
            {t('Select all current permissions')}
          </Button>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            disabled={props.disabled}
            onClick={() => props.onChange([])}
          >
            {t('Clear selection')}
          </Button>
          <span className='text-muted-foreground text-sm' role='status'>
            {t('{{count}} permissions selected', { count: props.value.length })}
          </span>
        </div>
        <FieldDescription>
          {t(
            'New permissions are never added automatically to existing selections.'
          )}
        </FieldDescription>
        {unknown.length > 0 ? (
          <FieldError>
            {t(
              'Some saved permissions are no longer available. Select supported permissions before saving.'
            )}
          </FieldError>
        ) : null}
        <div className='max-h-64 overflow-y-auto rounded-lg border p-3'>
          <FieldGroup className='gap-4'>
            {filtered.map((item) => (
              <Field
                key={item.scope}
                orientation='horizontal'
                data-disabled={props.disabled}
              >
                <Checkbox
                  id={`${id}-${item.scope}`}
                  checked={selected.has(item.scope)}
                  disabled={props.disabled}
                  aria-invalid={!!props.error}
                  aria-describedby={`${id}-${item.scope}-description`}
                  onCheckedChange={(checked) =>
                    props.onChange(
                      checked
                        ? [...new Set([...props.value, item.scope])]
                        : props.value.filter((scope) => scope !== item.scope)
                    )
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor={`${id}-${item.scope}`}>
                    {t(item.label)}
                  </FieldLabel>
                  <FieldDescription id={`${id}-${item.scope}-description`}>
                    {t(item.description)}
                  </FieldDescription>
                  <div className='flex flex-wrap gap-1.5'>
                    <code className='text-muted-foreground text-xs'>
                      {item.scope}
                    </code>
                    {item.resource === 'urn:new-api:relay' ? (
                      <Badge variant='secondary'>{t('Model access')}</Badge>
                    ) : null}
                    {item.sensitive ? (
                      <Badge variant='outline'>
                        {t('Sensitive permission')}
                      </Badge>
                    ) : null}
                  </div>
                </FieldContent>
              </Field>
            ))}
            {filtered.length === 0 ? (
              <FieldDescription>
                {t('No matching permissions')}
              </FieldDescription>
            ) : null}
          </FieldGroup>
        </div>
        {props.error ? <FieldError>{t(props.error)}</FieldError> : null}
      </FieldGroup>
    </FieldSet>
  )
}
