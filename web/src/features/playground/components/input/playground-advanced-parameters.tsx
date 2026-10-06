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
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../constants'
import type { ParameterEnabled, PlaygroundConfig } from '../../types'

interface AdvancedParametersProps {
  config: PlaygroundConfig
  disabled?: boolean
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onParameterEnabledChange: (
    key: keyof ParameterEnabled,
    value: boolean
  ) => void
}

export function PlaygroundAdvancedParameters(props: AdvancedParametersProps) {
  const { t } = useTranslation()
  const config = props.config

  function resetParameters() {
    for (const key of [
      'temperature',
      'top_p',
      'max_tokens',
      'frequency_penalty',
      'presence_penalty',
      'seed',
    ] as const) {
      props.onConfigChange(key, DEFAULT_CONFIG[key])
      props.onParameterEnabledChange(key, DEFAULT_PARAMETER_ENABLED[key])
    }
    props.onConfigChange('stream', true)
    props.onConfigChange('system_prompt', '')
    props.onConfigChange('web_search', false)
    props.onConfigChange('search_context_size', 'medium')
    props.onConfigChange('reasoning_effort', 'default')
    props.onConfigChange('response_format', 'text')
    props.onConfigChange('stop', [])
  }

  return (
    <>
      <div className='flex items-center justify-between gap-3 rounded-lg border p-3'>
        <Label htmlFor='playground-stream'>{t('Stream response')}</Label>
        <Switch
          id='playground-stream'
          checked={config.stream}
          disabled={props.disabled}
          onCheckedChange={(value) => props.onConfigChange('stream', value)}
        />
      </div>
      <div className='grid gap-2 rounded-lg border p-3'>
        <Label htmlFor='playground-system-prompt'>
          {t('System instructions')}
        </Label>
        <Textarea
          id='playground-system-prompt'
          value={config.system_prompt ?? ''}
          rows={4}
          maxLength={16000}
          disabled={props.disabled}
          placeholder={t('Set the role, tone, and rules for this conversation')}
          onChange={(event) =>
            props.onConfigChange('system_prompt', event.target.value)
          }
        />
      </div>
      <div className='grid gap-2 rounded-lg border p-3'>
        <Label htmlFor='playground-reasoning'>{t('Reasoning effort')}</Label>
        <NativeSelect
          id='playground-reasoning'
          className='w-full'
          disabled={props.disabled}
          value={config.reasoning_effort ?? 'default'}
          onChange={(event) => {
            const value = event.target.value
            if (
              value === 'default' ||
              value === 'low' ||
              value === 'medium' ||
              value === 'high'
            ) {
              props.onConfigChange('reasoning_effort', value)
            }
          }}
        >
          <NativeSelectOption value='default'>
            {t('Model default')}
          </NativeSelectOption>
          <NativeSelectOption value='low'>{t('Low')}</NativeSelectOption>
          <NativeSelectOption value='medium'>{t('Medium')}</NativeSelectOption>
          <NativeSelectOption value='high'>{t('High')}</NativeSelectOption>
        </NativeSelect>
        <p className='text-muted-foreground text-xs'>
          {t('Optional parameters require support from the selected model.')}
        </p>
      </div>
      <div className='grid gap-2 rounded-lg border p-3'>
        <Label htmlFor='playground-response-format'>
          {t('Response format')}
        </Label>
        <NativeSelect
          id='playground-response-format'
          className='w-full'
          disabled={props.disabled}
          value={config.response_format ?? 'text'}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'text' || value === 'json_object') {
              props.onConfigChange('response_format', value)
            }
          }}
        >
          <NativeSelectOption value='text'>{t('Text')}</NativeSelectOption>
          <NativeSelectOption value='json_object'>
            {t('JSON object')}
          </NativeSelectOption>
        </NativeSelect>
      </div>
      <div className='grid gap-2 rounded-lg border p-3'>
        <Label htmlFor='playground-stop'>{t('Stop sequences')}</Label>
        <Textarea
          id='playground-stop'
          rows={3}
          disabled={props.disabled}
          value={config.stop?.join('\n') ?? ''}
          onChange={(event) =>
            props.onConfigChange(
              'stop',
              event.target.value
                .split('\n')
                .slice(0, 4)
                .map((value) => value.slice(0, 128))
            )
          }
        />
        <p className='text-muted-foreground text-xs'>
          {t('One per line, up to 4 sequences of 128 characters.')}
        </p>
      </div>
      {config.web_search && (
        <div className='grid gap-2 rounded-lg border p-3'>
          <Label htmlFor='playground-search-context'>
            {t('Search context size')}
          </Label>
          <NativeSelect
            id='playground-search-context'
            className='w-full'
            disabled={props.disabled}
            value={config.search_context_size ?? 'medium'}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'low' || value === 'medium' || value === 'high') {
                props.onConfigChange('search_context_size', value)
              }
            }}
          >
            <NativeSelectOption value='low'>{t('Low')}</NativeSelectOption>
            <NativeSelectOption value='medium'>
              {t('Medium')}
            </NativeSelectOption>
            <NativeSelectOption value='high'>{t('High')}</NativeSelectOption>
          </NativeSelect>
        </div>
      )}
      <Button
        type='button'
        variant='outline'
        disabled={props.disabled}
        onClick={resetParameters}
      >
        {t('Reset parameters')}
      </Button>
    </>
  )
}
