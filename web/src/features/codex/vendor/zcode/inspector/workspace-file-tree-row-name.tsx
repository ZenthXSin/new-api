/*
 * Adapted from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowName.tsx
 * Changes: Formatting only.
 */
import { Fragment } from 'react'

export function WorkspaceFileTreeRowName({
  name,
  className,
  slashClassName,
}: {
  name: string
  className?: string
  slashClassName?: string
}) {
  const segments = name.split('/')
  if (segments.length <= 1) {
    return <span className={className}>{name}</span>
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => (
        <Fragment key={segments.slice(0, index + 1).join('/')}>
          {index > 0 ? <span className={slashClassName}>/</span> : null}
          <span>{segment}</span>
        </Fragment>
      ))}
    </span>
  )
}
