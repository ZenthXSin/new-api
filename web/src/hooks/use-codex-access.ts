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
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

type CodexAccessEnvelope = {
  success: boolean
  data?: { effective?: { userId?: number; enabled?: boolean } }
}

export function codexAccessQueryOptions(
  userId: number | undefined,
  sessionId: string
) {
  return queryOptions({
    queryKey: ['codex-access', userId, sessionId],
    queryFn: async ({ signal }) => {
      const response = await api.get<CodexAccessEnvelope>(
        '/api/user/self/codex-config',
        {
          signal,
          skipRequestDedup: true,
          skipBusinessError: true,
          skipErrorHandler: true,
        }
      )
      const current = useAuthStore.getState().auth
      const effective = response.data.data?.effective
      if (
        current.user?.id !== userId ||
        (current.session?.sid ?? '') !== sessionId ||
        response.data.success !== true ||
        effective?.userId !== userId ||
        typeof effective?.enabled !== 'boolean'
      ) {
        throw new Error('Codex access could not be verified.')
      }
      return { enabled: effective?.enabled === true }
    },
    enabled: userId !== undefined,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })
}

export function useCodexAccess() {
  const userId = useAuthStore((state) => state.auth.user?.id)
  const sessionId = useAuthStore((state) => state.auth.session?.sid ?? '')
  const query = useQuery(codexAccessQueryOptions(userId, sessionId))
  return {
    allowed: userId !== undefined && query.isSuccess && query.data.enabled,
    checking: userId !== undefined && query.isPending,
    error: query.isError,
    retry: query.refetch,
  }
}

export async function requireCodexAccess(
  queryClient: QueryClient
): Promise<void> {
  const auth = useAuthStore.getState().auth
  if (!auth.user) throw redirect({ to: '/403' })
  const access = await queryClient.fetchQuery(
    codexAccessQueryOptions(auth.user.id, auth.session?.sid ?? '')
  )
  if (!access.enabled) throw redirect({ to: '/403' })
}
