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
import {
  ArrowLeft,
  CheckCircle2,
  Cloud,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { codexError } from '../api'
import { cloudApi, cloudEnvironmentQueryKey } from '../cloud-api'
import type {
  CloudEnvironment,
  CloudEnvironmentCapabilities,
  CloudEnvironmentConfig,
} from '../cloud-types'
import { Button } from '../vendor/zcode/button'
import { CloudConfigFields } from './cloud-config-fields'
import { CloudSetupSession } from './cloud-setup-session'

const metadataSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter an environment name.')
    .max(120, 'Environment names can contain up to 120 characters.'),
  description: z.string().max(2000, 'The description is too long.'),
})

export function CloudEnvironmentEditor(props: {
  actor?: string
  environment: CloudEnvironment
  capabilities?: CloudEnvironmentCapabilities
  onBack: () => void
  onStartTask: (environment: CloudEnvironment) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const prefix = useId()
  const [config, setConfig] = useState<CloudEnvironmentConfig>(
    props.environment.config
  )
  const [savedConfig, setSavedConfig] = useState(props.environment.config)
  const [validationError, setValidationError] = useState<string | null>(null)
  const form = useForm({
    resolver: zodResolver(metadataSchema),
    defaultValues: {
      name: props.environment.name,
      description: props.environment.description,
    },
  })
  const environmentQuery = useQuery({
    queryKey: [...cloudEnvironmentQueryKey(props.actor), props.environment.id],
    queryFn: ({ signal }) => cloudApi.detail(props.environment.id, signal),
    initialData: { environment: props.environment },
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.environment.status === 'preparing' ||
      query.state.data?.environment.status === 'publishing' ||
      query.state.data?.operation?.status === 'running'
        ? 1500
        : false,
  })
  const environment = environmentQuery.data.environment
  const dirty =
    form.formState.isDirty ||
    JSON.stringify(config) !== JSON.stringify(savedConfig)
  const preparing = environment.status === 'preparing'
  const publishing =
    environment.status === 'publishing' ||
    (environmentQuery.data.operation?.type === 'publish' &&
      environmentQuery.data.operation.status === 'running')
  const operationRunning = environmentQuery.data.operation?.status === 'running'
  const update = useMutation({
    mutationFn: async (input: { name: string; description: string }) =>
      cloudApi.update(environment.id, { ...input, config }),
    onSuccess: async (result) => {
      form.reset({
        name: result.environment.name,
        description: result.environment.description,
      })
      setConfig(result.environment.config)
      setSavedConfig(result.environment.config)
      client.setQueryData(
        [...cloudEnvironmentQueryKey(props.actor), environment.id],
        result
      )
      await client.invalidateQueries({
        queryKey: cloudEnvironmentQueryKey(props.actor),
      })
    },
  })
  const setup = useMutation({
    mutationFn: () => cloudApi.setup(environment.id),
    onSuccess: async (result) => {
      client.setQueryData(
        [...cloudEnvironmentQueryKey(props.actor), environment.id],
        result
      )
      await client.invalidateQueries({
        queryKey: cloudEnvironmentQueryKey(props.actor),
      })
    },
  })
  const publish = useMutation({
    mutationFn: () => cloudApi.publish(environment.id),
    onSuccess: async (result) => {
      client.setQueryData(
        [...cloudEnvironmentQueryKey(props.actor), environment.id],
        result
      )
      await client.invalidateQueries({
        queryKey: cloudEnvironmentQueryKey(props.actor),
      })
    },
  })
  const busy =
    update.isPending ||
    setup.isPending ||
    publish.isPending ||
    preparing ||
    publishing ||
    operationRunning
  const prepared = environment.preparedRevision === environment.draftRevision
  const canPublish =
    !dirty && prepared && !busy && environment.status !== 'error'
  const error =
    update.error || setup.error || publish.error || environmentQuery.error
  let saveStatus = dirty ? t('Unsaved changes') : t('All changes saved')
  if (publishing) saveStatus = t('Publishing environment...')

  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent): void =>
      event.preventDefault()
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  async function saveDraft(): Promise<boolean> {
    setValidationError(null)
    const valid = await form.trigger()
    if (!valid) return false
    const paths = config.repositories.map((repository) =>
      repository.path.trim()
    )
    if (
      config.repositories.length === 0 ||
      config.repositories.some((repository) => !repository.url.trim())
    ) {
      setValidationError('Select at least one repository.')
      return false
    }
    if (
      paths.some(
        (path) =>
          (paths.length > 1 && (!path || path === '.')) || path.startsWith('/') || path.split('/').includes('..')
      ) ||
      new Set(paths).size !== paths.length
    ) {
      setValidationError(
        'Each repository needs a unique relative checkout path.'
      )
      return false
    }
    const variables = config.environmentVariables.map(
      (variable) => variable.name
    )
    if (
      variables.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      new Set(variables).size !== variables.length
    ) {
      setValidationError('Environment variable names must be valid and unique.')
      return false
    }
    if (
      !Number.isInteger(config.advanced.setupTimeoutSeconds) ||
      config.advanced.setupTimeoutSeconds < 60 ||
      config.advanced.setupTimeoutSeconds > 1800
    ) {
      setValidationError('Setup timeout must be between 60 and 1800 seconds.')
      return false
    }
    try {
      await update.mutateAsync(form.getValues())
      return true
    } catch {
      return false
    }
  }

  async function prepareEnvironment(): Promise<void> {
    if (dirty && !(await saveDraft())) return
    setup.mutate()
  }

  return (
    <section
      aria-label={t('Cloud environment setup')}
      className='codex-environment-setup flex min-h-0 flex-col'
    >
      <header className='flex flex-wrap items-center gap-3 border-b pb-4'>
        <Button
          type='button'
          variant='ghost'
          className='size-9 rounded-full'
          aria-label={t('Back to environments')}
          onClick={props.onBack}
          disabled={busy || dirty}
        >
          <ArrowLeft className='size-4' aria-hidden />
        </Button>
        <div className='min-w-0 flex-1'>
          <h2 className='text-lg font-semibold'>
            {t('Cloud environment setup')}
          </h2>
          <p className='text-muted-foreground mt-1 truncate text-sm'>
            {environment.name}
          </p>
        </div>
        <span className='bg-muted rounded-full px-3 py-1 text-xs'>Docker</span>
      </header>
      <div className='grid min-h-0 flex-1 gap-6 pt-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]'>
        <div className='min-w-0 space-y-5'>
          <div className='rounded-2xl border p-4'>
            <div className='flex items-start gap-3'>
              <Cloud className='mt-0.5 size-5 shrink-0' aria-hidden />
              <div className='min-w-0'>
                <h3 className='font-medium'>{t('Prepare your environment')}</h3>
                <p className='text-muted-foreground mt-1 text-sm leading-6'>
                  {t(
                    'Clone your repositories and run the install script, then use the setup session to check tools and finish configuring your environment.'
                  )}
                </p>
              </div>
            </div>
            <Button
              type='button'
              variant='outline'
              className='mt-4 h-9 gap-2 rounded-full px-4 text-sm'
              onClick={() => void prepareEnvironment()}
              disabled={busy}
            >
              {preparing || setup.isPending ? (
                <LoaderCircle className='size-4 animate-spin' aria-hidden />
              ) : (
                <Play className='size-4' aria-hidden />
              )}
              {preparing || setup.isPending
                ? t('Preparing environment...')
                : t('Run setup')}
            </Button>
            <p
              role='status'
              className='text-muted-foreground mt-3 text-xs leading-5'
            >
              {prepared
                ? t('Setup completed for the current draft.')
                : t(
                    'Run setup after changing repositories or the install script.'
                  )}
            </p>
            {environment.lastError && (
              <p
                role='alert'
                className='text-destructive mt-3 text-sm break-words'
              >
                {t(environment.lastError)}
              </p>
            )}
            {environment.setupLog && (
              <details className='mt-4 text-sm' open={environment.status === 'error'}>
                <summary className='cursor-pointer rounded-lg py-1 font-medium'>{t('Setup output')}</summary>
                <pre className='bg-muted mt-2 max-h-64 overflow-auto rounded-xl p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words'>{environment.setupLog}</pre>
              </details>
            )}
          </div>
          {environment.status === 'published' &&
            !publishing &&
            environment.published && (
              <div className='rounded-2xl border border-emerald-600/20 bg-emerald-500/5 p-5'>
                <p
                  role='status'
                  className='flex items-center gap-2 text-sm font-medium'
                >
                  <CheckCircle2
                    className='size-4 text-emerald-600 dark:text-emerald-400'
                    aria-hidden
                  />
                  {t('Environment published')}
                </p>
                <p className='text-muted-foreground mt-2 text-sm leading-6'>
                  {t(
                    'New tasks use version {{version}} in an independent workspace. Existing tasks keep their current files.',
                    { version: environment.published.version }
                  )}
                </p>
                <Button
                  type='button'
                  className='mt-4 h-9 rounded-full px-4 text-sm'
                  disabled={busy || dirty}
                  onClick={() => props.onStartTask(environment)}
                >
                  {t('Start a new task')}
                </Button>
              </div>
            )}
          <CloudSetupSession
            actor={props.actor}
            workspaceId={environment.setupWorkspaceId}
            disabled={busy}
            onActivity={() => {
              void environmentQuery.refetch()
            }}
          />
        </div>
        <aside
          className='codex-environment-config min-w-0 space-y-5 rounded-2xl border p-5'
          aria-label={t('Environment configuration')}
        >
          <div>
            <label
              className='mb-2 block text-sm font-medium'
              htmlFor={`${prefix}-name`}
            >
              {t('Environment name')}
            </label>
            <input
              id={`${prefix}-name`}
              {...form.register('name')}
              disabled={busy}
              aria-invalid={!!form.formState.errors.name}
              className='focus-visible:ring-ring h-10 w-full rounded-xl border bg-transparent px-3 text-sm outline-none focus-visible:ring-2'
            />
            {form.formState.errors.name && (
              <p role='alert' className='text-destructive mt-1 text-xs'>
                {t(form.formState.errors.name.message ?? '')}
              </p>
            )}
          </div>
          <div>
            <label
              className='mb-2 block text-sm font-medium'
              htmlFor={`${prefix}-description`}
            >
              {t('Description')}
            </label>
            <textarea
              id={`${prefix}-description`}
              {...form.register('description')}
              disabled={busy}
              rows={2}
              className='focus-visible:ring-ring w-full resize-y rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2'
            />
          </div>
          <CloudConfigFields
            value={config}
            onChange={setConfig}
            disabled={busy}
            capabilities={props.capabilities}
          />
        </aside>
      </div>
      {(error || validationError) && (
        <p
          role='alert'
          className='text-destructive border-destructive/20 mt-4 rounded-xl border p-3 text-sm break-words'
        >
          {t(validationError || codexError(error))}
        </p>
      )}
      <footer className='codex-environment-footer bg-background sticky bottom-0 mt-6 flex flex-wrap items-center justify-between gap-3 border-t py-4'>
        <p role='status' className='text-muted-foreground text-xs'>
          {saveStatus}
        </p>
        <div className='flex flex-wrap gap-2'>
          {dirty && (
            <Button
              type='button'
              variant='ghost'
              className='h-9 rounded-full px-4 text-sm'
              disabled={busy}
              onClick={() => {
                form.reset({
                  name: environment.name,
                  description: environment.description,
                })
                setConfig(environment.config)
                setSavedConfig(environment.config)
                setValidationError(null)
              }}
            >
              {t('Discard changes')}
            </Button>
          )}
          <Button
            type='button'
            variant='outline'
            className='h-9 gap-2 rounded-full px-4 text-sm'
            disabled={busy || !dirty}
            onClick={() => void saveDraft()}
          >
            {update.isPending ? (
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
            ) : (
              <Save className='size-4' aria-hidden />
            )}
            {t('Save draft')}
          </Button>
          <Button
            type='button'
            className='h-9 gap-2 rounded-full px-4 text-sm'
            disabled={!canPublish}
            onClick={() => publish.mutate()}
          >
            {publish.isPending && (
              <LoaderCircle className='size-4 animate-spin' aria-hidden />
            )}
            {environment.publishedVersion !== null && (
              <RefreshCw className='size-4' aria-hidden />
            )}
            {environment.publishedVersion === null
              ? t('Publish')
              : t('Republish')}
          </Button>
        </div>
        {!canPublish && !busy && (
          <p className='text-muted-foreground basis-full text-xs'>
            {dirty
              ? t('Save your changes before publishing.')
              : t('Complete setup before publishing your environment.')}
          </p>
        )}
      </footer>
    </section>
  )
}
