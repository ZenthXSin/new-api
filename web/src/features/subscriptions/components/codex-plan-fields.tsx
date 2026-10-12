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
import { CodeXml } from 'lucide-react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import {
  SideDrawerSection,
  SideDrawerSectionHeader,
  sideDrawerSwitchItemClassName,
} from '@/components/drawer-layout'
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { codexResourceFields } from '@/features/codex-admin/types'
import { CodexSelect } from '@/features/codex/components/select'
import { reasoningEfforts } from '@/features/codex/lib/reasoning-effort'

import type { PlanFormValues } from '../lib/plan-form'

export function CodexPlanFields() {
  const { t } = useTranslation()
  const form = useFormContext<PlanFormValues>()
  const enabled = form.watch('codex.enabled')
  return (
    <SideDrawerSection>
      <SideDrawerSectionHeader
        title={t('Online Codex')}
        icon={<CodeXml />}
        description={t(
          'Grant Codex access for the lifetime of this subscription. Existing plans keep their current behavior until enabled.'
        )}
      />
      <FormField
        control={form.control}
        name='codex.enabled'
        render={({ field }) => (
          <FormItem className={sideDrawerSwitchItemClassName()}>
            <FormLabel>{t('Include online Codex')}</FormLabel>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {enabled && (
        <div className='space-y-4'>
          <div className='grid gap-3 sm:grid-cols-2'>
            {(
              [
                { key: 'allowDocker', label: 'Docker virtual cloud' },
                { key: 'allowSSH', label: 'SSH execution' },
              ] as const
            ).map((item) => (
              <FormField
                key={item.key}
                control={form.control}
                name={`codex.${item.key}`}
                render={({ field }) => (
                  <FormItem className={sideDrawerSwitchItemClassName()}>
                    <FormLabel>{t(item.label)}</FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            {codexResourceFields.map((item) => (
              <FormField
                key={item.key}
                control={form.control}
                name={`codex.${item.key}`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(item.label)}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type='number'
                        min={0}
                        max={item.max}
                        step={item.step}
                        onChange={(event) =>
                          field.onChange(Number(event.target.value))
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Zero uses the server default. Memory and storage must be zero or at least 256 MB; idle timeout must be zero or at least 60 seconds. Resource changes apply when the environment next starts.'
            )}
          </p>
          <div className='grid gap-4 sm:grid-cols-2'>
            {(
              [
                { key: 'defaultModel', label: 'Default model', max: 200 },
                { key: 'defaultGroup', label: 'Default group', max: 64 },
              ] as const
            ).map((item) => (
              <FormField
                key={item.key}
                control={form.control}
                name={`codex.${item.key}`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(item.label)}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        maxLength={item.max}
                        placeholder={t('Server default')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <FormField
              control={form.control}
              name='codex.defaultEffort'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Default reasoning effort')}</FormLabel>
                  <FormControl>
                    <CodexSelect
                      label={t('Default reasoning effort')}
                      value={field.value}
                      onChange={field.onChange}
                      options={[
                        { value: '', label: t('Server default') },
                        ...reasoningEfforts,
                      ]}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Defaults do not grant additional model or group permissions. Existing user billing still applies.'
            )}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t(
              'Changes apply to active subscribers. Manual overrides take priority; otherwise the most recently started active Codex subscription applies. Access ends when the subscription expires or is cancelled.'
            )}
          </p>
        </div>
      )}
    </SideDrawerSection>
  )
}
