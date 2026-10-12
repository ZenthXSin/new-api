import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import type { ExecutionTarget } from '../cloud-types'
import { ExecutionTargetPicker } from '../components/execution-target-picker'
import { cloudConfig, cloudEnvironment } from './cloud-environment-fixtures'

let client: QueryClient
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})
afterEach(() => {
  client.clear()
  vi.restoreAllMocks()
})

function renderPicker(
  value: ExecutionTarget = { type: 'cloud' },
  disabled = false,
  allowHost = false
) {
  const onChange = vi.fn()
  const onCreateEnvironment = vi.fn()
  const onManageEnvironments = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <ExecutionTargetPicker
        actor='user-1'
        value={value}
        disabled={disabled}
        allowHost={allowHost}
        onChange={onChange}
        onCreateEnvironment={onCreateEnvironment}
        onManageEnvironments={onManageEnvironments}
      />
    </QueryClientProvider>
  )
  return { onChange, onCreateEnvironment, onManageEnvironments }
}

describe('Execution target picker', () => {
  test('only published versions can be selected for a cloud task while drafts remain in management', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: {
          environments: [
            cloudEnvironment,
            {
              ...cloudEnvironment,
              id: 'published',
              name: 'Ready portal',
              status: 'published',
              publishedVersion: 2,
              published: {
                version: 2,
                createdAt: 3,
                snapshot: { bytes: 20, files: 2 },
                config: cloudConfig,
              },
            },
          ],
        },
      },
    })
    const { onChange } = renderPicker()
    await userEvent.click(
      screen.getByRole('button', { name: 'Select environment' })
    )
    const ready = await screen.findByRole('menuitem', {
      name: /Ready portal\s*Version 2/,
    })
    expect(
      screen.queryByRole('menuitem', { name: /Developer portal/ })
    ).not.toBeInTheDocument()
    await userEvent.click(ready)
    expect(onChange).toHaveBeenCalledWith({
      type: 'cloud',
      environmentId: 'published',
    })
  })

  test('Docker and SSH remain distinct execution locations accessible by keyboard', async () => {
    const { onChange } = renderPicker({ type: 'docker' })
    const trigger = screen.getByRole('button', { name: 'Work in' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(
      await screen.findByRole('menuitem', {
        name: /Docker\s*Your personal Docker environment/,
      })
    ).toBeVisible()
    await userEvent.click(
      screen.getByRole('menuitem', { name: /SSH\s*A connected remote server/ })
    )
    expect(onChange).toHaveBeenCalledWith({ type: 'ssh' })
    expect(
      screen.queryByRole('button', { name: 'Select environment' })
    ).not.toBeInTheDocument()
  })

  test('an empty cloud environment menu provides real creation and management actions', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: { environments: [] } },
    })
    const { onCreateEnvironment, onManageEnvironments } = renderPicker()
    await userEvent.click(
      screen.getByRole('button', { name: 'Select environment' })
    )
    expect(
      await screen.findByText('Publish an environment to start a cloud task.')
    ).toBeVisible()
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Create environment' })
    )
    expect(onCreateEnvironment).toHaveBeenCalledOnce()
    await userEvent.click(
      screen.getByRole('button', { name: 'Select environment' })
    )
    await userEvent.click(
      screen.getByRole('menuitem', { name: 'Manage environments' })
    )
    expect(onManageEnvironments).toHaveBeenCalledOnce()
  })

  test('a failed environment request offers retry and never pretends an environment was selected', async () => {
    vi.spyOn(api, 'get')
      .mockRejectedValueOnce(new Error('Environment service unavailable'))
      .mockResolvedValue({
        data: { success: true, data: { environments: [] } },
      })
    renderPicker()
    await userEvent.click(
      screen.getByRole('button', { name: 'Select environment' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Environment service unavailable'
    )
    await userEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Select environment' })
    )
    expect(
      await screen.findByText('Publish an environment to start a cloud task.')
    ).toBeVisible()
  })

  test('a disabled composer prevents switching execution targets and choosing environments', () => {
    renderPicker({ type: 'cloud' }, true)
    expect(screen.getByRole('button', { name: 'Work in' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Select environment' })
    ).toBeDisabled()
  })
})

test('the host execution target is offered only with administrator access', async () => {
  const view = renderPicker({ type: 'docker' }, false, true)
  await userEvent.click(screen.getByRole('button', { name: 'Work in' }))
  await userEvent.click(
    await screen.findByRole('menuitem', { name: /Host\s*Run directly/ })
  )
  expect(view.onChange).toHaveBeenCalledWith({ type: 'host' })
})

test('ordinary users cannot choose the host execution target', async () => {
  renderPicker({ type: 'docker' })
  await userEvent.click(screen.getByRole('button', { name: 'Work in' }))
  expect(
    screen.queryByRole('menuitem', { name: /Host\s*Run directly/ })
  ).not.toBeInTheDocument()
})
