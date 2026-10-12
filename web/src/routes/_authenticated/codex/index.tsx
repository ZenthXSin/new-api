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
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import z from 'zod'

import { Codex } from '@/features/codex'
import { CodexAccessBoundary } from '@/features/codex/components/codex-access-boundary'
import { requireCodexAccess } from '@/hooks/use-codex-access'

export const Route = createFileRoute('/_authenticated/codex/')({
  beforeLoad: ({ context }) => requireCodexAccess(context.queryClient),
  validateSearch: z.object({
    conversation: z.string().uuid().optional().catch(undefined),
    workspace: z.string().max(100).optional().catch(undefined),
    file: z.string().max(4096).optional().catch(undefined),
    line: z.coerce
      .number()
      .int()
      .min(1)
      .max(10000000)
      .optional()
      .catch(undefined),
    github_oauth: z.string().max(1).optional().catch(undefined),
    code: z.string().max(512).optional().catch(undefined),
    state: z.string().max(128).optional().catch(undefined),
    error: z.string().max(128).optional().catch(undefined),
  }),
  component: CodexPage,
})
function CodexPage() {
  const { t } = useTranslation()
  const [dirty, setDirty] = useState(false)
  useBlocker({
    shouldBlockFn: () =>
      dirty && !window.confirm(t('Discard unsaved file changes?')),
    enableBeforeUnload: dirty,
  })
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <CodexAccessBoundary>
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden p-0'>
        <Codex
          onDirty={setDirty}
          filePath={search.file}
          fileLine={search.line}
          workspaceId={search.workspace}
          conversationId={search.conversation}
          onSelect={(workspace, conversation) =>
            void navigate({ search: { workspace, conversation } })
          }
          onBack={() =>
            void navigate({
              to: '/dashboard/$section',
              params: { section: 'overview' },
            })
          }
        />
      </div>
    </CodexAccessBoundary>
  )
}
