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
import { FileText, ImageIcon } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'

import type { PlaygroundAttachment } from '../../types'

type MessageAttachmentsProps = { attachments?: PlaygroundAttachment[] }

function isPreviewableImage(attachment: PlaygroundAttachment): boolean {
  return (
    attachment.kind === 'image' &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(attachment.dataUrl ?? '')
  )
}

export const MessageAttachments = memo(function MessageAttachments({
  attachments,
}: MessageAttachmentsProps) {
  const { t } = useTranslation()
  if (!attachments?.length) return null
  return (
    <ul
      aria-label={t('Message attachments')}
      className='my-2 flex max-w-full flex-wrap gap-2'
    >
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className='bg-muted/40 max-w-full overflow-hidden rounded-lg border p-2'
        >
          {isPreviewableImage(attachment) && (
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className='mb-2 max-h-48 max-w-full rounded object-contain'
              loading='lazy'
            />
          )}
          <div className='flex max-w-64 min-w-0 items-center gap-2'>
            {attachment.kind === 'image' ? (
              <ImageIcon className='size-4 shrink-0' aria-hidden />
            ) : (
              <FileText className='size-4 shrink-0' aria-hidden />
            )}
            <span className='min-w-0 text-sm break-all'>{attachment.name}</span>
            <Badge variant='secondary' className='shrink-0'>
              {attachment.kind === 'pdf'
                ? 'PDF'
                : attachment.mimeType.split('/').at(-1)}
            </Badge>
          </div>
          {attachment.kind === 'text' && attachment.text !== undefined && (
            <details className='mt-1 max-w-96 text-xs'>
              <summary className='cursor-pointer'>
                {t('Preview attachment')}
              </summary>
              <pre className='mt-2 max-h-48 overflow-auto break-words whitespace-pre-wrap'>
                {attachment.text}
              </pre>
            </details>
          )}
          {attachment.kind === 'image' && !isPreviewableImage(attachment) && (
            <p className='text-muted-foreground mt-1 text-xs'>
              {t('Attachment preview unavailable')}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
})
