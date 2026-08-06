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

export type DistributionAdminConnectionState =
  | 'no-slug'
  | 'locating-app'
  | 'app-unavailable'
  | 'awaiting-credential'
  | 'validating-credential'
  | 'credential-invalid'
  | 'connected'

export type DistributionAdminConnectionInput = {
  slug: string
  appFound: boolean
  appPending: boolean
  appError: boolean
  credential: string
  releasesSuccess: boolean
  releasesPending: boolean
  releasesError: boolean
  announcementsSuccess: boolean
  announcementsPending: boolean
  announcementsError: boolean
}

export function distributionAdminConnectionState(
  input: DistributionAdminConnectionInput
): DistributionAdminConnectionState {
  if (!input.slug.trim()) return 'no-slug'
  if (input.appPending) return 'locating-app'
  if (input.appError || !input.appFound) return 'app-unavailable'
  if (!input.credential.trim()) return 'awaiting-credential'
  if (input.releasesError || input.announcementsError) {
    return 'credential-invalid'
  }
  if (input.releasesSuccess && input.announcementsSuccess) return 'connected'
  if (input.releasesPending || input.announcementsPending) {
    return 'validating-credential'
  }
  return 'validating-credential'
}

export function distributionAdminConnectionTranslationKey(
  state: DistributionAdminConnectionState
): string {
  switch (state) {
    case 'no-slug':
      return 'Enter an app identifier to begin management'
    case 'locating-app':
      return 'Finding application…'
    case 'app-unavailable':
      return 'Application not found or unavailable'
    case 'awaiting-credential':
      return 'Application found. Enter a key.'
    case 'validating-credential':
      return 'Validating key…'
    case 'credential-invalid':
      return 'Invalid key or insufficient permissions'
    case 'connected':
      return 'Connected'
  }
}

export function distributionAnnouncementStatusTranslationKey(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft'
    case 'published':
      return 'Published'
    case 'archived':
      return 'Archived'
    default:
      return 'Unknown status'
  }
}
