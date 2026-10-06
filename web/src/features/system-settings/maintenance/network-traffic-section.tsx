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
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

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

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useSettingsForm } from '../hooks/use-settings-form'
import { useUpdateOption } from '../hooks/use-update-option'

type NetworkTrafficValues = {
  NetworkTrafficEnabled: boolean
  NetworkTrafficDailyBudgetGB: number
}

export function NetworkTrafficSection({
  defaultValues,
}: {
  defaultValues: NetworkTrafficValues
}) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const schema = z.object({
    NetworkTrafficEnabled: z.boolean(),
    NetworkTrafficDailyBudgetGB: z
      .number()
      .min(0.1, t('Daily traffic budget must be between 0.1 and 5 GB.'))
      .max(5, t('Daily traffic budget must be between 0.1 and 5 GB.')),
  })
  const { form, handleSubmit, handleReset, isSubmitting, isDirty } =
    useSettingsForm<NetworkTrafficValues>({
      resolver: zodResolver(schema),
      defaultValues,
      onSubmit: async (values, changed) => {
        // Apply the cap before enabling; stop traffic before lowering a disabled cap.
        const keys: (keyof NetworkTrafficValues)[] =
          values.NetworkTrafficEnabled
            ? ['NetworkTrafficDailyBudgetGB', 'NetworkTrafficEnabled']
            : ['NetworkTrafficEnabled', 'NetworkTrafficDailyBudgetGB']
        for (const key of keys) {
          if (key in changed) {
            await updateOption.mutateAsync({ key, value: values[key] })
          }
        }
      },
    })

  return (
    <SettingsSection title={t('Background traffic')}>
      <Form {...form}>
        <SettingsForm onSubmit={handleSubmit}>
          <SettingsPageFormActions
            onSave={handleSubmit}
            onReset={handleReset}
            isSaving={isSubmitting}
            isSaveDisabled={!isDirty}
          />
          <FormField
            control={form.control}
            name='NetworkTrafficEnabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable background traffic')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Samples API activity with random delays and cooldowns. Does not run continuously while idle.'
                    )}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={isSubmitting}
                  />
                </FormControl>
                <FormMessage />
              </SettingsSwitchItem>
            )}
          />
          <FormField
            control={form.control}
            name='NetworkTrafficDailyBudgetGB'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Daily traffic budget (GB)')}</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    min={0.1}
                    max={5}
                    step={0.1}
                    {...field}
                    value={Number.isNaN(field.value) ? '' : field.value}
                    onChange={(event) =>
                      field.onChange(event.target.valueAsNumber)
                    }
                    disabled={isSubmitting}
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Maximum per day, not a usage target. Resets at 00:00 (UTC+8); restarting does not restore spent budget. Includes an overhead allowance.'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <p className='text-muted-foreground text-sm'>
            {t(
              'Uses public downloads and generated test data only. Never uploads user files, prompts or credentials. Changes take effect within 5 seconds.'
            )}
          </p>
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
