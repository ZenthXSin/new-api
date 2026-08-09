/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { useTranslation } from 'react-i18next'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const distributionPlatforms = [
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
  { value: 'darwin', label: 'macOS' },
  { value: 'android', label: 'Android' },
] as const

const distributionArchitectures = [
  { value: 'amd64', label: 'amd64 (x86_64)' },
  { value: 'arm64', label: 'arm64 (AArch64)' },
  { value: '386', label: '386 (x86)' },
  { value: 'arm', label: 'ARM' },
  { value: 'universal', label: 'Universal' },
] as const

type DistributionTargetSelectsProps = {
  platform: string
  architecture: string
  onPlatformChange: (value: string) => void
  onArchitectureChange: (value: string) => void
}

export function DistributionTargetSelects(
  props: DistributionTargetSelectsProps
) {
  const { t } = useTranslation()

  return (
    <>
      <Select
        items={distributionPlatforms}
        value={props.platform}
        onValueChange={(value) => {
          if (value) props.onPlatformChange(value)
        }}
      >
        <SelectTrigger className='w-full' aria-label={t('Platform')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {distributionPlatforms.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        items={distributionArchitectures}
        value={props.architecture}
        onValueChange={(value) => {
          if (value) props.onArchitectureChange(value)
        }}
      >
        <SelectTrigger className='w-full' aria-label={t('Architecture')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {distributionArchitectures.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  )
}
