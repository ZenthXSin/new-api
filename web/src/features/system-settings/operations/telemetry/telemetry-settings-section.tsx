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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { StaticDataTable } from '@/components/data-table/static/static-data-table'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../../components/settings-form-layout'
import { SettingsPageFormActions } from '../../components/settings-page-context'
import { SettingsSection } from '../../components/settings-section'
import { useResetForm } from '../../hooks/use-reset-form'
import { useUpdateOption } from '../../hooks/use-update-option'
import { safeNumberFieldProps } from '../../utils/numeric-field'
import {
  cleanupTelemetryData,
  createTelemetryApp,
  createTelemetryProject,
  createTelemetryWriteKey,
  disableTelemetryWriteKey,
  getTelemetryApps,
  getTelemetryProjects,
  getTelemetrySummary,
  getTelemetryTimeSeries,
  getTelemetryWriteKeys,
  type TelemetryApp,
  type TelemetryWriteKey,
} from './api'
import { TelemetryDashboard } from './telemetry-dashboard'

type FlatDefaults = {
  'telemetry_setting.enabled': boolean
  'telemetry_setting.retention_days': number
  'telemetry_setting.max_body_bytes': number
  'telemetry_setting.max_events_per_batch': number
  'telemetry_setting.timestamp_skew_seconds': number
  'telemetry_setting.requests_per_minute': number
}

const telemetrySchema = z.object({
  telemetry_setting: z.object({
    enabled: z.boolean(),
    retention_days: z.coerce.number().int().min(1).max(3650),
    max_body_bytes: z.coerce.number().int().min(1024).max(1048576),
    max_events_per_batch: z.coerce.number().int().min(1).max(1000),
    timestamp_skew_seconds: z.coerce.number().int().min(30).max(3600),
    requests_per_minute: z.coerce.number().int().min(1).max(10000),
  }),
})

type TelemetryFormValues = z.output<typeof telemetrySchema>

type NameDialogProps = {
  open: boolean
  title: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}

function NameDialog({ open, title, onOpenChange, onSubmit }: NameDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [isPending, setIsPending] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim()) return
    setIsPending(true)
    try {
      await onSubmit(name.trim())
      setName('')
      onOpenChange(false)
    } finally {
      setIsPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button disabled={isPending || !name.trim()} onClick={handleSubmit}>
            {t('Create')}
          </Button>
        </>
      }
    >
      <div className='grid gap-2'>
        <Label htmlFor='telemetry-name'>{t('Name')}</Label>
        <Input
          id='telemetry-name'
          value={name}
          maxLength={128}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </div>
    </Dialog>
  )
}

const telemetryFields = [
  ['retention_days', 'Retention days'],
  ['max_body_bytes', 'Maximum request bytes'],
  ['max_events_per_batch', 'Maximum events per batch'],
  ['requests_per_minute', 'Requests per minute'],
] as const

export function TelemetrySettingsSection({
  defaultValues,
}: {
  defaultValues: FlatDefaults
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const updateOption = useUpdateOption()
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [appDialogOpen, setAppDialogOpen] = useState(false)
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [selectedProjectID, setSelectedProjectID] = useState(0)
  const [selectedAppID, setSelectedAppID] = useState(0)
  const [hours, setHours] = useState(24)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [disableTarget, setDisableTarget] = useState<TelemetryWriteKey | null>(
    null
  )

  const formDefaults = useMemo(
    () => ({
      telemetry_setting: {
        enabled: defaultValues['telemetry_setting.enabled'],
        retention_days: defaultValues['telemetry_setting.retention_days'],
        max_body_bytes: defaultValues['telemetry_setting.max_body_bytes'],
        max_events_per_batch:
          defaultValues['telemetry_setting.max_events_per_batch'],
        timestamp_skew_seconds:
          defaultValues['telemetry_setting.timestamp_skew_seconds'],
        requests_per_minute:
          defaultValues['telemetry_setting.requests_per_minute'],
      },
    }),
    [defaultValues]
  )
  const baselineRef = useRef(JSON.stringify(defaultValues))
  const form = useForm({
    resolver: zodResolver(telemetrySchema),
    defaultValues: formDefaults,
  })
  useResetForm(form, formDefaults)

  useEffect(() => {
    baselineRef.current = JSON.stringify(defaultValues)
  }, [defaultValues])

  const enabled = form.watch('telemetry_setting.enabled')
  const projectsQuery = useQuery({
    queryKey: ['telemetry-projects'],
    queryFn: getTelemetryProjects,
  })
  const appsQuery = useQuery({
    queryKey: ['telemetry-apps', selectedProjectID],
    queryFn: () => getTelemetryApps(selectedProjectID || undefined),
  })
  const keysQuery = useQuery({
    queryKey: ['telemetry-keys', selectedAppID],
    queryFn: () => getTelemetryWriteKeys(selectedAppID),
    enabled: selectedAppID > 0,
  })
  const summaryQuery = useQuery({
    queryKey: ['telemetry-summary', selectedAppID, hours],
    queryFn: () => getTelemetrySummary(selectedAppID, hours),
    enabled: selectedAppID > 0,
  })
  const timeSeriesQuery = useQuery({
    queryKey: ['telemetry-timeseries', 'hourly-v1', selectedAppID, hours],
    queryFn: () => getTelemetryTimeSeries(selectedAppID, hours),
    enabled: selectedAppID > 0,
    refetchOnMount: 'always',
  })
  const disableKey = useMutation({
    mutationFn: disableTelemetryWriteKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['telemetry-keys'] })
      toast.success(t('Telemetry key disabled'))
    },
    onError: () => toast.error(t('Telemetry operation failed')),
  })
  const cleanup = useMutation({
    mutationFn: cleanupTelemetryData,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['telemetry-summary'] })
      queryClient.invalidateQueries({ queryKey: ['telemetry-timeseries'] })
      toast.success(t('Telemetry data cleaned up'))
    },
    onError: () => toast.error(t('Telemetry operation failed')),
  })

  const save = async (values: TelemetryFormValues) => {
    const normalized: FlatDefaults = {
      'telemetry_setting.enabled': values.telemetry_setting.enabled,
      'telemetry_setting.retention_days':
        values.telemetry_setting.retention_days,
      'telemetry_setting.max_body_bytes':
        values.telemetry_setting.max_body_bytes,
      'telemetry_setting.max_events_per_batch':
        values.telemetry_setting.max_events_per_batch,
      'telemetry_setting.timestamp_skew_seconds':
        values.telemetry_setting.timestamp_skew_seconds,
      'telemetry_setting.requests_per_minute':
        values.telemetry_setting.requests_per_minute,
    }
    const baseline = JSON.parse(baselineRef.current) as FlatDefaults
    const updates = (
      Object.keys(normalized) as Array<keyof FlatDefaults>
    ).filter((key) => normalized[key] !== baseline[key])
    if (updates.length === 0) {
      toast.info(t('No changes to save'))
      return
    }
    for (const key of updates) {
      await updateOption.mutateAsync({ key, value: normalized[key] })
    }
    baselineRef.current = JSON.stringify(normalized)
  }

  return (
    <SettingsSection title={t('Passive telemetry receiver')}>
      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(save)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(save)}
            isSaving={updateOption.isPending}
          />
          <FormField
            control={form.control}
            name='telemetry_setting.enabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable telemetry receiver')}</FormLabel>
                  <FormDescription>
                    {t('Accepts aggregated diagnostic data submitted by external apps with a single Bearer key. This service never sends telemetry externally.')}
                  </FormDescription>
                </SettingsSwitchContent>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </SettingsSwitchItem>
            )}
          />
          <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
            {telemetryFields.map(([key, label]) => (
              <FormField
                key={key}
                control={form.control}
                name={`telemetry_setting.${key}`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(label)}</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        disabled={!enabled}
                        {...safeNumberFieldProps(field)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
        </SettingsForm>
      </Form>

      <div className='space-y-4 border-t pt-6'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <h4 className='font-medium'>{t('Telemetry applications')}</h4>
            <p className='text-muted-foreground text-sm'>
              {t('Manage projects, applications, and write keys. Full keys are shown only once, when created.')}
            </p>
          </div>
          <Button size='sm' onClick={() => setProjectDialogOpen(true)}>
            <Plus className='mr-1.5 size-4' />
            {t('Add project')}
          </Button>
        </div>

        <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
          <div className='grid gap-2'>
            <Label>{t('Project')}</Label>
            <Select
              value={selectedProjectID ? String(selectedProjectID) : ''}
              onValueChange={(value) => {
                setSelectedProjectID(Number(value))
                setSelectedAppID(0)
              }}
              items={(projectsQuery.data?.data ?? []).map((project) => ({
                value: String(project.id),
                label: project.name,
              }))}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('Select a project')} />
              </SelectTrigger>
              <SelectContent>
                {(projectsQuery.data?.data ?? []).map((project) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='grid gap-2'>
            <Label>{t('Application')}</Label>
            <div className='flex gap-2'>
              <Select
                value={selectedAppID ? String(selectedAppID) : ''}
                onValueChange={(value) => setSelectedAppID(Number(value))}
                items={(appsQuery.data?.data ?? []).map((app) => ({
                  value: String(app.id),
                  label: app.name,
                }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select an application')} />
                </SelectTrigger>
                <SelectContent>
                  {(appsQuery.data?.data ?? []).map((app: TelemetryApp) => (
                    <SelectItem key={app.id} value={String(app.id)}>
                      {app.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type='button'
                variant='outline'
                size='icon'
                disabled={!selectedProjectID}
                onClick={() => setAppDialogOpen(true)}
                aria-label={t('Add application')}
              >
                <Plus className='size-4' />
              </Button>
            </div>
            {selectedAppID > 0 && (
              <p className='text-muted-foreground text-xs'>
                {t('App identifier:')}
                <code className='text-foreground'>
                  {
                    (appsQuery.data?.data ?? []).find(
                      (app) => app.id === selectedAppID
                    )?.slug
                  }
                </code>
              </p>
            )}
          </div>
        </div>

        {selectedAppID > 0 && (
          <>
            <div className='flex items-center justify-between'>
              <h4 className='font-medium'>{t('Write keys')}</h4>
              <Button size='sm' onClick={() => setKeyDialogOpen(true)}>
                <Plus className='mr-1.5 size-4' />
                {t('Create write key')}
              </Button>
            </div>
            <StaticDataTable
              data={keysQuery.data?.data ?? []}
              getRowKey={(key) => key.id}
              emptyContent={t('No telemetry write keys configured yet.')}
              columns={[
                { id: 'name', header: t('Name'), cell: (key) => key.name },
                {
                  id: 'key-id',
                  header: t('Key ID'),
                  cell: (key) => <code className='text-xs'>{key.key_id}</code>,
                },
                {
                  id: 'status',
                  header: t('Status'),
                  cell: (key) =>
                    key.disabled_at ? t('Disabled') : t('Enabled'),
                },
                {
                  id: 'actions',
                  header: t('Actions'),
                  className: 'text-right',
                  cellClassName: 'text-right',
                  cell: (key) =>
                    !key.disabled_at ? (
                      <Button
                        size='icon'
                        variant='ghost'
                        aria-label={t('Disable')}
                        onClick={() => setDisableTarget(key)}
                      >
                        <Trash2 className='size-4' />
                      </Button>
                    ) : null,
                },
              ]}
            />

            <div className='flex flex-wrap items-end justify-between gap-3'>
              <div className='grid w-48 gap-2'>
                <Label>{t('Time range')}</Label>
                <Select
                  value={String(hours)}
                  onValueChange={(value) => setHours(Number(value))}
                  items={[
                    { value: '24', label: t('Last 24 hours') },
                    { value: '168', label: t('Last 7 days') },
                    { value: '720', label: t('Last 30 days') },
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='24'>{t('Last 24 hours')}</SelectItem>
                    <SelectItem value='168'>{t('Last 7 days')}</SelectItem>
                    <SelectItem value='720'>{t('Last 30 days')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant='outline'
                onClick={() => cleanup.mutate()}
                disabled={cleanup.isPending}
              >
                {t('Clean up expired data')}
              </Button>
            </div>
            <TelemetryDashboard
              data={timeSeriesQuery.data?.data ?? []}
              hours={hours}
              loading={timeSeriesQuery.isLoading}
            />
            <div className='pb-8'>
              <h4 className='mb-3 font-medium'>{t('Aggregated details')}</h4>
              <StaticDataTable
                data={summaryQuery.data?.data ?? []}
                getRowKey={(row, index) =>
                  `${row.app_version}-${row.event_type}-${row.dimension}-${row.status}-${index}`
                }
                emptyContent={t('No aggregated telemetry data is available.')}
                columns={[
                  {
                    id: 'version',
                    header: t('Version'),
                    cell: (row) => row.app_version,
                  },
                  {
                    id: 'event',
                    header: t('Event type'),
                    cell: (row) => row.event_type,
                  },
                  {
                    id: 'dimension',
                    header: t('Dimension'),
                    cell: (row) => row.dimension,
                  },
                  {
                    id: 'status',
                    header: t('Status'),
                    cell: (row) => row.status,
                  },
                  {
                    id: 'events',
                    header: t('Events'),
                    className: 'text-right',
                    cellClassName: 'text-right',
                    cell: (row) => row.event_count,
                  },
                  {
                    id: 'successes',
                    header: t('Successes'),
                    className: 'text-right',
                    cellClassName: 'text-right',
                    cell: (row) => row.success_count,
                  },
                ]}
              />
            </div>
          </>
        )}
      </div>

      <NameDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        title={t('Add telemetry project')}
        onSubmit={async (name) => {
          await createTelemetryProject(name)
          await queryClient.invalidateQueries({
            queryKey: ['telemetry-projects'],
          })
          toast.success(t('Telemetry project created'))
        }}
      />
      <NameDialog
        open={appDialogOpen}
        onOpenChange={setAppDialogOpen}
        title={t('Add telemetry application')}
        onSubmit={async (name) => {
          await createTelemetryApp(selectedProjectID, name)
          await queryClient.invalidateQueries({ queryKey: ['telemetry-apps'] })
          toast.success(t('Telemetry application created'))
        }}
      />
      <NameDialog
        open={keyDialogOpen}
        onOpenChange={setKeyDialogOpen}
        title={t('Create telemetry write key')}
        onSubmit={async (name) => {
          const result = await createTelemetryWriteKey(selectedAppID, name)
          await queryClient.invalidateQueries({ queryKey: ['telemetry-keys'] })
          setCreatedToken(result.data.token)
        }}
      />
      <Dialog
        open={!!createdToken}
        onOpenChange={(open) => !open && setCreatedToken(null)}
        title={t('Telemetry write key created')}
        description={t('Copy the full key now. It cannot be viewed again after closing.')}
        footer={
          <Button onClick={() => setCreatedToken(null)}>{t('Done')}</Button>
        }
      >
        <div className='space-y-3'>
          <div className='grid gap-2'>
            <Label>{t('App Bearer key')}</Label>
            <div className='flex gap-2'>
              <Input readOnly value={createdToken ?? ''} />
              <CopyButton
                value={createdToken ?? ''}
                size='icon'
                tooltip={t('Copy')}
                aria-label={t('Copy')}
              >
                <Copy className='size-4' />
              </CopyButton>
            </div>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!disableTarget}
        onOpenChange={(open) => !open && setDisableTarget(null)}
        title={t('Disable telemetry key')}
        desc={t('This write key will stop accepting telemetry immediately.')}
        confirmText={t('Disable')}
        destructive
        handleConfirm={async () => {
          if (disableTarget) {
            await disableKey.mutateAsync(disableTarget.id)
          }
          setDisableTarget(null)
        }}
        isLoading={disableKey.isPending}
      />
    </SettingsSection>
  )
}
