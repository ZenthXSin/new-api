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
import {
  FileUp,
  KeyRound,
  Megaphone,
  PackagePlus,
  Plus,
  Send,
  Settings2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import {
  createDistributionAnnouncement,
  createDistributionRelease,
  distributionManagementQueryKey,
  getDistributionApp,
  getManagedDistributionAnnouncements,
  getManagedDistributionReleases,
  publishDistributionAnnouncement,
  publishDistributionRelease,
  submitDistributionManagementCredential,
  uploadDistributionAsset,
} from './api'
import {
  distributionAdminConnectionTranslationKey,
  distributionAdminConnectionState,
  distributionAnnouncementStatusTranslationKey,
} from './distribution-admin-state'

export function DistributionAdmin() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const [slug, setSlug] = useState('')
  const [bearerDraft, setBearerDraft] = useState('')
  const [bearer, setBearer] = useState('')
  const [credentialGeneration, setCredentialGeneration] = useState(0)
  const [version, setVersion] = useState('')
  const [channel, setChannel] = useState('stable')
  const [notes, setNotes] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assetRelease, setAssetRelease] = useState(0)
  const [platform, setPlatform] = useState('')
  const [architecture, setArchitecture] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const appQuery = useQuery({
    queryKey: ['distribution-admin-app', slug],
    queryFn: () => getDistributionApp(slug),
    enabled: slug.trim().length > 0,
  })
  const releasesQuery = useQuery({
    queryKey: distributionManagementQueryKey(
      'releases',
      slug,
      credentialGeneration
    ),
    queryFn: () => getManagedDistributionReleases(slug, bearer),
    enabled: !!appQuery.data?.data && bearer.trim().length > 0,
  })
  const announcementsQuery = useQuery({
    queryKey: distributionManagementQueryKey(
      'announcements',
      slug,
      credentialGeneration
    ),
    queryFn: () => getManagedDistributionAnnouncements(slug, bearer),
    enabled: !!appQuery.data?.data && bearer.trim().length > 0,
  })
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['distribution-admin', 'releases', slug],
    })
    void queryClient.invalidateQueries({
      queryKey: ['distribution-admin', 'announcements', slug],
    })
  }
  const submitBearer = () => {
    const connection = submitDistributionManagementCredential(
      bearerDraft,
      credentialGeneration
    )
    if (!connection.bearer) return
    queryClient.removeQueries({
      queryKey: ['distribution-admin', 'releases', slug],
    })
    queryClient.removeQueries({
      queryKey: ['distribution-admin', 'announcements', slug],
    })
    setBearer(connection.bearer)
    setCredentialGeneration(connection.credentialGeneration)
  }
  const write = useMutation({
    mutationFn: async (kind: 'release' | 'announcement') =>
      kind === 'release'
        ? createDistributionRelease(slug, bearer, { version, channel, notes })
        : createDistributionAnnouncement(slug, bearer, {
            title,
            body,
            pinned: false,
            channel,
          }),
    onSuccess: (_data, kind) => {
      invalidate()
      toast.success(
        kind === 'release'
          ? t('Release draft created')
          : t('Announcement draft created')
      )
      if (kind === 'release') {
        setVersion('')
        setNotes('')
      } else {
        setTitle('')
        setBody('')
      }
    },
    onError: () =>
      toast.error(t('Operation failed. Check the distribution address and key.')),
  })
  const publishRelease = useMutation({
    mutationFn: (id: number) => publishDistributionRelease(slug, bearer, id),
    onSuccess: () => {
      invalidate()
      toast.success(t('Release published'))
    },
    onError: () => toast.error(t('Publish failed')),
  })
  const publishAnnouncement = useMutation({
    mutationFn: (id: number) =>
      publishDistributionAnnouncement(slug, bearer, id),
    onSuccess: () => {
      invalidate()
      toast.success(t('Announcement published'))
    },
    onError: () => toast.error(t('Publish failed')),
  })
  const upload = useMutation({
    mutationFn: () => {
      if (!file || !assetRelease) throw new Error('missing')
      return uploadDistributionAsset(slug, bearer, assetRelease, {
        file,
        platform,
        architecture,
      })
    },
    onSuccess: () => {
      invalidate()
      setFile(null)
      toast.success(t('Installer uploaded'))
    },
    onError: () =>
      toast.error(t('Upload failed. Confirm the release is still a draft.')),
  })

  if (!user || user.role !== ROLE.SUPER_ADMIN) {
    return (
      <SectionPageLayout>
        <SectionPageLayout.Title>{t('Distribution management')}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <p className='text-muted-foreground py-12 text-center text-sm'>
            {t('Only root administrators can manage external distribution content.')}
          </p>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    )
  }
  const app = appQuery.data?.data
  const connectionState = distributionAdminConnectionState({
    slug,
    appFound: !!app,
    appPending: appQuery.isPending,
    appError: appQuery.isError,
    credential: bearer,
    releasesSuccess: releasesQuery.isSuccess,
    releasesPending: releasesQuery.isPending,
    releasesError: releasesQuery.isError,
    announcementsSuccess: announcementsQuery.isSuccess,
    announcementsPending: announcementsQuery.isPending,
    announcementsError: announcementsQuery.isError,
  })
  const connected = connectionState === 'connected'
  const releases = connected ? (releasesQuery.data?.data ?? []) : []
  const announcements = connected ? (announcementsQuery.data?.data ?? []) : []
  const connectionLabel =
    connectionState === 'connected' && app
      ? t('Connected: {{appName}}', { appName: app.name })
      : t(distributionAdminConnectionTranslationKey(connectionState))
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex items-center gap-2'>
          <Settings2 className='size-4' />
          {t('Distribution management')}
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-6xl flex-col gap-6'>
          <section className='border-border grid gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end'>
            <div className='grid gap-2'>
              <Label htmlFor='distribution-slug'>{t('App identifier')}</Label>
              <Input
                id='distribution-slug'
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder={t('For example, desktop')}
              />
            </div>
            <div className='grid gap-2'>
              <Label htmlFor='distribution-bearer'>{t('App Bearer key')}</Label>
              <div className='relative'>
                <KeyRound className='text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4' />
                <Input
                  id='distribution-bearer'
                  className='pl-8'
                  type='password'
                  value={bearerDraft}
                  onChange={(event) => setBearerDraft(event.target.value)}
                  placeholder={t('For write operations only')}
                />
              </div>
            </div>
            <div className='flex items-center gap-3 sm:pb-2'>
              <Button
                disabled={!app || !bearerDraft.trim()}
                onClick={submitBearer}
              >
                {t('Connect')}
              </Button>
              <span className='text-muted-foreground text-sm'>
                {connectionLabel}
              </span>
            </div>
          </section>
          {connected && (
            <>
              <div className='grid gap-6 lg:grid-cols-2'>
                <section className='space-y-4'>
                  <div className='flex items-center gap-2'>
                    <PackagePlus className='size-4' />
                    <h2 className='font-semibold'>{t('Create release')}</h2>
                  </div>
                  <div className='grid gap-3 sm:grid-cols-2'>
                    <div className='grid gap-2'>
                      <Label htmlFor='distribution-version'>{t('Version')}</Label>
                      <Input
                        id='distribution-version'
                        value={version}
                        onChange={(event) => setVersion(event.target.value)}
                        placeholder='1.0.0'
                      />
                    </div>
                    <div className='grid gap-2'>
                      <Label htmlFor='distribution-channel'>{t('Release channel')}</Label>
                      <Input
                        id='distribution-channel'
                        value={channel}
                        onChange={(event) => setChannel(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className='grid gap-2'>
                    <Label htmlFor='distribution-notes'>{t('Release notes (optional)')}</Label>
                    <Textarea
                      id='distribution-notes'
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      rows={4}
                    />
                  </div>
                  <Button
                    disabled={
                      !version || !channel || write.isPending
                    }
                    onClick={() => write.mutate('release')}
                  >
                    <Plus />
                    {t('Create release draft')}
                  </Button>
                </section>
                <section className='space-y-4'>
                  <div className='flex items-center gap-2'>
                    <Megaphone className='size-4' />
                    <h2 className='font-semibold'>{t('Create announcement')}</h2>
                  </div>
                  <div className='grid gap-2'>
                    <Label htmlFor='distribution-title'>{t('Announcement title')}</Label>
                    <Input
                      id='distribution-title'
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </div>
                  <div className='grid gap-2'>
                    <Label htmlFor='distribution-body'>
                      {t('Announcement content (Markdown supported)')}
                    </Label>
                    <Textarea
                      id='distribution-body'
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      rows={4}
                    />
                  </div>
                  <Button
                    disabled={!title || !body || write.isPending}
                    onClick={() => write.mutate('announcement')}
                  >
                    <Plus />
                    {t('Create announcement draft')}
                  </Button>
                </section>
              </div>
              <section className='space-y-4'>
                <div className='flex items-center gap-2'>
                  <FileUp className='size-4' />
                  <h2 className='font-semibold'>{t('Upload installer')}</h2>
                </div>
                <div className='grid gap-3 sm:grid-cols-4 sm:items-end'>
                  <div className='grid gap-2'>
                    <Label htmlFor='asset-release'>{t('Version')}</Label>
                    <select
                      id='asset-release'
                      value={assetRelease}
                      onChange={(event) =>
                        setAssetRelease(Number(event.target.value))
                      }
                      className='border-input bg-background h-8 rounded-md border px-2 text-sm'
                    >
                      <option value={0}>{t('Select a draft release')}</option>
                      {releases
                        .filter((item) => item.status === 'draft')
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            v{item.version} · {item.channel}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className='grid gap-2'>
                    <Label htmlFor='asset-platform'>{t('Platform')}</Label>
                    <Input
                      id='asset-platform'
                      value={platform}
                      onChange={(event) => setPlatform(event.target.value)}
                      placeholder='windows'
                    />
                  </div>
                  <div className='grid gap-2'>
                    <Label htmlFor='asset-architecture'>{t('Architecture')}</Label>
                    <Input
                      id='asset-architecture'
                      value={architecture}
                      onChange={(event) => setArchitecture(event.target.value)}
                      placeholder='x64'
                    />
                  </div>
                  <div className='flex gap-2'>
                    <Input
                      type='file'
                      onChange={(event) =>
                        setFile(event.target.files?.[0] ?? null)
                      }
                    />
                    <Button
                      disabled={
                        !file ||
                        !assetRelease ||
                        !platform ||
                        !architecture ||
                        upload.isPending
                      }
                      onClick={() => upload.mutate()}
                    >
                      <FileUp />
                      {t('Upload')}
                    </Button>
                  </div>
                </div>
              </section>
              <section className='space-y-3'>
                <h2 className='font-semibold'>{t('Release drafts and publishing')}</h2>
                <div className='divide-border divide-y border-y'>
                  {releases.length === 0 ? (
                    <p className='text-muted-foreground py-6 text-sm'>
                      {t('No releases.')}
                    </p>
                  ) : (
                    releases.map((item) => (
                      <div
                        key={item.id}
                        className='flex flex-wrap items-center justify-between gap-3 py-3'
                      >
                        <div>
                          <span className='font-medium'>v{item.version}</span>
                          <Badge variant='outline' className='ml-2'>
                            {item.channel}
                          </Badge>
                          <span className='text-muted-foreground ml-2 text-xs'>
                            {t('{{count}} installers', {
                              count: item.assets?.length ?? 0,
                            })}
                          </span>
                        </div>
                        {item.status === 'draft' && (
                          <Button
                            size='sm'
                            disabled={
                              !item.assets?.length ||
                              publishRelease.isPending
                            }
                            onClick={() => publishRelease.mutate(item.id)}
                          >
                            <Send />
                            {t('Publish')}
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
              <section className='space-y-3'>
                <h2 className='font-semibold'>{t('Announcement drafts and publishing')}</h2>
                <div className='divide-border divide-y border-y'>
                  {announcements.length === 0 ? (
                    <p className='text-muted-foreground py-6 text-sm'>
                      {t('No announcements.')}
                    </p>
                  ) : (
                    announcements.map((item) => (
                      <div
                        key={item.id}
                        className='flex flex-wrap items-center justify-between gap-3 py-3'
                      >
                        <div>
                          <span className='font-medium'>{item.title}</span>
                          <Badge variant='outline' className='ml-2'>
                            {t(
                              distributionAnnouncementStatusTranslationKey(
                                item.status
                              )
                            )}
                          </Badge>
                        </div>
                        {item.status === 'draft' && (
                          <Button
                            size='sm'
                            disabled={publishAnnouncement.isPending}
                            onClick={() => publishAnnouncement.mutate(item.id)}
                          >
                            <Send />
                            {t('Publish')}
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
