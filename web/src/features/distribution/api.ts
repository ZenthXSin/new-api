/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { api } from '@/lib/api'
import { formatTimestampToDate } from '@/lib/format'

export type DistributionAsset = {
  id: number
  release_id: number
  platform: string
  architecture: string
  filename: string
  content_type?: string
  size: number
  sha256: string
  downloads: number
}

export type DistributionRelease = {
  id: number
  app_id: number
  version: string
  channel: string
  status: string
  notes?: string
  published_at?: string | null
  created_at: string
  assets?: DistributionAsset[]
}

export type DistributionAnnouncement = {
  id: number
  app_id: number
  title: string
  body: string
  status: string
  starts_at?: string | null
  ends_at?: string | null
  pinned: boolean
  channel?: string
  platform?: string
  min_version?: string
  created_at: string
  updated_at: string
}

export type DistributionApp = {
  id: number
  slug: string
  name: string
  description?: string
  public: boolean
  download_count: number
  telemetry_enabled?: boolean
  created_at?: string
  updated_at?: string
  telemetry_token?: string
}

export type UsageSummary = {
  starts: number
  online_seconds: number
  active_users: number
  average_session_seconds: number
  versions?: Array<{
    version: string
    starts: number
    online_seconds: number
    active_users: number
  }>
  platforms?: Array<{
    platform: string
    starts: number
    online_seconds: number
    active_users: number
  }>
  trend?: Array<{
    bucket_ts: number
    starts: number
    online_seconds: number
    active_users: number
  }>
}

export type CustomEventsSummary = {
  events?: Array<{
    name: string
    count: number
    unique_users: number
    dimensions?: Record<string, unknown> | string
  }>
  trend?: EventTrend[]
}

export type EventTrend = {
  bucket_ts: number
  name: string
  count: number
  unique_users: number
}

export type UsageBucket = {
  app_id: number
  bucket_ts: number
  version: string
  platform: string
  architecture: string
  start_count: number
  online_seconds: number
  active_users: number
}
export type DownloadBucket = {
  app_id: number
  bucket_ts: number
  version: string
  platform: string
  architecture: string
  count: number
}
export type CustomEventBucket = {
  app_id: number
  bucket_ts: number
  name: string
  dimensions: string
  count: number
  unique_users: number
}
export type EventRegion = {
  country: string
  region: string
  city: string
  unique_users: number
}
export type EventRegionSummary = {
  regions: EventRegion[]
  events: Array<{ name: string; unique_users: number }>
}

export type CustomMessage = {
  id: number
  name?: string
  content: string
  source_ip?: string
  country?: string
  region?: string
  city?: string
  created_at: number
}

export type CustomMessagePage = {
  items: CustomMessage[]
  total: number
  page: number
  size: number
}

// ============================================================================
// Custom message panel display helpers (pure, unit-tested)
// ============================================================================

export const MESSAGE_PAGE_SIZE = 50

export function formatMessageTime(createdAt: number): string {
  return formatTimestampToDate(createdAt)
}

export function joinMessageRegion(
  message: Pick<CustomMessage, 'country' | 'region' | 'city'>
): string {
  return [message.country, message.region, message.city]
    .filter((part) => part && part.trim() !== '')
    .join(' / ')
}

export function getMessagePageBounds(total: number, page: number, size: number) {
  const totalPages = Math.max(1, Math.ceil(total / size))
  return {
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  }
}

type ApiResponse<T> = { success: boolean; message?: string; data: T }

export function distributionErrorMessage(error: unknown) {
  const status = (error as { response?: { status?: number } })?.response?.status
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '当前账号没有应用中心管理权限'
  if (status === 500) return '应用中心服务暂时不可用，请稍后再试'
  return '应用中心操作失败，请稍后再试'
}

const publicPath = (slug: string) =>
  `/api/public/apps/${encodeURIComponent(slug)}`
const adminPath = (id: number | string) => `/api/app-center/apps/${id}`

async function get<T>(
  path: string,
  params?: Record<string, string | undefined>
) {
  const response = await api.get<ApiResponse<T>>(path, {
    params,
    skipErrorHandler: true,
  })
  return response.data
}

async function write<T>(
  method: 'post' | 'put' | 'patch',
  path: string,
  data?: unknown
) {
  const response = await api[method]<ApiResponse<T>>(path, data, {
    skipErrorHandler: true,
  })
  return response.data
}

export function getPublicApps() {
  return get<DistributionApp[]>('/api/public/apps')
}
export function getDistributionApp(slug: string) {
  return get<DistributionApp>(publicPath(slug))
}
export function getDistributionReleases(slug: string, channel?: string) {
  return get<DistributionRelease[]>(`${publicPath(slug)}/releases`, {
    channel,
  })
}
export function getLatestDistributionRelease(slug: string, channel?: string) {
  return get<DistributionRelease>(`${publicPath(slug)}/releases/latest`, {
    channel,
  })
}
export function getDistributionAnnouncements(
  slug: string,
  params?: { channel?: string; platform?: string; version?: string }
) {
  return get<DistributionAnnouncement[]>(
    `${publicPath(slug)}/announcements`,
    params
  )
}
export function getDistributionAnnouncement(slug: string, id: number) {
  return get<DistributionAnnouncement>(
    `${publicPath(slug)}/announcements/${id}`
  )
}
export async function getPublicAnnouncements(apps: DistributionApp[]) {
  const responses = await Promise.all(
    apps.map((app) => getDistributionAnnouncements(app.slug))
  )
  return {
    success: true,
    data: responses.flatMap((response) => response.data ?? []),
  }
}
export function getDistributionAssetDownloadUrl(slug: string, id: number) {
  return `${publicPath(slug)}/assets/${id}/download`
}

export function getManagedDistributionApps() {
  return get<DistributionApp[]>('/api/app-center/apps')
}
export type AppCenterServerFile = {
  name: string
  size: number
  mod_time: number
  is_dir: boolean
}
export function getAppCenterServerFiles(path?: string) {
  return get<AppCenterServerFile[]>('/api/app-center/files', { path })
}
export function createManagedDistributionApp(input: {
  name: string
  slug: string
  description?: string
  public: boolean
  telemetry_enabled: boolean
}) {
  return write<{ app: DistributionApp; token?: string }>(
    'post',
    '/api/app-center/apps',
    input
  )
}
export function updateManagedDistributionApp(
  id: number,
  input: Partial<DistributionApp>
) {
  return write<DistributionApp>('put', adminPath(id), input)
}
export function revealManagedTelemetryToken(id: number) {
  return get<{ token: string }>(`${adminPath(id)}/telemetry-key`)
}
export function rotateManagedTelemetryToken(id: number) {
  return write<{ token: string }>(
    'post',
    `${adminPath(id)}/telemetry-key/rotate`
  )
}
export function getManagedDistributionReleases(id: number) {
  return get<DistributionRelease[]>(`${adminPath(id)}/releases`)
}
export function createManagedDistributionRelease(
  id: number,
  input: { version: string; channel: string; notes?: string }
) {
  return write<DistributionRelease>('post', `${adminPath(id)}/releases`, input)
}
export function publishManagedDistributionRelease(
  id: number,
  releaseID: number
) {
  return write<DistributionRelease>(
    'post',
    `${adminPath(id)}/releases/${releaseID}/publish`
  )
}
export async function uploadManagedDistributionAsset(
  id: number,
  releaseID: number,
  input: {
    file?: File
    serverFile?: string
    platform: string
    architecture: string
  }
) {
  const form = new FormData()
  if (input.file) form.append('file', input.file)
  if (input.serverFile) form.append('server_file', input.serverFile)
  form.append('platform', input.platform)
  form.append('architecture', input.architecture)
  const response = await api.post<ApiResponse<DistributionAsset>>(
    `${adminPath(id)}/releases/${releaseID}/assets`,
    form,
    { skipErrorHandler: true }
  )
  return response.data
}
export function getManagedDistributionAnnouncements(id: number) {
  return get<DistributionAnnouncement[]>(`${adminPath(id)}/announcements`)
}
export type DistributionAnnouncementInput = {
  title: string
  body: string
  starts_at?: string | null
  ends_at?: string | null
  pinned?: boolean
  channel?: string
  platform?: string
  min_version?: string
}
export function createManagedDistributionAnnouncement(
  id: number,
  input: DistributionAnnouncementInput
) {
  return write<DistributionAnnouncement>(
    'post',
    `${adminPath(id)}/announcements`,
    input
  )
}
export function publishManagedDistributionAnnouncement(
  id: number,
  announcementID: number
) {
  return write<DistributionAnnouncement>(
    'post',
    `${adminPath(id)}/announcements/${announcementID}/publish`
  )
}
export function getUsageSummary(id: number, hours: number) {
  return get<UsageBucket[]>(`${adminPath(id)}/usage`, { hours: String(hours) })
}
export function getAppCenterDownloads(id: number, hours: number) {
  return get<DownloadBucket[]>(`${adminPath(id)}/downloads`, {
    hours: String(hours),
  })
}
export function getUsageRegions(id: number, hours: number) {
  return get<EventRegion[]>(`${adminPath(id)}/usage/regions`, {
    hours: String(hours),
  })
}
export function getCustomEventsSummary(id: number, hours: number) {
  return get<CustomEventBucket[]>(`${adminPath(id)}/events`, {
    hours: String(hours),
  })
}
export function getCustomEventTrend(id: number, hours: number) {
  return get<EventTrend[]>(`${adminPath(id)}/events/trend`, {
    hours: String(hours),
  })
}
export function getCustomEventRegions(id: number, hours: number) {
  return get<EventRegionSummary>(`${adminPath(id)}/events/regions`, {
    hours: String(hours),
  })
}
export function getAppCenterCustomMessages(
  id: number,
  page: number,
  size: number
) {
  return get<CustomMessagePage>(`${adminPath(id)}/messages`, {
    page: String(page),
    size: String(size),
  })
}
export async function clearAppCenterCustomMessages(id: number) {
  const response = await api.delete<ApiResponse<null>>(
    `${adminPath(id)}/messages`,
    { skipErrorHandler: true }
  )
  return response.data
}
