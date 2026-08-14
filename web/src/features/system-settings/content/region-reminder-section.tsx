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
import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import { SettingsForm, SettingsSwitchField } from '../components/settings-form-layout'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'

const regionReminderSchema = z.object({
  countries: z.string(),
  message: z.string(),
})

type RegionReminderFormValues = z.infer<typeof regionReminderSchema>

type RegionReminderSectionProps = {
  enabled: boolean
  countries: string
  message: string
}

export function RegionReminderSection({
  enabled,
  countries,
  message,
}: RegionReminderSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const [isEnabled, setIsEnabled] = useState(enabled)

  const form = useForm<RegionReminderFormValues>({
    resolver: zodResolver(regionReminderSchema),
    defaultValues: { countries, message },
  })

  useEffect(() => {
    setIsEnabled(enabled)
  }, [enabled])

  useEffect(() => {
    form.reset({ countries, message })
  }, [countries, message, form])

  const handleToggleEnabled = async (checked: boolean) => {
    try {
      await updateOption.mutateAsync({
        key: 'region_reminder.enabled',
        value: checked,
      })
      setIsEnabled(checked)
      toast.success(t('Setting saved'))
    } catch {
      toast.error(t('Failed to update setting'))
    }
  }

  const handleSave = async (values: RegionReminderFormValues) => {
    try {
      const updates = Object.entries(values).filter(
        ([key, value]) => value !== (key === 'countries' ? countries : message)
      )
      for (const [key, value] of updates) {
        await updateOption.mutateAsync({
          key: `region_reminder.${key}`,
          value,
        })
      }
    } catch {
      toast.error(t('Failed to update setting'))
    }
  }

  return (
    <SettingsSection title={t('Region Reminder')}>
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <Button
            onClick={form.handleSubmit(handleSave)}
            size='sm'
            variant='secondary'
            disabled={!form.formState.isDirty || updateOption.isPending}
          >
            <Save className='mr-2 h-4 w-4' />
            {updateOption.isPending ? t('Saving...') : t('Save Settings')}
          </Button>
          <SettingsSwitchField
            checked={isEnabled}
            onCheckedChange={handleToggleEnabled}
            label={t('Enabled')}
            className='py-0'
          />
        </div>

        <Form {...form}>
          <SettingsForm onSubmit={form.handleSubmit(handleSave)}>
            <FormField
              control={form.control}
              name='countries'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('Remind visitors from these countries/regions')}
                  </FormLabel>
                  <FormControl>
                    <Input placeholder={t('e.g., CN, US, JP')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='message'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Reminder message')}</FormLabel>
                  <FormControl>
                    <Textarea rows={4} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </SettingsForm>
        </Form>
      </div>
    </SettingsSection>
  )
}
