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
import { api } from '@/lib/api'

export type TelemetryProject = {
  id: number
  name: string
  created_at: string
}

export type TelemetryApp = {
  id: number
  project_id: number
  name: string
  created_at: string
}

export type TelemetryWriteKey = {
  id: number
  app_id: number
  name: string
  key_id: string
  key_prefix: string
  disabled_at?: string | null
  created_at: string
}

export type TelemetrySummaryRow = {
  app_id: number
  app_version: string
  event_type: string
  dimension: string
  status: string
  event_count: number
  success_count: number
  total_duration_ms: number
  total_value: number
}

export type TelemetryTimeSeriesRow = TelemetrySummaryRow & {
  bucket_ts: number
}

type ApiResponse<T> = {
  success: boolean
  message?: string
  data: T
}

export async function getTelemetryProjects() {
  const response = await api.get<ApiResponse<TelemetryProject[]>>(
    '/api/telemetry/projects'
  )
  return response.data
}

export async function createTelemetryProject(name: string) {
  const response = await api.post<ApiResponse<TelemetryProject>>(
    '/api/telemetry/projects',
    { name }
  )
  return response.data
}

export async function getTelemetryApps(projectID?: number) {
  const response = await api.get<ApiResponse<TelemetryApp[]>>(
    '/api/telemetry/apps',
    { params: projectID ? { project_id: projectID } : undefined }
  )
  return response.data
}

export async function createTelemetryApp(projectID: number, name: string) {
  const response = await api.post<ApiResponse<TelemetryApp>>(
    '/api/telemetry/apps',
    { project_id: projectID, name }
  )
  return response.data
}

export async function getTelemetryWriteKeys(appID: number) {
  const response = await api.get<ApiResponse<TelemetryWriteKey[]>>(
    '/api/telemetry/keys',
    { params: { app_id: appID } }
  )
  return response.data
}

export async function createTelemetryWriteKey(appID: number, name: string) {
  const response = await api.post<
    ApiResponse<{ key: TelemetryWriteKey; secret: string }>
  >('/api/telemetry/keys', { app_id: appID, name })
  return response.data
}

export async function disableTelemetryWriteKey(id: number) {
  await api.delete(`/api/telemetry/keys/${id}`)
}

export async function getTelemetrySummary(appID: number, hours: number) {
  const response = await api.get<ApiResponse<TelemetrySummaryRow[]>>(
    '/api/telemetry/summary',
    { params: { app_id: appID || undefined, hours } }
  )
  return response.data
}

export async function getTelemetryTimeSeries(appID: number, hours: number) {
  const response = await api.get<ApiResponse<TelemetryTimeSeriesRow[]>>(
    '/api/telemetry/timeseries',
    { params: { app_id: appID || undefined, hours } }
  )
  return response.data
}

export async function cleanupTelemetryData() {
  await api.delete('/api/telemetry/data')
}
