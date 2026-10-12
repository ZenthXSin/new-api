/*
 * Adapted from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx
 * Changes: native button for flat directory API; retain row/name markup and
 * single-click activation; remove desktop drag, editor and context actions.
 */
import { ChevronRight, File, Folder } from 'lucide-react'

import { WorkspaceFileTreeRowName } from './workspace-file-tree-row-name'

export function WorkspaceFileTreeRow(props: {
  name: string
  path: string
  directory: boolean
  size: number
  onOpen: () => void
}) {
  return (
    <button
      type='button'
      data-zcode-file-row
      className='group/file-tree-row text-ui-base text-foreground hover:bg-surface-hover focus-visible:border-border-hover focus-visible:bg-surface-hover relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border border-transparent py-1 pr-2 pl-2 text-left transition-[background-color,border-color,box-shadow] outline-none max-sm:h-11'
      title={props.path}
      onClick={props.onOpen}
    >
      <span className='text-foreground-subtle flex size-4 shrink-0 items-center justify-center'>
        {props.directory ? (
          <ChevronRight
            className='text-foreground-subtlest size-3'
            aria-hidden
          />
        ) : (
          <File className='size-4' aria-hidden />
        )}
      </span>
      <span className='flex min-w-0 flex-1 items-center gap-1.5'>
        {props.directory && (
          <Folder
            className='text-foreground-subtle size-4 shrink-0'
            aria-hidden
          />
        )}
        <WorkspaceFileTreeRowName
          name={props.name}
          className='min-w-0 flex-1 truncate'
          slashClassName='mx-1 text-foreground-subtlest'
        />
      </span>
      {!props.directory && (
        <span className='text-ui-xs text-foreground-subtlest shrink-0'>
          {props.size < 1024
            ? `${props.size} B`
            : `${(props.size / 1024).toFixed(1)} KB`}
        </span>
      )}
    </button>
  )
}
