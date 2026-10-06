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
export type HostedActionStatus =
  | 'pending'
  | 'approved'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'expired'

export interface HostedActionField {
  name: string
  label: string
  type: 'text' | 'password' | 'code' | 'json' | 'number' | 'boolean'
  required: boolean
}

export interface HostedActionStep {
  id: string
  label: string
  method: string
  path: string
  fields: HostedActionField[]
  state: 'pending' | 'completed'
  proof_scope?: string
  kind?:
    | ''
    | 'passkey-register'
    | 'passkey-verify'
    | 'oauth-bind'
    | 'telegram-bind'
}

export interface HostedActionApproval {
  action_id: string
  client_name: string
  operation: string
  label: string
  status: HostedActionStatus
  expires_at: number
  parameters: Record<string, unknown>
  steps: HostedActionStep[]
  current_step_id?: string
  share_result: boolean
  result_kind?: 'secret' | 'data' | 'receipt'
  return_uri?: string
  has_two_factor: boolean
  has_password?: boolean
  bootstrap_allowed?: boolean
  bootstrap_operation?: boolean
  verification_scope?: string
  approval_nonce: string
}

export interface HostedActionStepResult {
  data: unknown
  return_uri?: string
  action_status?: HostedActionStatus
  next_step_id?: string
}

export interface HostedSessionIdentity {
  userID: number
  sessionID: string
}
