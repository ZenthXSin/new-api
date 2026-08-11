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
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { TFunction } from 'i18next'

import type { SubscriptionPlan } from '../../types'
import {
  formValuesToPlanPayload,
  getPlanFormSchema,
  PLAN_FORM_DEFAULTS,
  planToFormValues,
  type PlanFormValues,
} from '../plan-form'

const translate = ((key: string) => key) as TFunction

function createPlan(
  overrides: Partial<SubscriptionPlan> = {}
): SubscriptionPlan {
  return {
    ...overrides,
    id: 1,
    title: 'Test Plan',
    currency: 'USD',
    price_amount: 9.99,
    duration_unit: 'month',
    duration_value: 1,
    quota_reset_period: 'never',
    enabled: true,
    allow_balance_pay: true,
    allow_wallet_overflow: true,
    sort_order: 0,
    max_purchase_per_user: 0,
    total_amount: 1000,
  }
}

function createFormValues(
  overrides: Partial<PlanFormValues> = {}
): PlanFormValues {
  return { ...PLAN_FORM_DEFAULTS, ...overrides }
}

describe('subscription plan allowed_groups', () => {
  describe('planToFormValues', () => {
    test('turns an empty allowed_groups string into an empty array', () => {
      const values = planToFormValues(createPlan({ allowed_groups: '' }))
      assert.deepEqual(values.allowed_groups, [])
    })

    test('turns a single allowed group into a one-element array', () => {
      const values = planToFormValues(createPlan({ allowed_groups: 'vip' }))
      assert.deepEqual(values.allowed_groups, ['vip'])
    })

    test('splits, trims and drops empty entries from a group list', () => {
      const values = planToFormValues(
        createPlan({ allowed_groups: 'vip, default,' })
      )
      assert.deepEqual(values.allowed_groups, ['vip', 'default'])
    })
  })

  describe('formValuesToPlanPayload', () => {
    test('joins an empty array into an empty string', () => {
      const payload = formValuesToPlanPayload(
        createFormValues({ allowed_groups: [] })
      )
      assert.equal(payload.plan.allowed_groups, '')
    })

    test('joins a single allowed group', () => {
      const payload = formValuesToPlanPayload(
        createFormValues({ allowed_groups: ['vip'] })
      )
      assert.equal(payload.plan.allowed_groups, 'vip')
    })

    test('joins multiple allowed groups with commas', () => {
      const payload = formValuesToPlanPayload(
        createFormValues({ allowed_groups: ['vip', 'default'] })
      )
      assert.equal(payload.plan.allowed_groups, 'vip,default')
    })
  })

  describe('schema validation', () => {
    test('accepts form values without an allowed_groups field', () => {
      const values = createFormValues({ title: 'Test Plan' })
      delete values.allowed_groups
      const result = getPlanFormSchema(translate).safeParse(values)
      assert.equal(result.success, true)
    })

    test('accepts an allowed_groups array of group names', () => {
      const result = getPlanFormSchema(translate).safeParse(
        createFormValues({ title: 'Test Plan', allowed_groups: ['vip'] })
      )
      assert.equal(result.success, true)
    })
  })
})
