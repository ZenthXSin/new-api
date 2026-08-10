/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Copy,
  FileUp,
  KeyRound,
  Megaphone,
  PackagePlus,
  Plus,
  RotateCw,
  Send,
  Settings2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { CopyButton } from '@/components/copy-button'
import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import {
  createManagedDistributionAnnouncement,
  createManagedDistributionApp,
  createManagedDistributionRelease,
  getCustomEventsSummary,
  getCustomEventTrend,
  getCustomEventRegions,
  getAppCenterDownloads,
  getAppCenterServerFiles,
  getManagedDistributionAnnouncements,
  getManagedDistributionApps,
  getManagedDistributionReleases,
  getUsageRegions,
  getUsageSummary,
  publishManagedDistributionAnnouncement,
  publishManagedDistributionRelease,
  revealManagedTelemetryToken,
  rotateManagedTelemetryToken,
  uploadManagedDistributionAsset,
  distributionErrorMessage,
} from './api'
import { DistributionTargetSelects } from './distribution-target-selects'
import {
  DownloadsTrendChart,
  TelemetryBarChart,
  TelemetryEventTrendChart,
  TelemetryRegionChart,
  TelemetryUsageTrendChart,
  type EventMetric,
  type UsageMetric,
} from './telemetry-charts'
import {
  formatOnlineDuration,
  rankEventRows,
  rankUsageRows,
  summarizeDownloads,
  summarizeEvents,
  summarizeUsage,
} from './telemetry-data'

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function DistributionAdmin() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const [selectedID, setSelectedID] = useState(0)
  const [tab, setTab] = useState<'content' | 'usage' | 'events'>('content')
  const [hours, setHours] = useState(24)
  const [usageMetric, setUsageMetric] = useState<UsageMetric>('starts')
  const [eventMetric, setEventMetric] = useState<EventMetric>('unique_users')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [telemetryEnabled, setTelemetryEnabled] = useState(true)
  const [version, setVersion] = useState('')
  const [channel, setChannel] = useState('stable')
  const [notes, setNotes] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [releaseID, setReleaseID] = useState(0)
  const [platform, setPlatform] = useState('windows')
  const [architecture, setArchitecture] = useState('amd64')
  const [file, setFile] = useState<File | null>(null)
  const [uploadMode, setUploadMode] = useState<'local' | 'server'>('local')
  const [serverFile, setServerFile] = useState('')
  const [token, setToken] = useState('')
  const appsQuery = useQuery({
    queryKey: ['app-center-apps'],
    queryFn: getManagedDistributionApps,
  })
  const serverFilesQuery = useQuery({
    queryKey: ['app-center-server-files'],
    queryFn: getAppCenterServerFiles,
    enabled: uploadMode === 'server',
  })
  const app = (appsQuery.data?.data ?? []).find(
    (item) => item.id === selectedID
  )
  const releasesQuery = useQuery({
    queryKey: ['app-center-releases', selectedID],
    queryFn: () => getManagedDistributionReleases(selectedID),
    enabled: selectedID > 0,
  })
  const announcementsQuery = useQuery({
    queryKey: ['app-center-announcements', selectedID],
    queryFn: () => getManagedDistributionAnnouncements(selectedID),
    enabled: selectedID > 0,
  })
  const usageQuery = useQuery({
    queryKey: ['app-center-usage', selectedID, hours],
    queryFn: async () =>
      summarizeUsage((await getUsageSummary(selectedID, hours)).data, hours),
    enabled: selectedID > 0 && tab === 'usage',
  })
  const usageRegionsQuery = useQuery({
    queryKey: ['app-center-usage-regions', selectedID, hours],
    queryFn: () => getUsageRegions(selectedID, hours),
    enabled: selectedID > 0 && tab === 'usage',
  })
  const eventsQuery = useQuery({
    queryKey: ['app-center-events', selectedID, hours],
    queryFn: async () => {
      const [events, regions, trend] = await Promise.all([
        getCustomEventsSummary(selectedID, hours),
        getCustomEventRegions(selectedID, hours),
        getCustomEventTrend(selectedID, hours),
      ])
      return {
        summary: summarizeEvents(
          events.data,
          regions.data.events,
          trend.data,
          hours
        ),
        regions: regions.data,
      }
    },
    enabled: selectedID > 0 && tab === 'events',
  })
  const downloadsQuery = useQuery({
    queryKey: ['app-center-downloads', selectedID, hours],
    queryFn: async () =>
      summarizeDownloads(
        (await getAppCenterDownloads(selectedID, hours)).data ?? [],
        hours
      ),
    enabled: selectedID > 0 && tab === 'content',
  })
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['app-center-apps'] })
    void queryClient.invalidateQueries({
      queryKey: ['app-center-releases', selectedID],
    })
    void queryClient.invalidateQueries({
      queryKey: ['app-center-announcements', selectedID],
    })
  }
  const createApp = useMutation({
    mutationFn: () =>
      createManagedDistributionApp({
        name: name.trim(),
        slug: slug.trim(),
        description,
        public: isPublic,
        telemetry_enabled: telemetryEnabled,
      }),
    onSuccess: (result) => {
      invalidate()
      if (result.data?.token) setToken(result.data.token)
      if (result.data?.app) setSelectedID(result.data.app.id)
      setName('')
      setSlug('')
      setDescription('')
      toast.success('应用已创建')
    },
    onError: () => toast.error('操作失败，请检查权限和输入'),
  })
  const createRelease = useMutation({
    mutationFn: () =>
      createManagedDistributionRelease(selectedID, { version, channel, notes }),
    onSuccess: () => {
      invalidate()
      setVersion('')
      setNotes('')
      toast.success('版本草稿已创建')
    },
    onError: () => toast.error('操作失败，请检查权限'),
  })
  const createAnnouncement = useMutation({
    mutationFn: () =>
      createManagedDistributionAnnouncement(selectedID, {
        title,
        body,
        pinned: false,
        channel,
      }),
    onSuccess: () => {
      invalidate()
      setTitle('')
      setBody('')
      toast.success('公告草稿已创建')
    },
    onError: () => toast.error('操作失败，请检查权限'),
  })
  const publishRelease = useMutation({
    mutationFn: (id: number) =>
      publishManagedDistributionRelease(selectedID, id),
    onSuccess: () => {
      invalidate()
      toast.success('版本已发布')
    },
  })
  const publishAnnouncement = useMutation({
    mutationFn: (id: number) =>
      publishManagedDistributionAnnouncement(selectedID, id),
    onSuccess: () => {
      invalidate()
      toast.success('公告已发布')
    },
  })
  const upload = useMutation({
    mutationFn: () => {
      if ((!file && !serverFile) || !releaseID) throw new Error('missing')
      return uploadManagedDistributionAsset(selectedID, releaseID, {
        file: file ?? undefined,
        serverFile: uploadMode === 'server' ? serverFile : undefined,
        platform,
        architecture,
      })
    },
    onSuccess: () => {
      invalidate()
      setFile(null)
      setServerFile('')
      toast.success('安装包已上传')
    },
    onError: () => toast.error('上传失败，请确认版本仍为草稿'),
  })
  const reveal = useMutation({
    mutationFn: () => revealManagedTelemetryToken(selectedID),
    onSuccess: (result) => setToken(result.data.token),
    onError: () => toast.error('无法读取应用密钥'),
  })
  const rotate = useMutation({
    mutationFn: () => rotateManagedTelemetryToken(selectedID),
    onSuccess: (result) => {
      setToken(result.data.token)
      toast.success('应用密钥已轮换')
    },
    onError: () => toast.error('应用密钥轮换失败'),
  })
  if (!user || user.role < ROLE.ADMIN) {
    return (
      <SectionPageLayout>
        <SectionPageLayout.Title>{'应用分发'}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <p className='text-muted-foreground py-12 text-center text-sm'>
            {'无权管理应用分发'}
          </p>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    )
  }
  if (appsQuery.isError) {
    return (
      <SectionPageLayout>
        <SectionPageLayout.Title>{'应用分发'}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <p className='text-muted-foreground py-12 text-center text-sm'>
            {t(distributionErrorMessage(appsQuery.error))}
          </p>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    )
  }
  const releases = releasesQuery.data?.data ?? []
  const announcements = announcementsQuery.data?.data ?? []
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        <span className='inline-flex items-center gap-2'>
          <Settings2 className='size-4' />
          {'应用分发管理'}
        </span>
      </SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-6xl flex-col gap-6'>
          <section className='grid gap-4 border-b pb-5 md:grid-cols-[1fr_auto]'>
            <div className='grid gap-2'>
              <Label htmlFor='app-select'>{'应用'}</Label>
              <select
                id='app-select'
                value={selectedID || ''}
                onChange={(event) => {
                  const id = Number(event.target.value)
                  setSelectedID(id)
                  setToken('')
                }}
                className='border-input bg-background h-9 rounded-md border px-3 text-sm'
              >
                <option value=''>{'选择应用'}</option>
                {(appsQuery.data?.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.slug})
                  </option>
                ))}
              </select>
            </div>
            <div className='flex items-end gap-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setSelectedID(0)
                  setName('')
                  setSlug('')
                }}
              >
                <Plus className='mr-1 size-4' />
                {'新建应用'}
              </Button>
            </div>
          </section>
          {!app && (
            <section className='grid gap-3 border-b pb-6 md:grid-cols-2'>
              <h2 className='font-semibold md:col-span-2'>{'创建应用'}</h2>
              <Input
                aria-label={'名称'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={'名称'}
              />
              <Input
                aria-label={'标识'}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={'标识（slug）'}
              />
              <Textarea
                className='md:col-span-2'
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={'描述'}
              />
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={isPublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                {'公开应用'}
              </label>
              <label className='flex items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={telemetryEnabled}
                  onChange={(e) => setTelemetryEnabled(e.target.checked)}
                />
                {'启用软件遥测'}
              </label>
              <div className='md:col-span-2'>
                <Button
                  disabled={!name.trim() || !slug.trim() || createApp.isPending}
                  onClick={() => createApp.mutate()}
                >
                  {'创建应用'}
                </Button>
              </div>
            </section>
          )}
          {app && (
            <>
              <section className='flex flex-wrap items-center justify-between gap-3 border-b pb-5'>
                <div>
                  <h2 className='font-semibold'>{app.name}</h2>
                  <p className='text-muted-foreground text-sm'>
                    {app.slug}
                    {app.description ? ` · ${app.description}` : ''}
                  </p>
                </div>
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    onClick={() => reveal.mutate()}
                    disabled={reveal.isPending}
                  >
                    <KeyRound className='mr-1 size-4' />
                    {'查看应用密钥'}
                  </Button>
                  <Button
                    variant='outline'
                    onClick={() => rotate.mutate()}
                    disabled={rotate.isPending}
                  >
                    <RotateCw className='mr-1 size-4' />
                    {'轮换应用密钥'}
                  </Button>
                </div>
              </section>
              {token && (
                <section className='flex flex-wrap items-center gap-2 border-b pb-5'>
                  <Input
                    readOnly
                    value={token}
                    className='max-w-xl font-mono text-xs'
                  />
                  <CopyButton
                    value={token}
                    size='icon'
                    tooltip={'复制'}
                    aria-label={'复制'}
                  >
                    <Copy className='size-4' />
                  </CopyButton>
                  <span className='text-muted-foreground text-xs'>
                    {'应用密钥仅用于外部软件遥测，网页管理不需要密钥'}
                  </span>
                </section>
              )}
              <nav
                className='flex flex-wrap gap-2 border-b pb-3'
                aria-label={'分组'}
              >
                <Button
                  variant={tab === 'content' ? 'default' : 'outline'}
                  onClick={() => setTab('content')}
                >
                  {'版本与公告'}
                </Button>
                <Button
                  variant={tab === 'usage' ? 'default' : 'outline'}
                  onClick={() => setTab('usage')}
                >
                  {'软件使用'}
                </Button>
                <Button
                  variant={tab === 'events' ? 'default' : 'outline'}
                  onClick={() => setTab('events')}
                >
                  {'自定义事件'}
                </Button>
                <select
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value))}
                  className='border-input bg-background h-9 rounded-md border px-2 text-sm'
                >
                  <option value={24}>{'最近24小时'}</option>
                  <option value={168}>{'最近7天'}</option>
                  <option value={720}>{'最近30天'}</option>
                </select>
              </nav>
              {tab === 'usage' && (
                <TelemetryUsageView
                  data={usageQuery.data}
                  regions={usageRegionsQuery.data?.data}
                  loading={usageQuery.isLoading || usageRegionsQuery.isLoading}
                  error={usageQuery.isError || usageRegionsQuery.isError}
                  metric={usageMetric}
                  onMetricChange={setUsageMetric}
                />
              )}
              {tab === 'events' && (
                <TelemetryEventsView
                  data={eventsQuery.data?.summary}
                  regions={eventsQuery.data?.regions.regions}
                  loading={eventsQuery.isLoading}
                  error={eventsQuery.isError}
                  metric={eventMetric}
                  onMetricChange={setEventMetric}
                />
              )}
              {tab === 'content' && (
                <>
                  <div className='grid gap-6 lg:grid-cols-2'>
                    <section className='space-y-3'>
                      <h2 className='flex items-center gap-2 font-semibold'>
                        <PackagePlus className='size-4' />
                        {'创建版本'}
                      </h2>
                      <Input
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        placeholder={'版本号'}
                      />
                      <Input
                        value={channel}
                        onChange={(e) => setChannel(e.target.value)}
                        placeholder={'发布渠道'}
                      />
                      <Textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder={'版本说明'}
                      />
                      <Button
                        disabled={!version || createRelease.isPending}
                        onClick={() => createRelease.mutate()}
                      >
                        <Plus className='mr-1 size-4' />
                        {'创建草稿'}
                      </Button>
                    </section>
                    <section className='space-y-3'>
                      <h2 className='flex items-center gap-2 font-semibold'>
                        <Megaphone className='size-4' />
                        {'创建公告'}
                      </h2>
                      <Input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={'公告标题'}
                      />
                      <Textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        placeholder={'公告内容'}
                      />
                      <Button
                        disabled={
                          !title || !body || createAnnouncement.isPending
                        }
                        onClick={() => createAnnouncement.mutate()}
                      >
                        <Plus className='mr-1 size-4' />
                        {'创建草稿'}
                      </Button>
                    </section>
                  </div>
                  <section className='space-y-3'>
                    <h2 className='flex items-center gap-2 font-semibold'>
                      <FileUp className='size-4' />
                      {'上传安装包'}
                    </h2>
                    <div className='grid gap-3 sm:grid-cols-4 sm:items-end'>
                      <select
                        value={releaseID}
                        onChange={(e) => setReleaseID(Number(e.target.value))}
                        className='border-input bg-background h-9 rounded-md border px-2 text-sm'
                      >
                        <option value={0}>{'选择草稿版本'}</option>
                        {releases
                          .filter((item) => item.status === 'draft')
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.version} · {item.channel}
                            </option>
                          ))}
                      </select>
                      <DistributionTargetSelects
                        platform={platform}
                        architecture={architecture}
                        onPlatformChange={setPlatform}
                        onArchitectureChange={setArchitecture}
                      />
                      <select
                        value={uploadMode}
                        onChange={(e) => {
                          setUploadMode(e.target.value as 'local' | 'server')
                          setFile(null)
                          setServerFile('')
                        }}
                        className='border-input bg-background h-9 rounded-md border px-2 text-sm'
                      >
                        <option value='local'>{'本地上传'}</option>
                        <option value='server'>{'选择服务器文件'}</option>
                      </select>
                      <div className='flex gap-2'>
                        {uploadMode === 'local' ? (
                          <Input
                            type='file'
                            onChange={(e) =>
                              setFile(e.target.files?.[0] ?? null)
                            }
                          />
                        ) : (
                          <select
                            value={serverFile}
                            onChange={(e) => setServerFile(e.target.value)}
                            className='border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-sm'
                          >
                            <option value=''>{'选择服务器文件'}</option>
                            {(serverFilesQuery.data?.data ?? []).map((item) => (
                              <option key={item.name} value={item.name}>
                                {item.name} ({formatFileSize(item.size)})
                              </option>
                            ))}
                          </select>
                        )}
                        <Button
                          disabled={
                            (uploadMode === 'local' ? !file : !serverFile) ||
                            !releaseID ||
                            !platform ||
                            !architecture ||
                            upload.isPending
                          }
                          onClick={() => upload.mutate()}
                        >
                          <FileUp className='size-4' />
                        </Button>
                      </div>
                    </div>
                  </section>
                  {downloadsQuery.data && (
                    <DownloadsTrendChart data={downloadsQuery.data} />
                  )}
                  <ContentList
                    title={'版本列表'}
                    items={releases.map((item) => ({
                      id: item.id,
                      label: `v${item.version} · ${item.channel}`,
                      status: item.status,
                      action:
                        item.status === 'draft'
                          ? () => publishRelease.mutate(item.id)
                          : undefined,
                    }))}
                    actionLabel={'发布'}
                  />
                  <ContentList
                    title={'公告列表'}
                    items={announcements.map((item) => ({
                      id: item.id,
                      label: item.title,
                      status: item.status,
                      action:
                        item.status === 'draft'
                          ? () => publishAnnouncement.mutate(item.id)
                          : undefined,
                    }))}
                    actionLabel={'发布'}
                  />
                </>
              )}
            </>
          )}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

function ContentList({
  title,
  items,
  actionLabel,
}: {
  title: string
  items: Array<{
    id: number
    label: string
    status: string
    action?: () => void
  }>
  actionLabel: string
}) {
  return (
    <section className='space-y-3'>
      <h2 className='font-semibold'>{title}</h2>
      <div className='divide-border divide-y border-y'>
        {items.length === 0 ? (
          <p className='text-muted-foreground py-5 text-sm'>{'暂无内容'}</p>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className='flex flex-wrap items-center justify-between gap-3 py-3'
            >
              <span>
                {item.label}
                <Badge variant='outline' className='ml-2'>
                  {item.status}
                </Badge>
              </span>
              {item.action && (
                <Button size='sm' onClick={item.action}>
                  <Send className='mr-1 size-4' />
                  {actionLabel}
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
function TelemetryUsageView({
  data,
  regions,
  loading,
  error,
  metric,
  onMetricChange,
}: {
  data?: import('./api').UsageSummary
  regions?: import('./api').EventRegion[]
  loading: boolean
  error: boolean
  metric: UsageMetric
  onMetricChange: (metric: UsageMetric) => void
}) {
  if (loading) return <p className='py-8 text-center text-sm'>{'加载中'}</p>
  if (error) {
    return (
      <p className='text-destructive py-8 text-center text-sm'>
        {'遥测数据加载失败，请稍后重试'}
      </p>
    )
  }
  if (!data) {
    return (
      <p className='text-muted-foreground py-8 text-center text-sm'>
        {'暂无数据'}
      </p>
    )
  }
  const rankedVersions = rankUsageRows(data.versions ?? [], metric)
  const rankedPlatforms = rankUsageRows(data.platforms ?? [], metric)
  const valueLabel = metric === 'active_users' ? '使用人数' : '启动次数'
  const formatValue = (value: number) => String(value)
  return (
    <section className='space-y-5'>
      <h2 className='font-semibold'>{'软件使用'}</h2>
      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <TelemetryMetric label={'启动次数'} value={data.starts} />
        <TelemetryMetric
          label={'在线时长'}
          value={formatOnlineDuration(data.online_seconds)}
        />
        <TelemetryMetric
          label={'平均会话时长'}
          value={formatOnlineDuration(data.average_session_seconds)}
        />
        <TelemetryMetric label={'地区数量'} value={(regions ?? []).length} />
      </div>
      <MetricToggle
        value={metric}
        options={[
          { value: 'starts', label: '启动次数' },
          { value: 'active_users', label: '使用人数' },
        ]}
        onChange={onMetricChange}
      />
      <TelemetryUsageTrendChart data={data.trend} metric={metric} />
      <div className='grid gap-5 lg:grid-cols-2'>
        <TelemetryBarChart
          title={
            metric === 'active_users' ? '版本使用人数排行' : '版本启动排行'
          }
          rows={rankedVersions.map((row) => ({
            label: row.version || '未知版本',
            value: row[metric],
          }))}
          valueLabel={valueLabel}
          formatValue={formatValue}
        />
        <TelemetryBarChart
          title={
            metric === 'active_users' ? '平台使用人数排行' : '平台启动排行'
          }
          rows={rankedPlatforms.map((row) => ({
            label: row.platform || '未知平台',
            value: row[metric],
          }))}
          valueLabel={valueLabel}
          formatValue={formatValue}
        />
      </div>
      <TelemetryRegionChart
        rows={regions ?? []}
        title={'软件使用地区分布（独立安装）'}
        valueLabel={'独立安装'}
      />
    </section>
  )
}

function TelemetryMetric({
  label,
  value,
}: {
  label: string
  value: number | string
}) {
  return (
    <div className='border-b py-3'>
      <p className='text-muted-foreground text-sm'>{label}</p>
      <p className='text-2xl font-semibold tabular-nums'>{value}</p>
    </div>
  )
}

function MetricToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div
      className='bg-muted/60 inline-flex max-w-full overflow-x-auto rounded-md border p-0.5'
      role='group'
    >
      {options.map((option) => (
        <Button
          key={option.value}
          type='button'
          size='sm'
          variant={value === option.value ? 'default' : 'ghost'}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className='shrink-0'
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
function TelemetryEventsView({
  data,
  regions,
  loading,
  error,
  metric,
  onMetricChange,
}: {
  data?: import('./api').CustomEventsSummary
  regions?: import('./api').EventRegion[]
  loading: boolean
  error: boolean
  metric: EventMetric
  onMetricChange: (metric: EventMetric) => void
}) {
  if (loading) return <p className='py-8 text-center text-sm'>{'加载中'}</p>
  if (error) {
    return (
      <p className='text-destructive py-8 text-center text-sm'>
        {'遥测数据加载失败，请稍后重试'}
      </p>
    )
  }
  const rows = data?.events ?? []
  const rankedRows = rankEventRows(rows, metric)
  return (
    <section className='space-y-4'>
      <h2 className='font-semibold'>{'自定义事件'}</h2>
      <div className='grid gap-3 sm:grid-cols-3'>
        <TelemetryMetric
          label={'事件总次数'}
          value={rows.reduce((total, row) => total + row.count, 0)}
        />
        <TelemetryMetric label={'事件种类'} value={rows.length} />
        <TelemetryMetric
          label={'独立 IP（事件合计）'}
          value={rows.reduce((total, row) => total + row.unique_users, 0)}
        />
      </div>
      <MetricToggle
        value={metric}
        options={[
          { value: 'unique_users', label: '独立 IP' },
          { value: 'count', label: '触发次数' },
        ]}
        onChange={onMetricChange}
      />
      <TelemetryEventTrendChart data={data?.trend ?? []} metric={metric} />
      <div className='grid gap-5 lg:grid-cols-2'>
        <TelemetryBarChart
          title={
            metric === 'unique_users' ? '事件独立 IP 排行' : '事件触发排行'
          }
          rows={rankedRows.map((row) => ({
            label: row.name,
            value: row[metric],
          }))}
          valueLabel={metric === 'unique_users' ? '独立 IP' : '触发次数'}
        />
        <TelemetryRegionChart
          rows={regions ?? []}
          title={'事件地区分布（独立 IP）'}
          valueLabel={'独立 IP'}
        />
      </div>
      <div className='divide-border divide-y border-y'>
        {rows.length === 0 ? (
          <p className='text-muted-foreground py-5 text-sm'>{'暂无事件'}</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.name}
              className='flex flex-wrap justify-between gap-2 py-3 text-sm'
            >
              <span>{row.name}</span>
              <span>
                {row.count} {'次'} · {row.unique_users} {'个独立 IP'}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
