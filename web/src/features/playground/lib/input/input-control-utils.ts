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
import type { GroupOption, ModelOption } from '../../types'

type InputControlStateOptions = {
  disabled?: boolean
  groups: GroupOption[]
  groupValue: string
  modelValue: string
  attachmentCount?: number
  hasStopHandler: boolean
  isGenerating?: boolean
  isModelLoading?: boolean
  models: ModelOption[]
  text: string
}

type InputControlState = {
  canSubmit: boolean
  isSelectorDisabled: boolean
  shouldShowStop: boolean
}

type SubmittableInputMessage = {
  text?: string | null
}

export function getSubmittableInputText(
  message: SubmittableInputMessage,
  disabled?: boolean,
  attachmentCount = 0
): string | null {
  if (disabled || (!message.text?.trim() && attachmentCount === 0)) {
    return null
  }

  return message.text ?? ''
}

export function getInputControlState({
  disabled,
  groups,
  groupValue,
  modelValue,
  attachmentCount = 0,
  hasStopHandler,
  isGenerating,
  isModelLoading,
  models,
  text,
}: InputControlStateOptions): InputControlState {
  const validSelection =
    models.some((model) => model.value === modelValue) &&
    groups.some((group) => group.value === groupValue)

  return {
    canSubmit:
      !disabled &&
      !isGenerating &&
      !isModelLoading &&
      validSelection &&
      (text.trim().length > 0 || attachmentCount > 0),
    isSelectorDisabled: disabled || isModelLoading || groups.length === 0,
    shouldShowStop: Boolean(isGenerating && hasStopHandler),
  }
}
