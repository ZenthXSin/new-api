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
import { LoaderCircle } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { codexApi, codexError } from '../api'

export function EnvironmentPorts(props: { actor: string; running: boolean }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const portId = useId()
  const labelId = useId()
  const [port, setPort] = useState('')
  const [label, setLabel] = useState('')
  const queryKey = ['codex', props.actor, 'ports']
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => codexApi.ports(signal),
    refetchInterval: 5000,
    retry: false,
  })
  const change = useMutation({
    mutationFn: async (
      input:
        | { type: 'open'; localPort: number; label: string }
        | { type: 'close'; id: string }
    ) => {
      if (input.type === 'open') {
        await codexApi.openPort({
          localPort: input.localPort,
          label: input.label,
        })
      } else {
        await codexApi.closePort(input.id)
      }
    },
    onSuccess: (_, input) => {
      if (input.type === 'open') {
        setPort('')
        setLabel('')
      }
      void client.invalidateQueries({ queryKey })
    },
  })
  const data = query.data
  const number = Number(port)
  const canOpen =
    data?.available &&
    props.running &&
    data.used < data.limit &&
    Number.isInteger(number) &&
    number > 0 &&
    number <= 65535 &&
    !change.isPending
  let error: string | undefined
  if (change.isError) error = codexError(change.error)
  else if (query.isError) error = codexError(query.error)
  return (
    <section
      className='min-w-0 space-y-3 rounded-xl border p-3'
      aria-label={t('Public ports')}
    >
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-sm font-medium'>{t('Public ports')}</h3>
        <span className='text-muted-foreground text-xs tabular-nums'>
          {t('{{used}} / {{limit}} ports', {
            used: data?.used ?? 0,
            limit: data?.limit ?? 10,
          })}
        </span>
      </div>
      {query.isPending && (
        <LoaderCircle
          className='size-4 animate-spin motion-reduce:animate-none'
          aria-label={t('Loading')}
        />
      )}
      {error && (
        <p role='alert' className='text-destructive text-sm'>
          {t(error)}
        </p>
      )}
      {data?.available === false && (
        <p className='text-muted-foreground text-xs'>
          {t('FRP port forwarding is unavailable.')}
        </p>
      )}
      {data?.available && (
        <>
          <form
            className='flex flex-wrap items-end gap-2'
            onSubmit={(event) => {
              event.preventDefault()
              if (canOpen) {
                change.mutate({
                  type: 'open',
                  localPort: number,
                  label: label.trim(),
                })
              }
            }}
          >
            <div className='w-28 space-y-1'>
              <Label htmlFor={portId}>{t('Container port')}</Label>
              <Input
                id={portId}
                type='number'
                inputMode='numeric'
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                disabled={!props.running || change.isPending}
              />
            </div>
            <div className='min-w-32 flex-1 space-y-1'>
              <Label htmlFor={labelId}>{t('Port label (optional)')}</Label>
              <Input
                id={labelId}
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
                disabled={!props.running || change.isPending}
              />
            </div>
            <Button type='submit' size='sm' disabled={!canOpen}>
              {change.isPending && change.variables.type === 'open' && (
                <LoaderCircle
                  className='size-3.5 animate-spin motion-reduce:animate-none'
                  aria-hidden
                />
              )}
              {t('Open port')}
            </Button>
          </form>
          {!props.running && (
            <p className='text-muted-foreground text-xs'>
              {t('Start your Docker environment before opening ports.')}
            </p>
          )}
          {!data.ports.length && (
            <p className='text-muted-foreground text-xs'>
              {t('No public ports are configured.')}
            </p>
          )}
          <ul className='space-y-1'>
            {data.ports.map((entry) => (
              <li
                key={entry.id}
                className='flex min-w-0 items-center gap-2 rounded-lg py-1 text-xs'
              >
                <div className='min-w-0 flex-1'>
                  <p className='font-mono break-all'>
                    {entry.localPort} → {entry.address}
                  </p>
                  <p className='text-muted-foreground truncate'>
                    {entry.label}
                    {entry.label && ' · '}
                    {t(entry.status === 'running' ? 'Running' : 'Stopped')}
                  </p>
                </div>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  disabled={change.isPending}
                  onClick={() => change.mutate({ type: 'close', id: entry.id })}
                  aria-label={t('Close port {{port}}', {
                    port: entry.remotePort,
                  })}
                >
                  {t('Close port')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
