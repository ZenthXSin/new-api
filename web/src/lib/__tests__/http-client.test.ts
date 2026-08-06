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
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'

import { useAuthStore } from '../../stores/auth-store'
import { api } from '../http-client'

const originalAdapter = api.defaults.adapter
const originalAuth = useAuthStore.getState().auth

afterEach(() => {
  api.defaults.adapter = originalAdapter
  useAuthStore.setState({ auth: originalAuth })
})

test('skipPanelAuth preserves an explicit application bearer token', async () => {
  useAuthStore.setState({
    auth: { ...originalAuth, accessToken: 'panel-access-token' },
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

  await api.get('/api/distribution/apps/test/manage/releases', {
    disableDuplicate: true,
    headers: { Authorization: 'Bearer app_v1.key.secret' },
    skipAuthRefresh: true,
    skipPanelAuth: true,
  })

  assert.equal(captured?.headers.Authorization, 'Bearer app_v1.key.secret')
})

test('skipRequestDedup keeps overlapping replacement bearer requests separate', async () => {
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
    api.get('/api/distribution/apps/test/manage/releases', {
      headers: { Authorization: 'Bearer app_v1.old-secret' },
      skipAuthRefresh: true,
      skipPanelAuth: true,
      skipRequestDedup: true,
    }),
    api.get('/api/distribution/apps/test/manage/releases', {
      headers: { Authorization: 'Bearer app_v1.rotated-secret' },
      skipAuthRefresh: true,
      skipPanelAuth: true,
      skipRequestDedup: true,
    }),
  ]
  releaseRequests()
  await Promise.all(requests)

  assert.equal(captured.length, 2)
  assert.equal(captured[0]?.headers.Authorization, 'Bearer app_v1.old-secret')
  assert.equal(
    captured[1]?.headers.Authorization,
    'Bearer app_v1.rotated-secret'
  )
})
