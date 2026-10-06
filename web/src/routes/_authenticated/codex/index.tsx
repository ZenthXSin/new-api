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
import { createFileRoute, redirect, useBlocker } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import z from 'zod'

import { Main } from '@/components/layout'
import { Codex } from '@/features/codex'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/codex/')({
  beforeLoad: () => {
    if ((useAuthStore.getState().auth.user?.role ?? 0) < ROLE.ADMIN) {
      throw redirect({ to: '/403' })
    }
  },
  validateSearch: z.object({
    workspace: z.string().max(100).optional().catch(undefined),
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
    <Main className='p-0'>
      <Codex
        onDirty={setDirty}
        workspaceId={search.workspace}
        onSelect={(workspace) => void navigate({ search: { workspace } })}
        onBack={() =>
          void navigate({
            to: '/dashboard/$section',
            params: { section: 'overview' },
          })
        }
      />
    </Main>
  )
}
