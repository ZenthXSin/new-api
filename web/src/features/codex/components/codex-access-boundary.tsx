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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ForbiddenError } from '@/features/errors/forbidden'
import { useCodexAccess } from '@/hooks/use-codex-access'

export function CodexAccessBoundary(props: { children: ReactNode }) {
  const { t } = useTranslation()
  const access = useCodexAccess()
  if (access.checking) {
    return (
      <div role='status' className='text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm'>
        {t('Checking Codex access…')}
      </div>
    )
  }
  if (access.error) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-4 p-6'>
        <p role='alert'>{t('Codex access could not be verified.')}</p>
        <Button variant='outline' onClick={() => void access.retry()}>
          {t('Retry')}
        </Button>
      </div>
    )
  }
  if (!access.allowed) return <ForbiddenError />
  return props.children
}
