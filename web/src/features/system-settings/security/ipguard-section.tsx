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
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as z from 'zod'

import { JsonCodeEditor } from '@/components/json-code-editor'
import { Badge } from '@/components/ui/badge'
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
import { Switch } from '@/components/ui/switch'

import { getIPGuardStatus, scanIPGuardNow, unbanIPGuardIP } from '../api'
import {
  SettingsForm,
  SettingsSwitchContent,
  SettingsSwitchItem,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdateOption } from '../hooks/use-update-option'
import {
  isValidBanDurationsJSON,
  isValidHeuristicsJSON,
  isValidStringArrayJSON,
} from './ipguard-validation'

const createIPGuardSchema = (t: (key: string) => string) =>
  z.object({
    IPGuardEnabled: z.boolean(),
    IPGuardLogDir: z.string().min(1),
    IPGuardIntervalSeconds: z.number().min(60),
    IPGuardScanWindowSeconds: z.number().min(60),
    IPGuardWhitelist: z.string().refine(isValidStringArrayJSON, {
      message: t('Whitelist must be a JSON array of IP strings'),
    }),
    IPGuardDryRun: z.boolean(),
    IPGuardEnforceReal: z.boolean(),
    IPGuardEnforceCommand: z.string().min(1),
    IPGuardBanDurations: z.string().refine(isValidBanDurationsJSON, {
      message: t(
        'Ban durations must be a JSON object with positive suspect/malicious/critical seconds'
      ),
    }),
    IPGuardHeuristics: z.string().refine(isValidHeuristicsJSON, {
      message: t('Heuristics must be a JSON object'),
    }),
    IPGuardLLMModel: z.string().optional(),
    IPGuardLLMToken: z.string().optional(),
    IPGuardLLMBaseURL: z.string().optional(),
    IPGuardLLMBatchSize: z.number().min(1),
    IPGuardLLMMaxCallsPerRun: z.number().min(1),
    IPGuardLLMMaxCallsPerDay: z.number().min(1),
    IPGuardLLMMaxTokens: z.number().min(1),
    IPGuardLLMCorroborationRate: z.number().min(0),
  })

type IPGuardFormValues = z.infer<ReturnType<typeof createIPGuardSchema>>

type IPGuardSectionProps = {
  defaultValues: IPGuardFormValues
}

const JSON_PLACEHOLDERS = {
  whitelist: '["127.0.0.1"]',
  banDurations: '{"suspect": 900, "malicious": 21600, "critical": 86400}',
  heuristics: '{"ssh_fail_threshold": 5}',
}

function formatTime(ts?: number) {
  if (!ts) return '-'
  return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss')
}

export function IPGuardSection({ defaultValues }: IPGuardSectionProps) {
  const { t } = useTranslation()
  const updateOption = useUpdateOption()
  const queryClient = useQueryClient()
  const [lastScanKey, setLastScanKey] = useState(0)

  const ipguardSchema = createIPGuardSchema(t)
  const form = useForm<IPGuardFormValues>({
    resolver: zodResolver(ipguardSchema),
    mode: 'onChange',
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
  }, [defaultValues, form])

  const statusQuery = useQuery({
    queryKey: ['ipguard-status'],
    queryFn: getIPGuardStatus,
    refetchInterval: 30_000,
  })
  const status = statusQuery.data?.data

  const unbanMutation = useMutation({
    mutationFn: (ip: string) => unbanIPGuardIP(ip),
    onSuccess: (data) => {
      if (data.success) {
        toast.success(t('Ban lifted'))
        queryClient.invalidateQueries({ queryKey: ['ipguard-status'] })
      } else {
        toast.error(data.message || t('Failed to lift ban'))
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || t('Failed to lift ban'))
    },
  })

  const scanMutation = useMutation({
    mutationFn: () => scanIPGuardNow(),
    onSuccess: (data) => {
      if (data.success) {
        toast.success(t('Scan started'))
        setLastScanKey((k) => k + 1)
      } else {
        toast.error(data.message || t('Failed to start scan'))
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || t('Failed to start scan'))
    },
  })

  // Refresh status after a scan finishes (30s poll already covers it, this
  // is a fast path for the manual trigger).
  useEffect(() => {
    if (lastScanKey > 0) {
      const timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['ipguard-status'] })
      }, 5000)
      return () => clearTimeout(timer)
    }
  }, [lastScanKey, queryClient])

  const onSubmit = async (values: IPGuardFormValues) => {
    const updates = Object.entries(values).filter(
      ([key, value]) => value !== defaultValues[key as keyof IPGuardFormValues]
    )
    for (const [key, value] of updates) {
      await updateOption.mutateAsync({
        key,
        value: value === null || value === undefined ? '' : value,
      })
    }
  }

  const stats = status?.last_scan?.stats as Record<string, number> | undefined

  return (
    <SettingsSection title={t('IP Attack Guard')}>
      <div className='rounded-lg border p-4'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div className='flex flex-wrap items-center gap-2'>
            <Badge variant={status?.enabled ? 'default' : 'secondary'}>
              {status?.enabled ? t('Enabled') : t('Disabled')}
            </Badge>
            <Badge variant={status?.dry_run ? 'warning' : 'default'}>
              {status?.dry_run ? t('Dry run') : t('Real enforcement')}
            </Badge>
            <Badge variant={status?.llm_configured ? 'default' : 'secondary'}>
              {status?.llm_configured
                ? t('LLM configured')
                : t('LLM not configured')}
            </Badge>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending || !status?.enabled}
            >
              {t('Scan now')}
            </Button>
          </div>
        </div>

        {status?.last_scan ? (
          <div className='text-muted-foreground mt-3 grid gap-1 text-sm'>
            <div>
              {t('Last scan')}: {formatTime(status.last_scan.scan_ts)}
            </div>
            <div>
              {t('Events')}: {stats?.total_events ?? 0} / {t('Profiles')}:{' '}
              {stats?.profiles_count ?? 0} / {t('Clear-cut')}:{' '}
              {stats?.clear_cut_count ?? 0} / {t('LLM calls')}:{' '}
              {stats?.llm_calls ?? 0} / {t('Actions')}: {stats?.actions ?? 0}
            </div>
          </div>
        ) : (
          <div className='text-muted-foreground mt-3 text-sm'>
            {t('No scan has run yet')}
          </div>
        )}

        {(status?.active_bans?.length ?? 0) > 0 && (
          <div className='mt-4'>
            <div className='mb-2 text-sm font-medium'>
              {t('Active bans')} ({status?.active_bans.length})
            </div>
            <div className='divide-y rounded-md border'>
              {status?.active_bans.map((ban) => (
                <div
                  key={ban.ip}
                  className='flex items-center justify-between gap-2 px-3 py-2 text-sm'
                >
                  <div className='min-w-0'>
                    <span className='font-mono'>{ban.ip}</span>
                    <span className='text-muted-foreground ml-2'>
                      {ban.reason} · {t('until')}{' '}
                      {formatTime(ban.ts + ban.duration)}
                    </span>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={unbanMutation.isPending}
                    onClick={() => unbanMutation.mutate(ban.ip)}
                  >
                    {t('Unban')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {(status?.recent_bans?.length ?? 0) > 0 && (
          <div className='mt-4'>
            <div className='mb-2 text-sm font-medium'>{t('Recent bans')}</div>
            <div className='max-h-48 overflow-auto rounded-md border'>
              <table className='w-full text-sm'>
                <thead className='bg-muted/50'>
                  <tr>
                    <th className='px-3 py-1.5 text-left font-medium'>
                      {t('IP')}
                    </th>
                    <th className='px-3 py-1.5 text-left font-medium'>
                      {t('Action')}
                    </th>
                    <th className='px-3 py-1.5 text-left font-medium'>
                      {t('Reason')}
                    </th>
                    <th className='px-3 py-1.5 text-left font-medium'>
                      {t('Time')}
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y'>
                  {status?.recent_bans.slice(0, 20).map((ban, idx) => (
                    <tr key={`${ban.ip}-${ban.ts}-${idx}`}>
                      <td className='px-3 py-1.5 font-mono'>{ban.ip}</td>
                      <td className='px-3 py-1.5'>{ban.action}</td>
                      <td className='px-3 py-1.5'>{ban.reason}</td>
                      <td className='px-3 py-1.5'>{formatTime(ban.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Form {...form}>
        <SettingsForm onSubmit={form.handleSubmit(onSubmit)}>
          <SettingsPageFormActions
            onSave={form.handleSubmit(onSubmit)}
            isSaving={updateOption.isPending}
            saveLabel='Save IP attack guard settings'
          />

          <FormField
            control={form.control}
            name='IPGuardEnabled'
            render={({ field }) => (
              <SettingsSwitchItem>
                <SettingsSwitchContent>
                  <FormLabel>{t('Enable IP attack guard')}</FormLabel>
                  <FormDescription>
                    {t(
                      'Hourly LLM-assisted scan of nginx/sshd logs with automatic IP bans. With Dry run enabled nothing is enforced.'
                    )}
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

          <div className='grid gap-4 md:grid-cols-2'>
            <FormField
              control={form.control}
              name='IPGuardLogDir'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Log directory')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder='/var/log'
                      aria-invalid={Boolean(
                        form.formState.errors.IPGuardLogDir
                      )}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Directory scanned for access.log*, access*.log, auth.log* and secure* files'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardIntervalSeconds'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Scan interval (seconds)')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={60}
                      step={60}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 0)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('Seconds between scans')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardScanWindowSeconds'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Scan window (seconds)')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={60}
                      step={60}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 0)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('Look-back window for feature aggregation')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardEnforceCommand'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Enforce command')}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder='iptables'
                      aria-invalid={Boolean(
                        form.formState.errors.IPGuardEnforceCommand
                      )}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Command used for real bans, e.g. "ssh root@host iptables" to enforce on the host'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className='grid gap-4 md:grid-cols-2'>
            <FormField
              control={form.control}
              name='IPGuardDryRun'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{t('Dry run')}</FormLabel>
                    <FormDescription>
                      {t(
                        'Simulate enforcement: record decisions but never touch the firewall'
                      )}
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

            <FormField
              control={form.control}
              name='IPGuardEnforceReal'
              render={({ field }) => (
                <SettingsSwitchItem>
                  <SettingsSwitchContent>
                    <FormLabel>{t('Allow real enforcement')}</FormLabel>
                    <FormDescription>
                      {t(
                        'Enable real iptables enforcement. Requires root (or a custom enforce command) and Dry run disabled.'
                      )}
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
          </div>

          <FormField
            control={form.control}
            name='IPGuardWhitelist'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Whitelist')}</FormLabel>
                <FormControl>
                  <JsonCodeEditor
                    value={field.value || ''}
                    onChange={field.onChange}
                    name={field.name}
                    onBlur={field.onBlur}
                    textareaRef={field.ref}
                    placeholder={JSON_PLACEHOLDERS.whitelist}
                    aria-invalid={Boolean(
                      form.formState.errors.IPGuardWhitelist
                    )}
                  />
                </FormControl>
                <FormDescription>
                  {t('IPs that are never banned (JSON array of strings)')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='IPGuardBanDurations'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Ban durations (seconds)')}</FormLabel>
                <FormControl>
                  <JsonCodeEditor
                    value={field.value || ''}
                    onChange={field.onChange}
                    name={field.name}
                    onBlur={field.onBlur}
                    textareaRef={field.ref}
                    placeholder={JSON_PLACEHOLDERS.banDurations}
                    aria-invalid={Boolean(
                      form.formState.errors.IPGuardBanDurations
                    )}
                  />
                </FormControl>
                <FormDescription>
                  {t('Per-verdict ban lengths: suspect / malicious / critical')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name='IPGuardHeuristics'
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('Heuristic thresholds')}</FormLabel>
                <FormControl>
                  <JsonCodeEditor
                    value={field.value || ''}
                    onChange={field.onChange}
                    name={field.name}
                    onBlur={field.onBlur}
                    textareaRef={field.ref}
                    placeholder={JSON_PLACEHOLDERS.heuristics}
                    aria-invalid={Boolean(
                      form.formState.errors.IPGuardHeuristics
                    )}
                  />
                </FormControl>
                <FormDescription>
                  {t(
                    'Optional overrides: ssh_fail_threshold, sql_threshold, xss_threshold, traversal_threshold, bot_flood_threshold, web_fail_threshold, ddos_rate_threshold, ddos_total_threshold, llm_total_threshold, llm_failed_min, port_scan_threshold'
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className='grid gap-4 md:grid-cols-2'>
            <FormField
              control={form.control}
              name='IPGuardLLMModel'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('LLM model')}</FormLabel>
                  <FormControl>
                    <Input placeholder='deepseek-v4-flash' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Model used for verdicts, routed through this gateway itself'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMToken'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('LLM token')}</FormLabel>
                  <FormControl>
                    <Input
                      type='password'
                      autoComplete='new-password'
                      placeholder='sk-...'
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Gateway API token allowed to call the model; leave empty to skip LLM review (heuristic bans still apply)'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMBaseURL'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('LLM base URL')}</FormLabel>
                  <FormControl>
                    <Input placeholder='http://127.0.0.1:3000' {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('Gateway base URL; defaults to this instance itself')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMBatchSize'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('LLM batch size')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={1}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 1)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMMaxCallsPerRun'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Max LLM calls per scan')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={1}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 1)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMMaxCallsPerDay'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('Max LLM calls per day')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={1}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 1)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMMaxTokens'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('LLM max tokens')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={1}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 1)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name='IPGuardLLMCorroborationRate'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('LLM corroboration rate')}</FormLabel>
                  <FormControl>
                    <Input
                      type='number'
                      min={0}
                      step={0.5}
                      onChange={(e) =>
                        field.onChange(parseFloat(e.target.value) || 0)
                      }
                      value={field.value}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'Requests per minute that independently corroborate an LLM verdict'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </SettingsForm>
      </Form>
    </SettingsSection>
  )
}
