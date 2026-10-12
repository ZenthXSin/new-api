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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { expect, test, vi } from 'vitest'

import { Form } from '@/components/ui/form'
import { defaultCodexPlan, codexPlanSchema } from '@/features/codex-admin/types'

import { CodexPlanFields } from '../components/codex-plan-fields'
import {
  PLAN_FORM_DEFAULTS,
  planToFormValues,
  formValuesToPlanPayload,
  type PlanFormValues,
} from '../lib/plan-form'
import type { SubscriptionPlan } from '../types'

const legacy = { id: 1, title: 'Legacy', price_amount: 5 } as SubscriptionPlan

test('legacy plans have no Codex grant and disabled settings survive the plan round trip', () => {
  const values = planToFormValues(legacy)
  expect(values.codex.enabled).toBe(false)
  const codex = {
    ...defaultCodexPlan,
    enabled: false,
    allowDocker: false,
    memoryMB: 0,
    defaultEffort: 'ultra' as const,
  }
  const payload = formValuesToPlanPayload({ ...values, codex })
  expect(payload.plan.codex).toEqual(codex)
  expect(planToFormValues({ ...legacy, codex }).codex).toEqual(codex)
})

test('invalid Codex resource settings are rejected before saving a plan', () => {
  for (const config of [
    { memoryMB: 1 },
    { diskMB: 255 },
    { idleSeconds: 1 },
    { maxProjects: -1 },
    { cpuPercent: 101 },
  ]) {
    expect(
      codexPlanSchema.safeParse({ ...defaultCodexPlan, ...config }).success
    ).toBe(false)
  }
  expect(
    codexPlanSchema.safeParse({
      ...defaultCodexPlan,
      enabled: true,
      memoryMB: 256,
      idleSeconds: 60,
      defaultEffort: 'ultra',
    }).success
  ).toBe(true)
})

test('enabling Codex reveals resource controls and submits the selected limits and reasoning effort', async () => {
  const submit = vi.fn()
  function Editor() {
    const form = useForm<PlanFormValues>({ defaultValues: PLAN_FORM_DEFAULTS })
    return (
      <Form {...form}>
        <form onSubmit={form.handleSubmit(submit)}>
          <CodexPlanFields />
          <button type='submit'>Save test plan</button>
        </form>
      </Form>
    )
  }
  render(<Editor />)
  expect(
    screen.queryByRole('spinbutton', { name: 'Memory limit (MB)' })
  ).not.toBeInTheDocument()
  await userEvent.click(
    screen.getByRole('switch', { name: 'Include online Codex' })
  )
  const memory = screen.getByRole('spinbutton', { name: 'Memory limit (MB)' })
  await userEvent.clear(memory)
  await userEvent.type(memory, '2048')
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Default reasoning effort' })
  )
  await userEvent.click(screen.getByRole('option', { name: 'Ultra' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save test plan' }))
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        codex: expect.objectContaining({
          enabled: true,
          memoryMB: 2048,
          defaultEffort: 'ultra',
          allowDocker: true,
          allowSSH: false,
        }),
      }),
      expect.anything()
    )
  )
})
