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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { expect, test, vi } from 'vitest'

import zh from '@/i18n/locales/zh.json'

import { CodexComposer } from '../components/composer'
import { status } from './fixtures'

const props = {
  status,
  model: 'codex-test',
  effort: 'high',
  mode: 'code' as const,
  onModel: vi.fn(),
  onEffort: vi.fn(),
  onMode: vi.fn(),
}

test('引导当前任务发送绑定的任务 ID，并在接收后清空草稿', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh',
    fallbackLng: false,
    resources: { zh: { translation: zh.translation } },
  })
  const submit = vi.fn().mockResolvedValue(undefined)
  const stop = vi.fn()
  const parallel = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <CodexComposer
        {...props}
        running
        activeTurnId='turn-current'
        onSubmit={submit}
        onStop={stop}
        onParallel={parallel}
      />
    </I18nextProvider>
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '优先修复登录问题' },
  })
  fireEvent.click(screen.getByRole('button', { name: '引导当前任务' }))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '优先修复登录问题',
        busyAction: 'steer',
        expectedTurnId: 'turn-current',
      })
    )
  )
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
  expect(stop).not.toHaveBeenCalled()
  expect(parallel).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '停止任务' })).toBeEnabled()
  expect(i18n.t('Steer current task')).toBe('引导当前任务')
})

test('引导发送失败保留草稿和请求 ID，当前任务变化后使用新的请求 ID', async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new Error('连接失败'))
    .mockRejectedValueOnce(new Error('连接失败'))
    .mockResolvedValue(undefined)
  const { rerender } = render(
    <CodexComposer
      {...props}
      running
      activeTurnId='turn-first'
      onSubmit={submit}
    />
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '继续补充要求' },
  })
  fireEvent.click(screen.getByRole('button', { name: '引导当前任务' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('textbox')).toHaveValue('继续补充要求')
  fireEvent.click(screen.getByRole('button', { name: '引导当前任务' }))
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '引导当前任务' })).toBeEnabled()
  )
  expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0])
  rerender(
    <CodexComposer
      {...props}
      running
      activeTurnId='turn-second'
      onSubmit={submit}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '引导当前任务' }))
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(3))
  expect(submit.mock.calls[2][0].requestId).not.toBe(
    submit.mock.calls[0][0].requestId
  )
  expect(submit.mock.calls[2][0].expectedTurnId).toBe('turn-second')
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
})

test('任务尚未开始、收尾或停止时不能发送引导消息', async () => {
  const submit = vi.fn()
  const { rerender } = render(
    <CodexComposer {...props} busy onSubmit={submit} />
  )
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: '保留我的草稿' },
  })
  expect(
    screen.queryByRole('button', { name: '引导当前任务' })
  ).not.toBeInTheDocument()
  rerender(
    <CodexComposer
      {...props}
      running
      activeTurnId='turn-current'
      finishing
      onSubmit={submit}
    />
  )
  expect(screen.getByRole('button', { name: '引导当前任务' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '引导当前任务' }))
  expect(submit).not.toHaveBeenCalled()
  rerender(<CodexComposer {...props} onSubmit={submit} />)
  expect(
    screen.queryByRole('button', { name: '引导当前任务' })
  ).not.toBeInTheDocument()
  expect(screen.getByRole('textbox')).toHaveValue('保留我的草稿')
})
