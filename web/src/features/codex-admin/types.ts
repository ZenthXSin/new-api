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
import { z } from 'zod'

export const codexPlanSchema = z.object({
  enabled: z.boolean(),
  allowDocker: z.boolean(),
  allowSSH: z.boolean(),
  cpuPercent: z.coerce.number().min(0).max(100),
  memoryMB: z.coerce
    .number()
    .int()
    .min(0)
    .max(1048576)
    .refine((v) => v === 0 || v >= 256),
  diskMB: z.coerce
    .number()
    .int()
    .min(0)
    .max(10485760)
    .refine((v) => v === 0 || v >= 256),
  maxProjects: z.coerce.number().int().min(0).max(1000),
  idleSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(86400)
    .refine((v) => v === 0 || v >= 60),
  defaultModel: z.string().trim().max(200),
  defaultGroup: z.string().trim().max(64),
  defaultEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
})
export type CodexPlanConfig = z.infer<typeof codexPlanSchema>
export const defaultCodexPlan: CodexPlanConfig = {
  enabled: false,
  allowDocker: true,
  allowSSH: false,
  cpuPercent: 0,
  memoryMB: 0,
  diskMB: 0,
  maxProjects: 0,
  idleSeconds: 0,
  defaultModel: '',
  defaultGroup: '',
  defaultEffort: '',
}
export const codexResourceFields = [
  { key: 'cpuPercent', label: 'CPU limit (%)', max: 100, step: 0.1 },
  { key: 'memoryMB', label: 'Memory limit (MB)', max: 1048576, step: 1 },
  { key: 'diskMB', label: 'Storage limit (MiB)', max: 10485760, step: 1 },
  { key: 'maxProjects', label: 'Maximum projects', max: 1000, step: 1 },
  { key: 'idleSeconds', label: 'Idle timeout (seconds)', max: 86400, step: 1 },
] as const
export type CodexAdminPolicy = CodexPlanConfig & {
  userId: number
  source: 'none' | 'manual' | 'subscription' | 'administrator'
  planId?: number
  planTitle?: string
  expiresAt?: number
  subscriptionId?: number
}
export type CodexAdminUser = {
  id: number
  username: string
  displayName: string
  role: number
  status: number
  effective: CodexAdminPolicy
}
