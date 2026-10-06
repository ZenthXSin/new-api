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
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import type { HostedActionStep } from '../types'

export function ActionStepForm(props: {
  step: HostedActionStep
  disabled: boolean
  preparedInput?: Record<string, unknown>
  onSubmit: (input: Record<string, unknown>) => Promise<void>
}) {
  const { t } = useTranslation()
  const fields = props.step.fields.filter(
    (field) => !Object.hasOwn(props.preparedInput ?? {}, field.name)
  )
  const schema = z
    .record(z.string(), z.string())
    .superRefine((values, context) => {
      for (const field of fields) {
        const value = values[field.name] ?? ''
        if (field.required && !value.trim()) {
          context.addIssue({
            code: 'custom',
            path: [field.name],
            message: t('This field is required'),
          })
        } else if (
          value &&
          field.type === 'number' &&
          !Number.isFinite(Number(value))
        ) {
          context.addIssue({
            code: 'custom',
            path: [field.name],
            message: t('Please enter a valid number'),
          })
        } else if (
          value &&
          field.type === 'boolean' &&
          value !== 'true' &&
          value !== 'false'
        ) {
          context.addIssue({
            code: 'custom',
            path: [field.name],
            message: t('Enter true or false'),
          })
        } else if (value && field.type === 'json') {
          try {
            JSON.parse(value)
          } catch {
            context.addIssue({
              code: 'custom',
              path: [field.name],
              message: t('Please enter valid JSON'),
            })
          }
        }
      }
    })
  const form = useForm<Record<string, string>>({
    resolver: zodResolver(schema),
    defaultValues: Object.fromEntries(fields.map((field) => [field.name, ''])),
  })
  const submit = form.handleSubmit(async (values) => {
    const input: Record<string, unknown> = { ...props.preparedInput }
    for (const field of fields) {
      const value = values[field.name] ?? ''
      if (!value && !field.required) continue
      if (field.type === 'number') input[field.name] = Number(value)
      else if (field.type === 'json') input[field.name] = JSON.parse(value)
      else if (field.type === 'boolean') input[field.name] = value === 'true'
      else input[field.name] = value
    }
    await props.onSubmit(input)
    form.reset()
  })
  return (
    <form onSubmit={submit} autoComplete='off' className='flex flex-col gap-4'>
      <h3 className='text-sm font-medium'>{t(props.step.label)}</h3>
      {props.preparedInput && (
        <Alert>
          <AlertDescription>
            {t('Your device response is ready. Continue to finish this step.')}
          </AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        {fields.map((field) => {
          const id = `hosted-${props.step.id}-${field.name}`
          const error = form.formState.errors[field.name]
          return (
            <Field
              key={field.name}
              data-invalid={Boolean(error)}
              data-disabled={props.disabled}
            >
              <FieldLabel htmlFor={id}>{t(field.label)}</FieldLabel>
              {field.type === 'json' ? (
                <Textarea
                  id={id}
                  {...form.register(field.name)}
                  disabled={props.disabled}
                  aria-invalid={Boolean(error)}
                  rows={4}
                />
              ) : (
                <Input
                  id={id}
                  {...form.register(field.name)}
                  type={
                    field.type === 'password' || field.type === 'code'
                      ? 'password'
                      : 'text'
                  }
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  disabled={props.disabled}
                  aria-invalid={Boolean(error)}
                  autoComplete={
                    field.type === 'password' ? 'new-password' : 'off'
                  }
                />
              )}
              {error && <FieldError>{error.message}</FieldError>}
            </Field>
          )
        })}
      </FieldGroup>
      <Button
        type='submit'
        disabled={props.disabled || form.formState.isSubmitting}
      >
        {props.disabled ? t('Processing...') : t('Continue')}
      </Button>
    </form>
  )
}
