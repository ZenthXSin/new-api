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
import { expect, test, vi } from 'vitest'

import { ActionStepForm } from '../components/action-step-form'
import type { HostedActionStep } from '../types'

const step: HostedActionStep = {
  id: 'execute',
  label: 'Update profile',
  method: 'POST',
  path: '/ignored',
  state: 'pending',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'amount', label: 'Amount', type: 'number', required: true },
    { name: 'enabled', label: 'Enabled', type: 'boolean', required: true },
    { name: 'groups', label: 'Groups', type: 'json', required: true },
  ],
}

test('rejects invalid required, number, boolean and JSON values before submitting a step', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)
  render(<ActionStepForm step={step} disabled={false} onSubmit={onSubmit} />)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(await screen.findAllByText('This field is required')).toHaveLength(4)
  await user.type(screen.getByLabelText('Name'), 'Valid name')
  await user.type(screen.getByLabelText('Amount'), 'Infinity')
  await user.type(screen.getByLabelText('Enabled'), 'yes')
  await user.type(screen.getByLabelText('Groups'), 'invalid')
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(await screen.findByText('Please enter a valid number')).toBeVisible()
  expect(screen.getByText('Enter true or false')).toBeVisible()
  expect(screen.getByText('Please enter valid JSON')).toBeVisible()
  expect(screen.getByLabelText('Amount')).toHaveAttribute(
    'aria-invalid',
    'true'
  )
  expect(onSubmit).not.toHaveBeenCalled()
})

test('preserves explicit zero and false while submitting typed values and browser-prepared credential data', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(async () => undefined)
  const preparedInput = {
    flow_token: 'browser-only-flow',
    credential: { id: 'created-key' },
  }
  render(
    <ActionStepForm
      step={step}
      disabled={false}
      preparedInput={preparedInput}
      onSubmit={onSubmit}
    />
  )
  await user.type(screen.getByLabelText('Name'), 'Name')
  await user.type(screen.getByLabelText('Amount'), '0')
  await user.type(screen.getByLabelText('Enabled'), 'false')
  await user.click(screen.getByLabelText('Groups'))
  await user.paste('[]')
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      ...preparedInput,
      name: 'Name',
      amount: 0,
      enabled: false,
      groups: [],
    })
  )
  expect(screen.queryByDisplayValue('browser-only-flow')).toBeNull()
})
