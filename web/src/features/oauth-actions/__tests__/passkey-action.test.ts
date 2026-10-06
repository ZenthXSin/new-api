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
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { completeHostedPasskey } from '../lib/passkey-action'

const registration = {
  flow_token: 'register-flow',
  options: {
    publicKey: {
      challenge: 'AQID',
      rp: { name: 'New API', id: 'localhost' },
      user: { id: 'AQI', name: 'sample', displayName: 'Sample' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [{ type: 'public-key', id: 'BAU' }],
    },
  },
}

const assertion = {
  flow_token: 'verify-flow',
  options: {
    publicKey: {
      challenge: 'AQID',
      rpId: 'localhost',
      allowCredentials: [{ type: 'public-key', id: 'AQI' }],
      userVerification: 'required',
    },
  },
}

function browserCredential(
  kind: 'registration' | 'assertion'
): PublicKeyCredential {
  const response =
    kind === 'registration'
      ? {
          clientDataJSON: new Uint8Array([123, 125]).buffer,
          attestationObject: new Uint8Array([5]).buffer,
          getTransports: () => ['internal'],
        }
      : {
          clientDataJSON: new Uint8Array([123, 125]).buffer,
          authenticatorData: new Uint8Array([6]).buffer,
          signature: new Uint8Array([7]).buffer,
          userHandle: null,
        }
  return {
    id: 'credential-id',
    rawId: new Uint8Array([1, 2]).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response,
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential
}

const originalCredentials = Object.getOwnPropertyDescriptor(
  navigator,
  'credentials'
)
let create: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn>

beforeEach(() => {
  create = vi.fn()
  get = vi.fn()
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create, get },
  })
})

afterEach(() => {
  if (originalCredentials) {
    Object.defineProperty(navigator, 'credentials', originalCredentials)
  } else {
    Reflect.deleteProperty(navigator, 'credentials')
  }
})

test('converts registration options and returns only the documented credential payload', async () => {
  create.mockResolvedValue(browserCredential('registration'))
  const controller = new AbortController()
  const storage = vi.spyOn(Storage.prototype, 'setItem')

  const result = await completeHostedPasskey(
    'passkey-register',
    registration,
    controller.signal
  )

  expect(create).toHaveBeenCalledWith({
    signal: controller.signal,
    publicKey: {
      ...registration.options.publicKey,
      challenge: new Uint8Array([1, 2, 3]).buffer,
      user: {
        ...registration.options.publicKey.user,
        id: new Uint8Array([1, 2]).buffer,
      },
      excludeCredentials: [
        { type: 'public-key', id: new Uint8Array([4, 5]).buffer },
      ],
    },
  })
  expect(result).toEqual({
    flow_token: 'register-flow',
    credential: {
      id: 'credential-id',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: 'e30',
        attestationObject: 'BQ',
        transports: ['internal'],
      },
      clientExtensionResults: {},
    },
  })
  expect(get).not.toHaveBeenCalled()
  expect(storage).not.toHaveBeenCalled()
})

test('converts assertion options and serializes the authenticator signature', async () => {
  get.mockResolvedValue(browserCredential('assertion'))

  const result = await completeHostedPasskey('passkey-verify', assertion)

  expect(get).toHaveBeenCalledWith({
    signal: undefined,
    publicKey: {
      ...assertion.options.publicKey,
      challenge: new Uint8Array([1, 2, 3]).buffer,
      allowCredentials: [
        { type: 'public-key', id: new Uint8Array([1, 2]).buffer },
      ],
    },
  })
  expect(result).toEqual({
    flow_token: 'verify-flow',
    credential: {
      id: 'credential-id',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: 'e30',
        authenticatorData: 'Bg',
        signature: 'Bw',
        userHandle: null,
      },
      clientExtensionResults: {},
    },
  })
  expect(create).not.toHaveBeenCalled()
})

test.each([
  null,
  { options: assertion.options },
  { flow_token: ' ', options: assertion.options },
  { flow_token: 'verify-flow', options: { publicKey: {} } },
  {
    flow_token: 'verify-flow',
    options: { publicKey: { challenge: 'not base64' } },
  },
])(
  'rejects malformed flow data before opening a credential prompt',
  async (payload) => {
    await expect(
      completeHostedPasskey('passkey-verify', payload)
    ).rejects.toThrow('Passkey verification could not be completed')
    expect(get).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  }
)

test('rejects incomplete registration options before opening a credential prompt', async () => {
  await expect(
    completeHostedPasskey('passkey-register', assertion)
  ).rejects.toThrow('Passkey verification could not be completed')
  expect(create).not.toHaveBeenCalled()
})

test('reports unavailable browser support without leaking exception details', async () => {
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: undefined,
  })
  await expect(
    completeHostedPasskey('passkey-verify', assertion)
  ).rejects.toThrow('Passkey verification could not be completed')
})

test('turns browser cancellation and private error text into a generic failure', async () => {
  get.mockRejectedValue(
    new DOMException('private-account@example.test', 'NotAllowedError')
  )
  await expect(
    completeHostedPasskey('passkey-verify', assertion)
  ).rejects.toMatchObject({
    message: 'Passkey verification could not be completed',
  })
})

test.each([
  null,
  { type: 'password', id: 'credential-id' },
  { ...browserCredential('assertion'), response: {} },
])(
  'rejects missing or incomplete browser credentials instead of submitting empty proof',
  async (credential) => {
    get.mockResolvedValue(credential)
    await expect(
      completeHostedPasskey('passkey-verify', assertion)
    ).rejects.toThrow('Passkey verification could not be completed')
  }
)

test('does not open the prompt for a flow that has already been aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    completeHostedPasskey('passkey-verify', assertion, controller.signal)
  ).rejects.toThrow('Passkey verification could not be completed')
  expect(get).not.toHaveBeenCalled()
})

test('drops credentials returned after the owning hosted flow was aborted', async () => {
  const controller = new AbortController()
  get.mockImplementation(async () => {
    controller.abort()
    return browserCredential('assertion')
  })
  await expect(
    completeHostedPasskey('passkey-verify', assertion, controller.signal)
  ).rejects.toThrow('Passkey verification could not be completed')
})
