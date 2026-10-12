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
import {
  Archive,
  ArchiveRestore,
  Download,
  Ellipsis,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import type { CodexWorkspace } from '../types'
import { Button } from '../vendor/zcode/button'

export function WorkspaceActions(props: {
  workspace: CodexWorkspace
  disabled: boolean
  onRename: () => void
  onImport: () => void
  onExport: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant='ghost'
            size='icon-sm'
            className='size-7 shrink-0 rounded-full'
          />
        }
        aria-label={t('Project actions')}
        aria-description={props.workspace.name}
        title={t('Project actions')}
      >
        <Ellipsis className='size-4' aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className='codex-zcode codex-chatgpt chatgpt-popover border-border/70 w-60 max-w-[calc(100vw-1.5rem)] rounded-2xl border p-1.5 shadow-xl/10 ring-0'
        side='bottom'
        align='end'
        sideOffset={6}
      >
        <DropdownMenuItem
          className='min-h-10 gap-3 rounded-lg px-3 py-2 text-sm'
          disabled={props.disabled}
          onClick={props.onRename}
        >
          <Pencil aria-hidden />
          {t('Rename project')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className='min-h-10 gap-3 rounded-lg px-3 py-2 text-sm'
          disabled={props.disabled}
          onClick={props.onImport}
        >
          <Upload aria-hidden />
          {t('Import ZIP')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className='min-h-10 gap-3 rounded-lg px-3 py-2 text-sm'
          disabled={props.disabled}
          onClick={props.onExport}
        >
          <Download aria-hidden />
          {t('Export project')}
        </DropdownMenuItem>
        <DropdownMenuItem
          className='min-h-10 gap-3 rounded-lg px-3 py-2 text-sm'
          disabled={props.disabled}
          onClick={props.onArchive}
        >
          {props.workspace.archived ? (
            <ArchiveRestore aria-hidden />
          ) : (
            <Archive aria-hidden />
          )}
          {props.workspace.archived
            ? t('Restore project')
            : t('Archive project')}
        </DropdownMenuItem>
        <DropdownMenuSeparator className='mx-2 my-1' />
        <DropdownMenuItem
          className='min-h-10 gap-3 rounded-lg px-3 py-2 text-sm'
          disabled={props.disabled}
          onClick={props.onDelete}
          variant='destructive'
        >
          <Trash2 aria-hidden />
          {t('Delete project')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
