/*
 * Adapted from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/PreviewPane.tsx, breadcrumb header block.
 * Changes: New API path prop and Lucide file icon; preserve scrollable path
 * and compact file header; server-only projects have no local open action.
 */
import { ChevronRight, FileCode2 } from 'lucide-react'
import { Fragment } from 'react'

export function PreviewBreadcrumb(props: { path: string }) {
  const segments = props.path.split('/')
  const filename = segments.pop()
  return (
    <div className='min-w-0 flex-1 overflow-x-auto' title={props.path}>
      <div className='text-ui-base text-foreground-subtle flex min-w-max items-center gap-0.5 px-2'>
        {segments.map((segment, index) => (
          <Fragment key={segments.slice(0, index + 1).join('/')}>
            <span className='shrink-0'>{segment}</span>
            <ChevronRight
              className='text-foreground-subtlest size-3.5'
              aria-hidden
            />
          </Fragment>
        ))}
        <span className='text-foreground inline-flex min-w-0 items-center gap-1'>
          <FileCode2 className='size-3.5 shrink-0' aria-hidden />
          <span className='truncate'>{filename}</span>
        </span>
      </div>
    </div>
  )
}
