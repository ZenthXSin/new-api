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
import { ERROR_MESSAGES } from '../../constants'
import { asRecord } from './response-metadata'

export type RequestErrorDetails = {
  errorCode?: string
  errorMessage: string
}

export function parseRequestErrorDetails(error: unknown): RequestErrorDetails {
  const requestError = asRecord(error)
  const response = asRecord(requestError?.response)
  const data = asRecord(response?.data)
  const apiError = asRecord(data?.error)
  const message = [
    apiError?.message,
    data?.message,
    requestError?.message,
  ].find((value) => typeof value === 'string' && value)

  return {
    errorCode: typeof apiError?.code === 'string' ? apiError.code : undefined,
    errorMessage:
      typeof message === 'string' ? message : ERROR_MESSAGES.API_REQUEST_ERROR,
  }
}
