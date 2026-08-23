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
import { afterEach, expect, test } from 'vitest'

import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'

import { useAuthStore } from '../../stores/auth-store'
import { api } from '../http-client'

const originalAdapter = api.defaults.adapter
const originalAuth = useAuthStore.getState().auth

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.setState({ auth: originalAuth })
})

test('app-center management uses the panel session request path', async () => {
  useAuthStore.setState({
    auth: { ...originalAuth, accessToken: null },
  })
  let captured: InternalAxiosRequestConfig | undefined
  api.defaults.adapter = (async (config) => {
    captured = config
    return {
      config,
      data: { success: true, data: [] },
      headers: {},
      status: 200,
      statusText: 'OK',
    }
  }) satisfies AxiosAdapter

  await api.get('/api/app-center/apps/7/releases', {
    disableDuplicate: true,
  })

  expect(captured?.url).toBe('/api/app-center/apps/7/releases')
  expect(captured?.headers.Authorization).toBe(undefined)
})

test('skipRequestDedup keeps overlapping app-center requests separate', async () => {
  const captured: InternalAxiosRequestConfig[] = []
  let releaseRequests = () => {}
  const requestGate = new Promise<void>((resolve) => {
    releaseRequests = resolve
  })
  api.defaults.adapter = (async (config) => {
    captured.push(config)
    await requestGate
    return {
      config,
      data: { success: true, data: [] },
      headers: {},
      status: 200,
      statusText: 'OK',
    }
  }) satisfies AxiosAdapter

  const requests = [
    api.get('/api/app-center/apps/7/releases', {
      skipRequestDedup: true,
    }),
    api.get('/api/app-center/apps/7/releases', {
      skipRequestDedup: true,
    }),
  ]
  releaseRequests()
  await Promise.all(requests)

  expect(captured.length).toBe(2)
  expect(captured[0]?.url).toBe('/api/app-center/apps/7/releases')
  expect(captured[1]?.url).toBe('/api/app-center/apps/7/releases')
})