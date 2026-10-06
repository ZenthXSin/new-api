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
import { QRCodeCanvas } from 'qrcode.react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface HostedActionResultProps {
  operation: string
  data: unknown
  onClear: () => void
}

interface SensitiveField {
  id: string
  labelKey: string
  value: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 65536
}

// Read only operation-specific output fields. Authentication rotations and
// unknown controller data must never enter the result view.
function sensitiveResult(operation: string, data: unknown) {
  const fields: SensitiveField[] = []
  let qrCode: string | undefined
  const record = isRecord(data) ? data : {}

  switch (operation) {
    case 'mfa.setup':
    case 'mfa.backup_codes':
      if (operation === 'mfa.setup') {
        if (isSecret(record.secret)) {
          fields.push({
            id: 'secret',
            labelKey: 'MFA setup code',
            value: record.secret,
          })
        }
        if (
          typeof record.qr_code_data === 'string' &&
          record.qr_code_data.startsWith('otpauth://totp/') &&
          record.qr_code_data.length <= 1024
        ) {
          qrCode = record.qr_code_data
        }
      }
      if (
        Array.isArray(record.backup_codes) &&
        record.backup_codes.length > 0 &&
        record.backup_codes.length <= 100 &&
        record.backup_codes.every(
          (value) => isSecret(value) && value.length <= 256
        )
      ) {
        fields.push({
          id: 'backup-codes',
          labelKey: 'Backup codes',
          value: record.backup_codes.join('\n'),
        })
      }
      break
    case 'apikey.reveal':
    case 'channel.key.reveal':
      if (isSecret(record.key)) {
        fields.push({ id: 'key', labelKey: 'API key', value: record.key })
      }
      break
    case 'channel.config.reveal': {
      const configuration: Record<string, string | number | null> = {}
      if (typeof record.id === 'number' && Number.isSafeInteger(record.id)) {
        configuration.id = record.id
      }
      for (const name of [
        'name',
        'header_override',
        'param_override',
        'setting',
        'settings',
        'other',
        'other_info',
        'base_url',
      ]) {
        if (
          Object.hasOwn(record, name) &&
          (typeof record[name] === 'string' || record[name] === null)
        ) {
          configuration[name] = record[name]
        }
      }
      if (Object.keys(configuration).length > 0) {
        fields.push({
          id: 'channel-configuration',
          labelKey: 'Channel configuration',
          value: JSON.stringify(configuration, null, 2),
        })
      }
      break
    }
    case 'apikey.reveal_batch':
      if (isRecord(record.keys) && Object.keys(record.keys).length <= 100) {
        for (const [id, key] of Object.entries(record.keys)) {
          if (/^[1-9]\d*$/.test(id) && isSecret(key)) {
            fields.push({ id, labelKey: 'API key', value: key })
          }
        }
      }
      break
    case 'credential.legacy_generate':
      if (isSecret(data)) {
        fields.push({
          id: 'legacy',
          labelKey: 'Personal access token',
          value: data,
        })
      }
      break
    case 'oauth_client.create':
    case 'oauth_client.reset_secret':
      if (isSecret(record.client_secret)) {
        fields.push({
          id: 'client-secret',
          labelKey: 'Client secret',
          value: record.client_secret,
        })
      }
      break
    case 'app_payment.configure':
    case 'app_payment.rotate_secret':
      if (isSecret(record.webhook_secret)) {
        fields.push({
          id: 'notification-secret',
          labelKey: 'Notification secret',
          value: record.webhook_secret,
        })
      }
      break
    case 'app.create':
    case 'app.telemetry.reveal':
    case 'app.telemetry.rotate':
      if (isSecret(record.token)) {
        fields.push({
          id: 'telemetry',
          labelKey: 'Telemetry key',
          value: record.token,
        })
      }
      break
  }

  return { fields, qrCode }
}

export function HostedActionResult(props: HostedActionResultProps) {
  const { t } = useTranslation()
  const resultId = useId()
  const [revealed, setRevealed] = useState<{
    operation: string
    data: unknown
  } | null>(null)
  const visible =
    revealed !== null &&
    revealed.operation === props.operation &&
    revealed.data === props.data
  const result = sensitiveResult(props.operation, props.data)

  useEffect(() => {
    setRevealed(null)
  }, [props.operation, props.data])

  if (result.fields.length === 0 && !result.qrCode) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Sensitive result')}</CardTitle>
        <CardDescription>
          {t(
            'Keep these credentials private. Clear them when you are finished.'
          )}
        </CardDescription>
      </CardHeader>
      {visible && (
        <CardContent id={resultId} className='flex min-w-0 flex-col gap-4'>
          {result.qrCode && (
            <QRCodeCanvas
              value={result.qrCode}
              size={192}
              marginSize={4}
              role='img'
              aria-label={t('Scan QR Code')}
              className='max-w-full self-center'
            />
          )}
          {result.fields.map((field) => {
            const label =
              props.operation === 'apikey.reveal_batch'
                ? `${t(field.labelKey)} #${field.id}`
                : t(field.labelKey)
            return (
              <div key={field.id} className='flex min-w-0 flex-col gap-2'>
                <Label htmlFor={`${resultId}-${field.id}`}>{label}</Label>
                <Textarea
                  id={`${resultId}-${field.id}`}
                  value={field.value}
                  readOnly
                  autoComplete='off'
                  spellCheck={false}
                  className='select-text'
                />
              </div>
            )
          })}
        </CardContent>
      )}
      <CardFooter className='flex flex-wrap gap-2'>
        <Button
          type='button'
          variant='outline'
          aria-expanded={visible}
          aria-controls={visible ? resultId : undefined}
          onClick={() =>
            setRevealed(
              visible ? null : { operation: props.operation, data: props.data }
            )
          }
        >
          {visible ? t('Hide sensitive result') : t('Show sensitive result')}
        </Button>
        <Button
          type='button'
          variant='outline'
          onClick={() => {
            setRevealed(null)
            props.onClear()
          }}
        >
          {t('Clear sensitive result')}
        </Button>
      </CardFooter>
    </Card>
  )
}
