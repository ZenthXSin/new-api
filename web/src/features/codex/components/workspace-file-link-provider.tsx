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
  lazy,
  Suspense,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { resolveWorkspaceFileLink } from '../lib/workspace-file-link'
import {
  type ProjectFileLocation,
  WorkspaceFileLinkContext,
} from '../lib/workspace-file-link-context'

const WorkspaceFileEditor = lazy(() =>
  import('./workspace-file-editor').then((module) => ({
    default: module.WorkspaceFileEditor,
  }))
)

export function WorkspaceFileLinkProvider(props: {
  workspaceId?: string
  actor?: string
  remoteRoot?: string
  conversationId?: string
  initialFile?: string
  initialLine?: number
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [file, setFile] = useState<ProjectFileLocation | null>(null)
  useEffect(() => {
    if (!props.workspaceId || !props.initialFile) return
    const target = resolveWorkspaceFileLink(
      props.initialFile,
      props.workspaceId,
      props.remoteRoot
    )
    if (target?.type === 'file') {
      setFile({ path: target.path, line: props.initialLine ?? target.line })
    }
  }, [
    props.workspaceId,
    props.remoteRoot,
    props.initialFile,
    props.initialLine,
  ])
  const context = useMemo(
    () =>
      props.workspaceId
        ? {
            workspaceId: props.workspaceId,
            remoteRoot: props.remoteRoot,
            conversationId: props.conversationId,
            open: setFile,
          }
        : null,
    [props.workspaceId, props.remoteRoot, props.conversationId]
  )
  return (
    <WorkspaceFileLinkContext.Provider value={context}>
      {props.children}
      <Dialog
        open={!!file}
        onOpenChange={(open) => {
          if (!open) setFile(null)
        }}
      >
        <DialogContent className='codex-zcode codex-chatgpt codex-web flex h-[min(760px,calc(100dvh-2rem))] max-w-[calc(100vw-2rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1120px,calc(100vw-2rem))]'>
          <DialogHeader className='shrink-0 px-5 pt-5 pr-12 pb-3'>
            <DialogTitle className='break-all'>{file?.path}</DialogTitle>
            <DialogDescription>
              {t('View a file from this project.')}
            </DialogDescription>
          </DialogHeader>
          {file && props.workspaceId && (
            <Suspense
              fallback={
                <p role='status' className='p-5 text-sm'>
                  {t('Loading file...')}
                </p>
              }
            >
              <WorkspaceFileEditor
                key={`${file.path}:${file.line ?? 0}`}
                id={props.workspaceId}
                actor={props.actor ?? ''}
                path={file.path}
                initialLine={file.line}
                creating={false}
                running={false}
                readOnly
                preview
                onBack={() => setFile(null)}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </WorkspaceFileLinkContext.Provider>
  )
}
