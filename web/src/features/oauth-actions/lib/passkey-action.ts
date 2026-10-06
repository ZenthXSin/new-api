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
import {
  buildAssertionResult,
  buildRegistrationResult,
  prepareCredentialCreationOptions,
  prepareCredentialRequestOptions,
} from '@/lib/passkey'

type HostedPasskeyKind = 'passkey-register' | 'passkey-verify'

interface HostedPasskeyResult {
  flow_token: string
  credential: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEncodedBytes(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(value)
}

export async function completeHostedPasskey(
  kind: HostedPasskeyKind,
  payload: unknown,
  signal?: AbortSignal
): Promise<HostedPasskeyResult> {
  try {
    if (
      (kind !== 'passkey-register' && kind !== 'passkey-verify') ||
      !isRecord(payload) ||
      typeof payload.flow_token !== 'string' ||
      payload.flow_token.trim().length === 0 ||
      payload.flow_token.length > 16384 ||
      signal?.aborted ||
      typeof navigator === 'undefined' ||
      !navigator.credentials
    ) {
      throw new Error()
    }

    const optionsPayload = payload.options ?? payload
    if (!isRecord(optionsPayload)) throw new Error()
    const options =
      optionsPayload.publicKey ??
      optionsPayload.PublicKey ??
      optionsPayload.response ??
      optionsPayload.Response
    if (!isRecord(options) || !isEncodedBytes(options.challenge)) {
      throw new Error()
    }

    let credential: Credential | null
    if (kind === 'passkey-register') {
      if (
        typeof navigator.credentials.create !== 'function' ||
        !isRecord(options.user) ||
        !isEncodedBytes(options.user.id) ||
        typeof options.user.name !== 'string' ||
        typeof options.user.displayName !== 'string' ||
        !isRecord(options.rp) ||
        typeof options.rp.name !== 'string' ||
        !Array.isArray(options.pubKeyCredParams) ||
        options.pubKeyCredParams.length === 0
      ) {
        throw new Error()
      }
      credential = await navigator.credentials.create({
        publicKey: prepareCredentialCreationOptions(optionsPayload),
        signal,
      })
    } else {
      if (typeof navigator.credentials.get !== 'function') throw new Error()
      credential = await navigator.credentials.get({
        publicKey: prepareCredentialRequestOptions(optionsPayload),
        signal,
      })
    }

    if (
      signal?.aborted ||
      !credential ||
      credential.type !== 'public-key' ||
      !credential.id ||
      !('rawId' in credential) ||
      !('response' in credential)
    ) {
      throw new Error()
    }
    const publicKeyCredential = credential as PublicKeyCredential
    const result =
      kind === 'passkey-register'
        ? buildRegistrationResult(publicKeyCredential)
        : buildAssertionResult(publicKeyCredential)
    if (
      !result ||
      !isEncodedBytes(result.rawId) ||
      !isRecord(result.response) ||
      !isEncodedBytes(result.response.clientDataJSON)
    ) {
      throw new Error()
    }
    if (kind === 'passkey-register') {
      if (!isEncodedBytes(result.response.attestationObject)) throw new Error()
    } else if (
      !isEncodedBytes(result.response.authenticatorData) ||
      !isEncodedBytes(result.response.signature)
    ) {
      throw new Error()
    }

    return { flow_token: payload.flow_token, credential: result }
  } catch {
    // Browser exception text and server payloads can contain account details.
    throw new Error('Passkey verification could not be completed')
  }
}
