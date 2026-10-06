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
import { FileTextIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import type { PlaygroundAttachment } from '../types'

export function AttachmentPreview(props: {
  attachments: PlaygroundAttachment[]
  disabled?: boolean
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation()
  if (!props.attachments.length) return null
  return (
    <ul
      aria-label={t('Attachments')}
      className='flex min-w-0 flex-wrap gap-2 px-4 pt-3'
    >
      {props.attachments.map((attachment) => (
        <li
          key={attachment.id}
          className='bg-muted flex max-w-full min-w-0 items-center gap-2 rounded-lg border p-2'
        >
          {attachment.kind === 'image' && attachment.dataUrl ? (
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className='size-12 rounded object-cover'
            />
          ) : (
            <FileTextIcon className='size-6 shrink-0' aria-hidden='true' />
          )}
          <div className='min-w-0'>
            <p className='max-w-48 truncate text-sm' title={attachment.name}>
              {attachment.name}
            </p>
            <p className='text-muted-foreground text-xs'>
              {Math.ceil(attachment.size / 1024)} KB
            </p>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            disabled={props.disabled}
            aria-label={t('Remove {{name}}', { name: attachment.name })}
            onClick={() => props.onRemove(attachment.id)}
          >
            <XIcon className='size-4' aria-hidden='true' />
          </Button>
        </li>
      ))}
    </ul>
  )
}
