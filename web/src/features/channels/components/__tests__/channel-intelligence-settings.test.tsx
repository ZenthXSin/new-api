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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { useForm } from 'react-hook-form'
import { I18nextProvider } from 'react-i18next'
import { expect, test, vi } from 'vitest'

import { Form } from '@/components/ui/form'
import { TooltipProvider } from '@/components/ui/tooltip'
import en from '@/i18n/locales/en.json'
import zh from '@/i18n/locales/zh.json'

import * as api from '../../api'
import {
  CHANNEL_FORM_DEFAULT_VALUES,
  type ChannelFormValues,
  transformFormDataToUpdatePayload,
} from '../../lib/channel-form'
import { channelSchema } from '../../types'
import { ChannelIntelligenceSettings } from '../channel-intelligence-settings'

function Editor(props: {
  saved?: boolean
  onSave?: (settings: unknown) => void
}) {
  const form = useForm<ChannelFormValues>({
    defaultValues: CHANNEL_FORM_DEFAULT_VALUES,
  })
  const channel = props.saved
    ? channelSchema.parse({
        id: 12,
        type: 1,
        key: '',
        status: 1,
        name: 'Diagnostic',
        created_time: 0,
        test_time: 0,
        response_time: 0,
        balance_updated_time: 0,
      })
    : null
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <TooltipProvider>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) =>
              props.onSave?.(
                JSON.parse(
                  transformFormDataToUpdatePayload(values, 12).settings || '{}'
                )
              )
            )}
          >
            <ChannelIntelligenceSettings channel={channel} />
            <button type='submit'>Save settings</button>
          </form>
        </Form>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

test('automatic disabling requires enabling detection and both switches save', async () => {
  const save = vi.fn()
  render(<Editor onSave={save} />)
  const enabled = screen.getByRole('switch', {
    name: 'Automatic intelligence check',
  })
  const disable = screen.getByRole('switch', {
    name: 'Automatically disable degraded channels',
  })
  expect(disable).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(enabled)
  expect(disable).not.toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(disable)
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        intelligence_check_enabled: true,
        intelligence_check_auto_disable: true,
      })
    )
  )
  fireEvent.click(enabled)
  expect(disable).toHaveAttribute('aria-disabled', 'true')
  expect(disable).not.toBeChecked()
  expect(
    screen.getByRole('button', { name: 'Run intelligence check' })
  ).toBeDisabled()
})

test('a manual detection displays its explicit verdict after the API completes', async () => {
  vi.spyOn(api, 'testChannel').mockResolvedValue({
    success: true,
    intelligence_check: {
      status: 'degraded',
      response: '降智',
      model: 'gpt-test',
      checked_at: 1,
      auto_disabled: false,
    },
  })
  render(<Editor saved />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Run intelligence check' })
  )
  await waitFor(() =>
    expect(screen.getByText('Intelligence degraded')).toBeVisible()
  )
  expect(api.testChannel).toHaveBeenCalledWith(12, {
    intelligence: true,
    model: undefined,
  })
})

test('a failed manual detection restores its button without inventing a verdict', async () => {
  vi.spyOn(api, 'testChannel').mockRejectedValue(
    new Error('Network unavailable')
  )
  render(<Editor saved />)
  fireEvent.click(
    screen.getByRole('button', { name: 'Run intelligence check' })
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Run intelligence check' })
    ).toBeEnabled()
  )
  expect(screen.queryByText('Intelligence degraded')).not.toBeInTheDocument()
})

test('Chinese channel settings show localized labels, guidance and a completed result', async () => {
  const language = createInstance()
  await language.init({
    lng: 'zhCN',
    fallbackLng: 'en',
    nsSeparator: false,
    resources: { en, zhCN: zh },
  })
  vi.spyOn(api, 'testChannel').mockResolvedValue({
    success: true,
    intelligence_check: {
      status: 'passed',
      response: '不降智',
      model: 'gpt-test',
      checked_at: 1,
      auto_disabled: false,
    },
  })
  render(
    <I18nextProvider i18n={language}>
      <Editor saved />
    </I18nextProvider>
  )
  expect(screen.getByRole('switch', { name: '自动检测降智' })).toBeVisible()
  expect(
    screen.getByRole('switch', { name: '降智时自动停用' })
  ).toHaveAttribute('aria-disabled', 'true')
  expect(
    screen.getByText(
      '按渠道检测间隔，用测试模型独立回答固定题目。结果仅反映此题的回复。'
    )
  ).toBeVisible()
  expect(
    screen.getByText(
      '仅明确回答“降智”才停用本次检测的渠道或密钥；请求失败和无法判定不会触发停用。'
    )
  ).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '立即检测降智' }))
  await waitFor(() => expect(screen.getByText('不降智')).toBeVisible())
})
