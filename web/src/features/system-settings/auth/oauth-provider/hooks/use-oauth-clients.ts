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
  return () => {
    queryClient.invalidateQueries({ queryKey: ['oauth-clients'] })
  }
}

export function useOauthClients() {
  return useQuery({
    queryKey: ['oauth-clients'],
    queryFn: async () => {
      const res = await getOauthClients()
      if (!res.success) {
        throw new Error(res.message || 'Failed to load OAuth clients')
      }
      return res.data ?? []
    },
  })
}

export function useCreateOauthClient() {
  const invalidate = useInvalidateClients()
  return useMutation({
    mutationFn: (values: OauthClientFormValues) => createOauthClient(values),
    onSuccess: (res) => {
      if (res.success) {
        toast.success(i18next.t('Client created successfully'))
        invalidate()
      }
    },
  })
}

export function useUpdateOauthClient() {
  const invalidate = useInvalidateClients()
  return useMutation({
    mutationFn: ({ id, values }: { id: number; values: OauthClientFormValues }) =>
      updateOauthClient(id, values),
    onSuccess: (res) => {
      if (res.success) {
        toast.success(i18next.t('Client updated successfully'))
        invalidate()
      }
    },
  })
}

export function useDeleteOauthClient() {
  const invalidate = useInvalidateClients()
  return useMutation({
    mutationFn: (id: number) => deleteOauthClient(id),
    onSuccess: (res) => {
      if (res.success) {
        toast.success(i18next.t('Client deleted successfully'))
        invalidate()
      }
    },
  })
}

export function useResetOauthClientSecret() {
  const invalidate = useInvalidateClients()
  return useMutation({
    mutationFn: (id: number) => resetOauthClientSecret(id),
    onSuccess: (res) => {
      if (res.success) {
        toast.success(i18next.t('Client secret reset'))
        invalidate()
      }
    },
  })
}
