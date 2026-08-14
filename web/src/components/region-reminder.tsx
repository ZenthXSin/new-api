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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { getGeoCheck } from '@/lib/api'

// 本地标记:用户点击「确定」后不再弹窗
const REGION_REMINDER_DISMISSED_KEY = 'region-reminder-dismissed'

export function RegionReminder() {
  const { t } = useTranslation()
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const checkRegion = async () => {
      try {
        if (window.localStorage.getItem(REGION_REMINDER_DISMISSED_KEY)) {
          return
        }
        const data = await getGeoCheck()
        if (cancelled) return
        if (
          data &&
          data.matched === true &&
          data.message &&
          data.enabled !== false &&
          !window.localStorage.getItem(REGION_REMINDER_DISMISSED_KEY)
        ) {
          setMessage(data.message)
        }
      } catch {
        // 静默失败:接口异常时不打扰用户
      }
    }

    void checkRegion()

    return () => {
      cancelled = true
    }
  }, [])

  const handleDismiss = () => {
    try {
      window.localStorage.setItem(REGION_REMINDER_DISMISSED_KEY, '1')
    } catch {
      /* empty */
    }
    setMessage(null)
  }

  if (message === null) return null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          handleDismiss()
        }
      }}
      title={t('Region Reminder')}
      showCloseButton={false}
      footer={
        <Button type='button' onClick={handleDismiss}>
          {t('OK')}
        </Button>
      }
    >
      <p className='text-muted-foreground whitespace-pre-line'>{message}</p>
    </Dialog>
  )
}
