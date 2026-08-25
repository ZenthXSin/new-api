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
import dayjs from '@/lib/dayjs'

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
  manual_income_money: number
  manual_expense_money: number
  manual_income_quota: number
  manual_expense_quota: number
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

// ============================================================================
// Finance Bills
// ============================================================================

export type FinanceBillType =
  | 'topup'
  | 'refund'
  | 'subscription'
  | 'affiliate'
  | 'income'
  | 'expense'

export type FinanceBillItem = {
  time: number
  type: FinanceBillType
  username: string
  amount_money: number
  note: string
  source: string
}

export type FinanceBillsResponse = {
  items: FinanceBillItem[]
  total: number
  page: number
  size: number
}

export type FinanceBillsParams = {
  page: number
  size: number
  type?: FinanceBillType
  username?: string
  start?: number
  end?: number
}

export type FinanceBillsExportParams = {
  type?: FinanceBillType
  username?: string
  start?: number
  end?: number
}

export async function getFinanceBills(
  params: FinanceBillsParams
): Promise<FinanceBillsResponse> {
  const res = await api.get<ApiResponse<FinanceBillsResponse>>(
    '/api/finance/bills',
    { params }
  )
  return res.data.data
}

export async function exportFinanceBills(
  params: FinanceBillsExportParams = {}
): Promise<void> {
  const res = await api.get<Blob>('/api/finance/bills/export', {
    params,
    responseType: 'blob',
  })
  const url = URL.createObjectURL(res.data)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `finance-bills-${dayjs().format('YYYYMMDD-HHmmss')}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

// ============================================================================
// Funds Log
// ============================================================================

export type FundsLogType = 'topup' | 'consume' | 'refund'

export type FundsLogItem = {
  time: number
  username: string
  type: FundsLogType
  quota_delta: number
  description: string
}

export type FundsLogResponse = {
  items: FundsLogItem[]
  total: number
  page: number
  size: number
}

export type FundsLogParams = {
  page: number
  size: number
  username?: string
  type?: FundsLogType
  start?: number
  end?: number
}

export async function getFinanceFundsLog(
  params: FundsLogParams
): Promise<FundsLogResponse> {
  const res = await api.get<ApiResponse<FundsLogResponse>>(
    '/api/finance/funds-log',
    { params }
  )
  return res.data.data
}

// ============================================================================
// Manual Entries
// ============================================================================

export type FinanceEntryType = 'income' | 'expense'

export type FinanceEntryItem = {
  id: number
  entry_type: FinanceEntryType
  category: string
  amount: number
  note: string
  created_by: number
  created_at: number
}

export type FinanceEntryInput = {
  entry_type: FinanceEntryType
  category: string
  amount: number
  note: string
}

export type FinanceEntriesResponse = {
  items: FinanceEntryItem[]
  total: number
  page: number
  size: number
}

export type FinanceEntriesParams = {
  page: number
  size: number
  entry_type?: FinanceEntryType
  start?: number
  end?: number
}

export async function getFinanceEntries(
  params: FinanceEntriesParams
): Promise<FinanceEntriesResponse> {
  const res = await api.get<ApiResponse<FinanceEntriesResponse>>(
    '/api/finance/entries',
    { params }
  )
  return res.data.data
}

export async function createFinanceEntry(
  input: FinanceEntryInput
): Promise<FinanceEntryItem> {
  const res = await api.post<ApiResponse<FinanceEntryItem>>(
    '/api/finance/entries',
    input
  )
  return res.data.data
}

export async function updateFinanceEntry(
  id: number,
  input: FinanceEntryInput
): Promise<FinanceEntryItem> {
  const res = await api.put<ApiResponse<FinanceEntryItem>>(
    `/api/finance/entries/${id}`,
    input
  )
  return res.data.data
}

export async function deleteFinanceEntry(id: number): Promise<void> {
  await api.delete(`/api/finance/entries/${id}`)
}
