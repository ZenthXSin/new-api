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
import { test } from 'node:test'

import { QueryClient } from '@tanstack/react-query'

import {
  distributionManagementQueryKey,
  submitDistributionManagementCredential,
} from '../api'
import {
  distributionAdminConnectionTranslationKey,
  distributionAdminConnectionState,
  distributionAnnouncementStatusTranslationKey,
} from '../distribution-admin-state'
import { formatDistributionDate } from '../distribution-display'

test('submitting a replacement bearer refetches management data without caching the secret', async () => {
  const firstConnection = submitDistributionManagementCredential(
    'app_v1.old-secret',
    0
  )
  const replacementConnection = submitDistributionManagementCredential(
    'app_v1.rotated-secret',
    firstConnection.credentialGeneration
  )
  const first = distributionManagementQueryKey(
    'releases',
    'desktop',
    firstConnection.credentialGeneration
  )
  const replacement = distributionManagementQueryKey(
    'releases',
    'desktop',
    replacementConnection.credentialGeneration
  )

  const queryClient = new QueryClient()
  let requests = 0
  await queryClient.fetchQuery({
    queryKey: first,
    queryFn: () => {
      requests += 1
      return { releaseCount: 1 }
    },
  })
  await queryClient.fetchQuery({
    queryKey: replacement,
    queryFn: () => {
      requests += 1
      return { releaseCount: 2 }
    },
  })

  assert.equal(requests, 2)
  assert.notDeepEqual(replacement, first)
  assert.equal(replacementConnection.bearer, 'app_v1.rotated-secret')
  assert.equal(
    JSON.stringify(queryClient.getQueryCache().getAll()).includes(
      'app_v1.rotated-secret'
    ),
    false
  )
})

test('announcement statuses expose stable translation keys', () => {
  assert.equal(distributionAnnouncementStatusTranslationKey('draft'), 'Draft')
  assert.equal(
    distributionAnnouncementStatusTranslationKey('published'),
    'Published'
  )
  assert.equal(
    distributionAnnouncementStatusTranslationKey('archived'),
    'Archived'
  )
  assert.equal(
    distributionAnnouncementStatusTranslationKey('future-status'),
    'Unknown status'
  )
})

const foundAppConnection = {
  slug: 'desktop',
  appFound: true,
  appPending: false,
  appError: false,
  credential: 'app_v1.credential',
  releasesSuccess: false,
  releasesPending: false,
  releasesError: false,
  announcementsSuccess: false,
  announcementsPending: false,
  announcementsError: false,
}

test('public app success without a credential is not connected', () => {
  const state = distributionAdminConnectionState({
    ...foundAppConnection,
    credential: '',
  })

  assert.equal(state, 'awaiting-credential')
  assert.notEqual(state, 'connected')
})

test('submitted credential remains validating until management queries finish', () => {
  const state = distributionAdminConnectionState({
    ...foundAppConnection,
    releasesPending: true,
    announcementsPending: true,
  })

  assert.equal(state, 'validating-credential')
})

test('either management query error reports an invalid credential', () => {
  for (const input of [
    { ...foundAppConnection, releasesError: true },
    { ...foundAppConnection, announcementsError: true },
  ]) {
    const state = distributionAdminConnectionState(input)

    assert.equal(state, 'credential-invalid')
    assert.equal(
      distributionAdminConnectionTranslationKey(state),
      'Invalid key or insufficient permissions'
    )
  }
})

test('both successful management queries establish a connection', () => {
  const state = distributionAdminConnectionState({
    ...foundAppConnection,
    releasesSuccess: true,
    announcementsSuccess: true,
  })

  assert.equal(state, 'connected')
  assert.equal(distributionAdminConnectionTranslationKey(state), 'Connected')
})

test('distribution dates follow the current language', () => {
  const value = '2026-01-02T12:00:00.000Z'

  assert.equal(
    formatDistributionDate(value, 'fr-FR', 'long'),
    new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(
      new Date(value)
    )
  )
})
