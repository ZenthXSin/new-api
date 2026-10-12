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
import type { CodexCatalog, CodexStatus, CodexWorkspace } from '../types'

export interface CodexModelPreferences {
  version: 1
  model: string
  group: string
  effort: string
}

// Account scoped, rather than session scoped, so logging in again retains choices.
export function readModelPreferences(
  actor: string
): CodexModelPreferences | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(`codex-model-preferences:${actor.split(':')[0]}`) ||
        'null'
    )
    if (value?.version !== 1) return null
    for (const [key, limit] of [
      ['model', 512],
      ['group', 512],
      ['effort', 64],
    ] as const) {
      if (
        typeof value[key] !== 'string' ||
        value[key].length > limit ||
        [...(value[key] as string)].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
        )
      ) {
        return null
      }
    }
    if (!value.model || !value.effort) {
      return null
    }
    return {
      version: 1,
      model: value.model,
      group: value.group,
      effort: value.effort,
    }
  } catch {
    return null
  }
}

export function saveModelPreferences(
  actor: string,
  value: CodexModelPreferences
): void {
  try {
    localStorage.setItem(
      `codex-model-preferences:${actor.split(':')[0]}`,
      JSON.stringify(value)
    )
  } catch {
    // Disabled or full storage must not prevent selecting a model in this session.
  }
}

export function resolveModelPreferences(
  preference: CodexModelPreferences | null,
  status?: CodexStatus,
  catalog?: CodexCatalog,
  workspace?: CodexWorkspace
): CodexModelPreferences {
  const groups = catalog?.groups
  const preferredGroup = groups?.find((entry) => entry.id === preference?.group)
  const allowed =
    !!preference &&
    (groups
      ? !!preferredGroup?.models.some(
          (entry) => entry.id === preference.model && entry.supported
        )
      : !status || status.models.some((entry) => entry.id === preference.model))
  const model = allowed
    ? preference.model
    : workspace?.model || catalog?.defaultModel || status?.defaultModel || ''
  const group = allowed
    ? preference.group
    : workspace?.group || catalog?.defaultGroup || ''
  const choice = status?.models.find((entry) => entry.id === model)
  const efforts = choice?.efforts?.length ? choice.efforts : status?.efforts
  let effort =
    preference?.effort || workspace?.effort || status?.defaultEffort || 'medium'
  if (efforts?.length && !efforts.includes(effort)) {
    effort =
      [choice?.defaultEffort, status?.defaultEffort].find(
        (value) => !!value && efforts.includes(value)
      ) || efforts[0]
  }
  return { version: 1, model, group, effort }
}
