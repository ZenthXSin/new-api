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

export type DistributionApp = { id: number; slug: string; name: string }

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

type ApiResponse<T> = { success: boolean; message?: string; data: T }

type DistributionManagementResource = 'releases' | 'announcements'

export function distributionManagementQueryKey(
  resource: DistributionManagementResource,
  slug: string,
  credentialGeneration: number
) {
  return ['distribution-admin', resource, slug, credentialGeneration] as const
}

export function submitDistributionManagementCredential(
  bearer: string,
  credentialGeneration: number
) {
  return {
    bearer: bearer.trim(),
    credentialGeneration: credentialGeneration + 1,
  }
}

const publicPath = (slug: string) =>
  `/api/distribution/apps/${encodeURIComponent(slug)}`

async function publicGet<T>(
  path: string,
  params?: Record<string, string | undefined>
) {
  const response = await api.get<ApiResponse<T>>(path, {
    params,
    skipErrorHandler: true,
  })
  return response.data
}

export function getDistributionApp(slug: string) {
  return publicGet<DistributionApp>(publicPath(slug))
}

export function getDistributionReleases(slug: string, channel?: string) {
  return publicGet<DistributionRelease[]>(`${publicPath(slug)}/releases`, {
    channel,
  })
}

export function getLatestDistributionRelease(slug: string, channel?: string) {
  return publicGet<DistributionRelease>(`${publicPath(slug)}/releases/latest`, {
    channel,
  })
}

export function getDistributionAnnouncements(
  slug: string,
  params?: { channel?: string; platform?: string; version?: string }
) {
  return publicGet<DistributionAnnouncement[]>(
    `${publicPath(slug)}/announcements`,
    params
  )
}

export async function getManagedDistributionReleases(
  slug: string,
  bearer: string
) {
  const response = await api.get<ApiResponse<DistributionRelease[]>>(
    `${publicPath(slug)}/manage/releases`,
    managementConfig(bearer)
  )
  return response.data
}

export async function getManagedDistributionAnnouncements(
  slug: string,
  bearer: string
) {
  const response = await api.get<ApiResponse<DistributionAnnouncement[]>>(
    `${publicPath(slug)}/manage/announcements`,
    managementConfig(bearer)
  )
  return response.data
}

export function getDistributionAnnouncement(slug: string, id: number) {
  return publicGet<DistributionAnnouncement>(
    `${publicPath(slug)}/announcements/${id}`
  )
}

export function getDistributionAssetDownloadUrl(slug: string, id: number) {
  return `${publicPath(slug)}/assets/${id}/download`
}

function writeConfig(bearer: string) {
  return {
    headers: { Authorization: `Bearer ${bearer.trim()}` },
    skipErrorHandler: true,
    skipAuthRefresh: true,
    skipPanelAuth: true,
  }
}

function managementConfig(bearer: string) {
  return {
    ...writeConfig(bearer),
    skipRequestDedup: true,
  }
}

export async function createDistributionRelease(
  slug: string,
  bearer: string,
  input: { version: string; channel: string; notes?: string }
) {
  const response = await api.post<ApiResponse<DistributionRelease>>(
    `${publicPath(slug)}/releases`,
    input,
    writeConfig(bearer)
  )
  return response.data
}

export async function updateDistributionRelease(
  slug: string,
  bearer: string,
  id: number,
  input: { version: string; channel: string; notes?: string }
) {
  const response = await api.put<ApiResponse<DistributionRelease>>(
    `${publicPath(slug)}/releases/${id}`,
    input,
    writeConfig(bearer)
  )
  return response.data
}

export async function publishDistributionRelease(
  slug: string,
  bearer: string,
  id: number
) {
  const response = await api.post<ApiResponse<DistributionRelease>>(
    `${publicPath(slug)}/releases/${id}/publish`,
    undefined,
    writeConfig(bearer)
  )
  return response.data
}

export async function uploadDistributionAsset(
  slug: string,
  bearer: string,
  releaseID: number,
  input: { file: File; platform: string; architecture: string }
) {
  const form = new FormData()
  form.append('file', input.file)
  form.append('platform', input.platform)
  form.append('architecture', input.architecture)
  const response = await api.post<ApiResponse<DistributionAsset>>(
    `${publicPath(slug)}/releases/${releaseID}/assets`,
    form,
    {
      ...writeConfig(bearer),
      headers: {
        ...writeConfig(bearer).headers,
        'Content-Type': 'multipart/form-data',
      },
    }
  )
  return response.data
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

export async function createDistributionAnnouncement(
  slug: string,
  bearer: string,
  input: DistributionAnnouncementInput
) {
  const response = await api.post<ApiResponse<DistributionAnnouncement>>(
    `${publicPath(slug)}/announcements`,
    input,
    writeConfig(bearer)
  )
  return response.data
}

export async function updateDistributionAnnouncement(
  slug: string,
  bearer: string,
  id: number,
  input: DistributionAnnouncementInput
) {
  const response = await api.put<ApiResponse<DistributionAnnouncement>>(
    `${publicPath(slug)}/announcements/${id}`,
    input,
    writeConfig(bearer)
  )
  return response.data
}

export async function publishDistributionAnnouncement(
  slug: string,
  bearer: string,
  id: number
) {
  const response = await api.post<ApiResponse<DistributionAnnouncement>>(
    `${publicPath(slug)}/announcements/${id}/publish`,
    undefined,
    writeConfig(bearer)
  )
  return response.data
}

export async function archiveDistributionAnnouncement(
  slug: string,
  bearer: string,
  id: number
) {
  const response = await api.post<ApiResponse<DistributionAnnouncement>>(
    `${publicPath(slug)}/announcements/${id}/archive`,
    undefined,
    writeConfig(bearer)
  )
  return response.data
}
