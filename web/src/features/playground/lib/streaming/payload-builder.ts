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
import type {
  ChatCompletionRequest,
  Message,
  PlaygroundConfig,
  ParameterEnabled,
} from '../../types'
import { formatMessageForAPI, isValidMessage } from '../message/message-utils'

/**
 * Build API request payload from messages and config
 */
export function buildChatCompletionPayload(
  messages: Message[],
  config: PlaygroundConfig,
  parameterEnabled: ParameterEnabled
): ChatCompletionRequest {
  // Filter and format valid messages
  const processedMessages = messages
    .filter(isValidMessage)
    .map(formatMessageForAPI)

  const instructions = [config.system_prompt?.trim()]
  if (config.response_format === 'json_object') {
    instructions.push('Respond with a valid JSON object.')
  }
  const systemPrompt = instructions.filter(Boolean).join('\n\n')
  if (systemPrompt) {
    processedMessages.unshift({ role: 'system', content: systemPrompt })
  }

  const payload: ChatCompletionRequest = {
    model: config.model,
    group: config.group,
    messages: processedMessages,
    stream: config.stream,
  }

  if (config.stream) {
    payload.stream_options = { include_usage: true }
  }
  if (config.web_search) {
    payload.web_search_options = {
      search_context_size: config.search_context_size ?? 'medium',
    }
  }
  if (config.reasoning_effort && config.reasoning_effort !== 'default') {
    payload.reasoning_effort = config.reasoning_effort
  }
  if (config.response_format === 'json_object') {
    payload.response_format = { type: 'json_object' }
  }
  const stop = config.stop?.filter((value) => value.length > 0)
  if (stop?.length) {
    payload.stop = stop
  }

  if (parameterEnabled.temperature) {
    payload.temperature = config.temperature
  }

  if (parameterEnabled.top_p) {
    payload.top_p = config.top_p
  }

  if (parameterEnabled.max_tokens) {
    payload.max_tokens = config.max_tokens
  }

  if (parameterEnabled.frequency_penalty) {
    payload.frequency_penalty = config.frequency_penalty
  }

  if (parameterEnabled.presence_penalty) {
    payload.presence_penalty = config.presence_penalty
  }

  if (parameterEnabled.seed && config.seed !== null) {
    payload.seed = config.seed
  }

  return payload
}
