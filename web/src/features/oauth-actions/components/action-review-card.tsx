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
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { toIntlLocale } from '@/i18n/languages'

import type { HostedActionApproval } from '../types'

export function ActionReviewCard(props: {
  action: HostedActionApproval
  username?: string
  statusText: string
}) {
  const { t, i18n } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Review the requested action')}</CardTitle>
        <CardDescription>
          {t(
            'Complete this action on this site. Your password and verification codes are not sent to the app.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        <dl className='grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]'>
          <dt className='text-muted-foreground'>{t('Application')}</dt>
          <dd className='min-w-0 font-medium break-all'>
            {props.action.client_name}
          </dd>
          <dt className='text-muted-foreground'>{t('Account')}</dt>
          <dd className='min-w-0 break-all'>{props.username}</dd>
          <dt className='text-muted-foreground'>{t('Requested action')}</dt>
          <dd className='min-w-0 break-words'>
            {t(props.action.label || props.action.operation)}
          </dd>
          <dt className='text-muted-foreground'>{t('Status')}</dt>
          <dd>
            <Badge variant='secondary'>{props.statusText}</Badge>
          </dd>
          <dt className='text-muted-foreground'>{t('Expires at')}</dt>
          <dd>
            <time
              dateTime={new Date(props.action.expires_at * 1000).toISOString()}
            >
              {new Date(props.action.expires_at * 1000).toLocaleString(
                toIntlLocale(i18n.language)
              )}
            </time>
          </dd>
        </dl>
        {Object.keys(props.action.parameters).length > 0 && (
          <div className='flex flex-col gap-2'>
            <h3 className='font-medium'>{t('Request details')}</h3>
            <dl className='grid min-w-0 gap-2'>
              {Object.entries(props.action.parameters).map(([name, value]) => (
                <div key={name} className='min-w-0 rounded-md border p-3'>
                  <dt className='text-muted-foreground text-xs break-all'>
                    {name}
                  </dt>
                  <dd className='mt-1 max-h-48 overflow-auto text-sm break-all whitespace-pre-wrap'>
                    {typeof value === 'string'
                      ? value
                      : JSON.stringify(value, null, 2)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {props.action.share_result && props.action.result_kind !== 'data' && (
          <Alert variant='destructive'>
            <AlertTitle>
              {t('This app will receive the full credential')}
            </AlertTitle>
            <AlertDescription>
              {t(
                'Only approve if you trust this app. Revoking OAuth access will not remove credential copies already received by the app.'
              )}
            </AlertDescription>
          </Alert>
        )}
        {props.action.share_result && props.action.result_kind === 'data' && (
          <Alert>
            <AlertTitle>
              {t('This app will receive the operation result.')}
            </AlertTitle>
            <AlertDescription>
              {t(
                'Approve to share the requested result so the app can continue.'
              )}
            </AlertDescription>
          </Alert>
        )}
        {!props.action.share_result && (
          <p className='text-muted-foreground text-sm'>
            {t(
              'The app receives the completion status. Credentials are only shown on this site.'
            )}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
