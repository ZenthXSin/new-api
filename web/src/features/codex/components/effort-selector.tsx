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

import { reasoningEffortLabel } from '../lib/reasoning-effort'
import { cn } from '../vendor/zcode/utils'
import { CodexSelect } from './select'

export function CodexEffortSelector(props: {
  efforts: string[]
  value: string
  disabled?: boolean
  onChange: (effort: string) => void
  side?: 'top' | 'bottom'
  className?: string
}) {
  const { t } = useTranslation()
  const efforts = [...new Set(props.efforts)]

  return (
    <CodexSelect
      compact
      label={t('Reasoning effort')}
      value={props.value}
      placeholder={
        props.value ? reasoningEffortLabel(props.value) : t('Reasoning effort')
      }
      options={efforts.map((effort) => ({
        value: effort,
        label: reasoningEffortLabel(effort),
      }))}
      disabled={props.disabled || efforts.length < 2}
      side={props.side || 'top'}
      className={cn('codex-effort-select', props.className)}
      onChange={(effort) => {
        if (efforts.includes(effort)) props.onChange(effort)
      }}
    />
  )
}
