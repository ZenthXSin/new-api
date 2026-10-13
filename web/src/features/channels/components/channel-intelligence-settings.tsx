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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { StatusBadge, type StatusBadgeProps } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@/components/ui/form'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { formatTimestampToDate } from '@/lib/format'

import { testChannel } from '../api'
import { channelsQueryKeys } from '../lib/channel-actions'
import type { ChannelFormValues } from '../lib/channel-form'
import {
  CHANNEL_INTELLIGENCE_PROMPT,
  parseChannelIntelligenceCheck,
} from '../lib/channel-intelligence'
import type { Channel } from '../types'

export function ChannelIntelligenceResultBadge(props: { value?: string }) {
  const { t } = useTranslation()
  const result = parseChannelIntelligenceCheck(props.value)
  if (!result) return null
  let label = t('Intelligence check inconclusive')
  let variant: StatusBadgeProps['variant'] = 'warning'
  if (result.status === 'passed') {
    label = t('Intelligence check passed')
    variant = 'success'
  } else if (result.status === 'degraded') {
    label = t('Intelligence degraded')
    variant = 'danger'
  } else if (result.status === 'error') {
    label = t('Intelligence check request failed')
    variant = 'danger'
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className='inline-flex shrink-0' tabIndex={0} />}
      >
        <StatusBadge
          label={label}
          variant={variant}
          size='sm'
          copyable={false}
        />
      </TooltipTrigger>
      <TooltipContent className='max-w-sm space-y-1 break-words'>
        <p>
          {result.model} · {formatTimestampToDate(result.checked_at)}
        </p>
        <p>{result.response || label}</p>
        {result.auto_disabled && (
          <p>{t('Automatically disabled by intelligence check')}</p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function ChannelIntelligenceSettings(props: {
  channel?: Channel | null
}) {
  const { t } = useTranslation()
  const form = useFormContext<ChannelFormValues>()
  const client = useQueryClient()
  const enabled = form.watch('intelligence_check_enabled') === true
  const [result, setResult] = useState(props.channel?.intelligence_check)
  useEffect(
    () => setResult(props.channel?.intelligence_check),
    [props.channel?.id, props.channel?.intelligence_check]
  )
  const test = useMutation({
    mutationFn: () => {
      if (!props.channel?.id) throw new Error('Save the channel first')
      return testChannel(props.channel.id, {
        intelligence: true,
        model: form.getValues('test_model')?.trim() || undefined,
      })
    },
    onSuccess: (response) => {
      if (response.intelligence_check) {
        setResult(JSON.stringify(response.intelligence_check))
      }
      if (!response.success) toast.error(t('Intelligence check request failed'))
      void client.invalidateQueries({ queryKey: channelsQueryKeys.all })
    },
    onError: () => toast.error(t('Intelligence check request failed')),
  })
  return (
    <div className='space-y-3 rounded-lg border p-3'>
      <FormField
        control={form.control}
        name='intelligence_check_enabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-3'>
            <div className='space-y-1'>
              <FormLabel>{t('Automatic intelligence check')}</FormLabel>
              <FormDescription>
                {t(
                  'Uses the fixed question and Test Model at the channel testing interval. Results only reflect this question.'
                )}
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value === true}
                onCheckedChange={(checked) => {
                  field.onChange(checked)
                  if (!checked) {
                    form.setValue('intelligence_check_auto_disable', false, {
                      shouldDirty: true,
                    })
                  }
                }}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name='intelligence_check_auto_disable'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-3'>
            <div className='space-y-1'>
              <FormLabel>
                {t('Automatically disable degraded channels')}
              </FormLabel>
              <FormDescription>
                {t(
                  'Only an explicit degraded answer disables the tested channel or key. Errors and inconclusive replies do not disable it.'
                )}
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                disabled={!enabled}
                checked={field.value === true}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <p className='bg-muted text-muted-foreground rounded-md p-2 text-xs leading-relaxed'>
        {CHANNEL_INTELLIGENCE_PROMPT}
      </p>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <ChannelIntelligenceResultBadge value={result} />
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={!props.channel?.id || test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending && (
            <Loader2 className='size-3.5 animate-spin' aria-hidden />
          )}
          {t('Run intelligence check')}
        </Button>
      </div>
      {!props.channel?.id && (
        <p className='text-muted-foreground text-xs'>
          {t('Save the channel before running an intelligence check.')}
        </p>
      )}
    </div>
  )
}
