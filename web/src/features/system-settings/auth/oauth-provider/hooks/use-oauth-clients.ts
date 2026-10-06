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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import i18next from 'i18next'
import { toast } from 'sonner'

import { getOauthCapabilities } from '@/features/oauth-delegation/api'
import { useAuthStore } from '@/stores/auth-store'

import {
  createOauthClient,
  deleteOauthClient,
  getOauthClients,
  resetOauthClientSecret,
  updateOauthClient,
} from '../api'
import type { OauthClientFormValues } from '../types'

function useInvalidateClients() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['oauth-clients'] })
}

export function useOauthClients() {
  const user = useAuthStore((state) => state.auth.user)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  return useQuery({
    queryKey: ['oauth-clients', user?.id, user?.role, sessionID],
    queryFn: ({ signal }) => getOauthClients(signal),
    enabled: !!user && user.role >= 100,
    gcTime: 0,
    retry: false,
  })
}

export function useOauthClientCapabilities(enabled: boolean) {
  const user = useAuthStore((state) => state.auth.user)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  return useQuery({
    queryKey: ['oauth-capabilities', user?.id, user?.role, sessionID],
    queryFn: ({ signal }) => getOauthCapabilities(signal),
    enabled: enabled && !!user && user.role >= 100,
    gcTime: 0,
    retry: false,
  })
}

export function useCreateOauthClient(
  onSecretCreated: (clientId: string, secret: string) => void
) {
  const invalidate = useInvalidateClients()
  const user = useAuthStore((state) => state.auth.user)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  return useMutation({
    mutationFn: async (values: OauthClientFormValues) => {
      const result = await createOauthClient(values)
      const currentUser = useAuthStore.getState().auth.user
      if (
        result.client_secret &&
        currentUser?.id === user?.id &&
        currentUser?.role === user?.role &&
        useAuthStore.getState().auth.session?.sid === sessionID
      ) {
        onSecretCreated(result.client.client_id, result.client_secret)
      }
      // Only the nonsensitive client enters React Query's mutation cache.
      return result.client
    },
    onSuccess: () => {
      toast.success(i18next.t('Client created successfully'))
      void invalidate()
    },
    onError: () => undefined,
    gcTime: 0,
  })
}

export function useUpdateOauthClient() {
  const invalidate = useInvalidateClients()
  return useMutation({
    mutationFn: ({
      id,
      values,
    }: {
      id: number
      values: OauthClientFormValues
    }) => updateOauthClient(id, values),
    onSuccess: () => {
      toast.success(i18next.t('Client updated successfully'))
      void invalidate()
    },
    onError: () => undefined,
    gcTime: 0,
  })
}

export function useDeleteOauthClient() {
  const invalidate = useInvalidateClients()
  return useMutation({
    mutationFn: deleteOauthClient,
    onSuccess: () => {
      toast.success(i18next.t('Client deleted successfully'))
      void invalidate()
    },
    onError: () => undefined,
    gcTime: 0,
  })
}

export function useResetOauthClientSecret(
  onSecretCreated: (clientId: number, secret: string) => void
) {
  const invalidate = useInvalidateClients()
  const user = useAuthStore((state) => state.auth.user)
  const sessionID = useAuthStore((state) => state.auth.session?.sid)
  return useMutation({
    mutationFn: async (id: number) => {
      const secret = await resetOauthClientSecret(id)
      const currentUser = useAuthStore.getState().auth.user
      if (
        currentUser?.id === user?.id &&
        currentUser?.role === user?.role &&
        useAuthStore.getState().auth.session?.sid === sessionID
      ) {
        onSecretCreated(id, secret)
      }
      // Reset responses never enter the mutation cache.
    },
    onSuccess: () => {
      toast.success(i18next.t('Client secret reset'))
      void invalidate()
    },
    onError: () => undefined,
    gcTime: 0,
  })
}
