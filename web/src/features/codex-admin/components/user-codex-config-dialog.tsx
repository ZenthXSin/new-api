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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { codexError } from '@/features/codex/api'
import { CodexSelect } from '@/features/codex/components/select'
import { reasoningEfforts } from '@/features/codex/lib/reasoning-effort'
import { api } from '@/lib/api'

import type { CodexAdminUser } from '../types'

type Config = {
  userId: number
  enabled: boolean | null
  allowDocker: boolean | null
  allowSSH: boolean | null
  cpuPercent: number
  memoryMB: number
  diskMB: number
  maxProjects: number
  idleSeconds: number
  defaultModel: string
  defaultGroup: string
  defaultEffort: string
}
type Result = {
  config: Config
  effective: { enabled: boolean; allowDocker: boolean; allowSSH: boolean }
}
const defaults: Config = {
  userId: 0,
  enabled: null,
  allowDocker: null,
  allowSSH: null,
  cpuPercent: 0,
  memoryMB: 0,
  diskMB: 0,
  maxProjects: 0,
  idleSeconds: 0,
  defaultModel: '',
  defaultGroup: '',
  defaultEffort: '',
}
const numericFields = [
  { key: 'cpuPercent', label: 'CPU limit (%)', max: 100 },
  { key: 'memoryMB', label: 'Memory limit (MB)', max: 1048576 },
  { key: 'diskMB', label: 'Storage limit (MiB)', max: 10485760 },
  { key: 'maxProjects', label: 'Maximum projects', max: 1000 },
  { key: 'idleSeconds', label: 'Idle timeout (seconds)', max: 86400 },
] as const

export function UserCodexConfigDialog(props: {
  user: Pick<CodexAdminUser, 'id' | 'username'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [draft, setDraft] = useState<Config>(defaults)
  const query = useQuery({
    queryKey: ['user-codex-config', props.user.id],
    enabled: props.open,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const response = await api.get<{
        success: boolean
        data: Result
        message?: string
      }>(`/api/codex-admin/users/${props.user.id}`, { signal })
      if (!response.data.success) {
        throw new Error(
          response.data.message || t('Unable to load Codex configuration')
        )
      }
      return response.data.data
    },
  })
  useEffect(() => {
    if (query.data) setDraft(query.data.config)
  }, [query.data])
  const save = useMutation({
    mutationFn: async () => {
      const response = await api.put<{
        success: boolean
        data: Result
        message?: string
      }>(`/api/codex-admin/users/${props.user.id}`, draft)
      if (!response.data.success) {
        throw new Error(
          response.data.message || t('Unable to save Codex configuration')
        )
      }
      return response.data.data
    },
    onSuccess: (data) => {
      client.setQueryData(['user-codex-config', props.user.id], data)
      void client.invalidateQueries({ queryKey: ['codex-access'] })
      void client.invalidateQueries({ queryKey: ['codex-admin-users'] })
      toast.success(t('Codex configuration saved'))
      props.onOpenChange(false)
    },
  })
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!save.isPending) props.onOpenChange(open)
      }}
    >
      <DialogContent className='max-h-[90dvh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {t('Codex configuration')} · {props.user.username}
          </DialogTitle>
          <DialogDescription>
            {t(
              'Configure online Codex and the Docker virtual cloud environment for this user.'
            )}
          </DialogDescription>
        </DialogHeader>
        {query.isPending && <p role='status'>{t('Loading...')}</p>}
        {query.isError && (
          <div role='alert'>
            {codexError(query.error)}{' '}
            <Button onClick={() => void query.refetch()}>{t('Retry')}</Button>
          </div>
        )}
        {query.data && (
          <form
            className='space-y-5'
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate()
            }}
          >
            <div className='grid gap-4 sm:grid-cols-3'>
              {(
                [
                  { key: 'enabled', label: 'Online Codex' },
                  { key: 'allowDocker', label: 'Docker virtual cloud' },
                  { key: 'allowSSH', label: 'SSH execution' },
                ] as const
              ).map((field) => (
                <div key={field.key} className='space-y-2'>
                  <Label htmlFor={`codex-${field.key}`}>{t(field.label)}</Label>
                  <CodexSelect
                    id={`codex-${field.key}`}
                    label={t(field.label)}
                    value={
                      draft[field.key] === null
                        ? 'default'
                        : String(draft[field.key])
                    }
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        [field.key]:
                          value === 'default' ? null : value === 'true',
                      })
                    }
                    options={[
                      { value: 'default', label: t('Inherit plan or default') },
                      { value: 'true', label: t('Enabled') },
                      { value: 'false', label: t('Disabled') },
                    ]}
                  />
                </div>
              ))}
            </div>
            <p className='text-muted-foreground text-sm'>
              {t('Current access')}:{' '}
              {query.data.effective.enabled ? t('Enabled') : t('Disabled')}
            </p>
            <div className='grid gap-4 sm:grid-cols-2'>
              {numericFields.map((field) => (
                <div key={field.key} className='space-y-2'>
                  <Label htmlFor={`codex-${field.key}`}>{t(field.label)}</Label>
                  <Input
                    id={`codex-${field.key}`}
                    type='number'
                    min={0}
                    max={field.max}
                    step={field.key === 'cpuPercent' ? '0.1' : '1'}
                    value={draft[field.key]}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [field.key]: Number(event.target.value),
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Zero inherits the active Codex plan, then the server default. Resource changes apply when the environment next starts.'
              )}
            </p>
            <div className='grid gap-4 sm:grid-cols-2'>
              {(
                [
                  { key: 'defaultGroup', label: 'Default group' },
                  { key: 'defaultModel', label: 'Default model' },
                ] as const
              ).map((field) => (
                <div className='space-y-2' key={field.key}>
                  <Label htmlFor={`codex-${field.key}`}>{t(field.label)}</Label>
                  <Input
                    id={`codex-${field.key}`}
                    value={draft[field.key]}
                    maxLength={field.key === 'defaultGroup' ? 64 : 200}
                    placeholder={t('Inherit plan or default')}
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                  />
                </div>
              ))}
              <div className='space-y-2'>
                <Label htmlFor='codex-effort'>
                  {t('Default reasoning effort')}
                </Label>
                <CodexSelect
                  id='codex-effort'
                  label={t('Default reasoning effort')}
                  value={draft.defaultEffort}
                  onChange={(value) =>
                    setDraft({ ...draft, defaultEffort: value })
                  }
                  options={[
                    { value: '', label: t('Inherit plan or default') },
                    ...reasoningEfforts,
                  ]}
                />
              </div>
            </div>
            <p className='text-muted-foreground text-sm'>
              {t(
                'Defaults do not grant additional model or group permissions. Existing user billing still applies.'
              )}
            </p>
            {save.isError && (
              <p role='alert' className='text-destructive'>
                {codexError(save.error)}
              </p>
            )}
            <div className='flex flex-wrap justify-end gap-2'>
              <Button
                type='button'
                variant='outline'
                disabled={save.isPending}
                onClick={() => setDraft({ ...defaults, userId: props.user.id })}
              >
                {t('Restore defaults')}
              </Button>
              <Button
                type='button'
                variant='outline'
                disabled={save.isPending}
                onClick={() => props.onOpenChange(false)}
              >
                {t('Cancel')}
              </Button>
              <Button type='submit' disabled={save.isPending}>
                {save.isPending ? t('Saving...') : t('Save')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
