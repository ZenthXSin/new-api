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
import { api } from '@/lib/api'

export interface ApiResponse<T = unknown> {
  success: boolean
  message: string
  data: T
}

export type FinanceOverview = {
  revenue_quota: number
  cost_quota: number
  gross_profit_quota: number
  margin: number
  request_count: number
  cost_coverage: number
  paid_users_total: number
  paid_users_period: number
  paid_money_total: number
  paid_money_period: number
}

export type CostTrendPoint = {
  date: string
  revenue_quota: number
  cost_quota: number
  gross_profit_quota: number
  request_count: number
}

export type UserTrendPoint = {
  date: string
  new_users: number
  paid_users: number
  paid_money: number
}

export type FinanceTrends = {
  cost: CostTrendPoint[]
  users: UserTrendPoint[]
}

export async function getFinanceOverview(
  startTimestamp: number,
  endTimestamp: number
): Promise<FinanceOverview> {
  const res = await api.get<ApiResponse<FinanceOverview>>(
    '/api/finance/overview',
    {
      params: {
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp,
      },
    }
  )
  return res.data.data
}

export async function getFinanceTrends(
  startTimestamp: number,
  endTimestamp: number
): Promise<FinanceTrends> {
  const res = await api.get<ApiResponse<FinanceTrends>>('/api/finance/trends', {
    params: {
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
    },
  })
  return res.data.data
}
