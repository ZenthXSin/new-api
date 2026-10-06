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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { HostedActionResult } from '../components/action-result'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

test('requires explicit reveal and clears selectable credentials without storing them', async () => {
  const onClear = vi.fn()
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  const user = userEvent.setup()
  render(
    <HostedActionResult
      operation='apikey.reveal'
      data={{ key: 'sk-private-key', access_token: 'session-private-token' }}
      onClear={onClear}
    />
  )

  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  const reveal = screen.getByRole('button', { name: 'Show sensitive result' })
  expect(reveal).toHaveAttribute('aria-expanded', 'false')
  reveal.focus()
  await user.keyboard('{Enter}')

  const key = screen.getByRole('textbox', { name: 'API key' })
  expect(key).toHaveValue('sk-private-key')
  expect(key).toHaveAttribute('readonly')
  expect(key).toHaveAttribute('autocomplete', 'off')
  expect(
    screen.getByRole('button', { name: 'Hide sensitive result' })
  ).toHaveAttribute('aria-expanded', 'true')
  expect(document.body.innerHTML).not.toContain('session-private-token')

  await user.click(
    screen.getByRole('button', { name: 'Clear sensitive result' })
  )
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(onClear).toHaveBeenCalledOnce()
  expect(storage).not.toHaveBeenCalled()
})

test('renders MFA setup QR locally and exposes only MFA fields', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const user = userEvent.setup()
  render(
    <HostedActionResult
      operation='mfa.setup'
      data={{
        secret: 'JBSWY3DPEHPK3PXP',
        qr_code_data: 'otpauth://totp/NewAPI:sample?secret=JBSWY3DPEHPK3PXP',
        backup_codes: ['recovery-one', 'recovery-two'],
        access_token: 'auth-rotation-secret',
        session: { key: 'session-secret' },
        token: 'unexpected-token',
      }}
      onClear={vi.fn()}
    />
  )

  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )

  expect(screen.getByRole('textbox', { name: 'MFA setup code' })).toHaveValue(
    'JBSWY3DPEHPK3PXP'
  )
  expect(screen.getByRole('textbox', { name: 'Backup codes' })).toHaveValue(
    'recovery-one\nrecovery-two'
  )
  expect(screen.getByRole('img', { name: 'Scan QR Code' }).tagName).toBe(
    'CANVAS'
  )
  expect(document.querySelector('img')).toBeNull()
  expect(document.body.innerHTML).not.toMatch(
    /auth-rotation-secret|session-secret|unexpected-token/
  )

  await user.click(
    screen.getByRole('button', { name: 'Hide sensitive result' })
  )
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

test('hides a newly returned result until it is separately revealed', async () => {
  const user = userEvent.setup()
  const props = { operation: 'channel.key.reveal', onClear: vi.fn() }
  const view = render(
    <HostedActionResult {...props} data={{ key: 'first-secret' }} />
  )
  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )
  expect(screen.getByRole('textbox', { name: 'API key' })).toHaveValue(
    'first-secret'
  )

  view.rerender(<HostedActionResult {...props} data={{ key: 'next-secret' }} />)

  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(document.body.innerHTML).not.toContain('next-secret')
  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )
  expect(screen.getByRole('textbox', { name: 'API key' })).toHaveValue(
    'next-secret'
  )
})

test.each(['password.change', 'mfa.enable', 'sessions.list', 'unrecognized'])(
  'does not render arbitrary controller or authentication data for %s',
  (operation) => {
    const data: Record<string, unknown> = {
      secret: 'private-secret',
      key: 'private-key',
      token: 'private-token',
      access_token: 'private-access-token',
      backup_codes: ['private-backup-code'],
    }
    data.circular = data
    const view = render(
      <HostedActionResult operation={operation} data={data} onClear={vi.fn()} />
    )
    expect(view.container).toBeEmptyDOMElement()
  }
)

test.each([
  [
    'app_payment.configure',
    { webhook_secret: 'notification-value', client_secret: 'hidden-value' },
    'Notification secret',
    'notification-value',
  ],
  [
    'app_payment.rotate_secret',
    { webhook_secret: 'rotated-notification-value', token: 'hidden-value' },
    'Notification secret',
    'rotated-notification-value',
  ],
  [
    'credential.legacy_generate',
    'legacy-value',
    'Personal access token',
    'legacy-value',
  ],
  [
    'oauth_client.reset_secret',
    { client_secret: 'client-value', token: 'hidden-value' },
    'Client secret',
    'client-value',
  ],
  [
    'app.telemetry.reveal',
    { token: 'telemetry-value', key: 'hidden-value' },
    'Telemetry key',
    'telemetry-value',
  ],
  [
    'mfa.backup_codes',
    { backup_codes: ['backup-value'], secret: 'hidden-value' },
    'Backup codes',
    'backup-value',
  ],
])(
  'allows the exact documented secret field for %s',
  async (operation, data, label, value) => {
    const user = userEvent.setup()
    render(
      <HostedActionResult
        operation={operation as string}
        data={data}
        onClear={vi.fn()}
      />
    )
    await user.click(
      screen.getByRole('button', { name: 'Show sensitive result' })
    )
    expect(screen.getByRole('textbox', { name: label as string })).toHaveValue(
      value
    )
    expect(document.body.innerHTML).not.toContain('hidden-value')
  }
)

test('labels batch keys by token ID and excludes non-token fields', async () => {
  const user = userEvent.setup()
  render(
    <HostedActionResult
      operation='apikey.reveal_batch'
      data={{
        keys: {
          12: 'first-key',
          29: 'second-key',
          access_token: 'hidden-value',
        },
      }}
      onClear={vi.fn()}
    />
  )
  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )
  expect(screen.getByRole('textbox', { name: 'API key #12' })).toHaveValue(
    'first-key'
  )
  expect(screen.getByRole('textbox', { name: 'API key #29' })).toHaveValue(
    'second-key'
  )
  expect(screen.getAllByRole('textbox')).toHaveLength(2)
  expect(document.body.innerHTML).not.toContain('hidden-value')
})

test('ignores malformed secrets and does not use arbitrary URLs for MFA QR images', () => {
  const view = render(
    <HostedActionResult
      operation='mfa.setup'
      data={{
        secret: {},
        backup_codes: ['valid', {}],
        qr_code_data: 'https://third-party.test/leak',
      }}
      onClear={vi.fn()}
    />
  )
  expect(view.container).toBeEmptyDOMElement()
})

test('reveals only the documented channel configuration fields after confirmation and clears them', async () => {
  const user = userEvent.setup()
  const clear = vi.fn()
  const store = vi.spyOn(Storage.prototype, 'setItem')
  const configuration = {
    id: 123,
    name: 'Private upstream',
    header_override: '{"Authorization":"Bearer configured-secret"}',
    param_override: '{"api_key":"parameter-secret"}',
    setting: '{"proxy_url":"https://user:password@proxy.test"}',
    settings: '{"access_token":"upstream-setting-secret"}',
    other: 'other-secret',
    other_info: 'info-secret',
    base_url: 'https://example.test?key=url-secret',
  }
  render(
    <HostedActionResult
      operation='channel.config.reveal'
      data={{
        ...configuration,
        key: 'standalone-key',
        access_token: 'panel-session-token',
        unexpected_secret: 'excluded-secret',
        session: { sid: 'excluded-session' },
      }}
      onClear={clear}
    />
  )
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(document.body.innerHTML).not.toContain('configured-secret')
  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )
  const output = screen.getByRole('textbox', { name: 'Channel configuration' })
  expect(output).toHaveValue(JSON.stringify(configuration, null, 2))
  expect(output).toHaveAttribute('readonly')
  expect(document.body.innerHTML).not.toMatch(
    /standalone-key|panel-session-token|excluded-secret|excluded-session/
  )
  await user.click(
    screen.getByRole('button', { name: 'Clear sensitive result' })
  )
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(clear).toHaveBeenCalledOnce()
  expect(store).not.toHaveBeenCalled()
})

test('preserves empty channel configuration strings and nulls without rendering unrelated response objects', async () => {
  const user = userEvent.setup()
  render(
    <HostedActionResult
      operation='channel.config.reveal'
      data={{
        id: 123,
        name: 'Empty configuration',
        header_override: null,
        setting: '',
        other_info: { access_token: 'unexpected-object-secret' },
        key: 'unrelated-key',
      }}
      onClear={vi.fn()}
    />
  )
  await user.click(
    screen.getByRole('button', { name: 'Show sensitive result' })
  )
  expect(
    screen.getByRole('textbox', { name: 'Channel configuration' })
  ).toHaveValue(
    JSON.stringify(
      {
        id: 123,
        name: 'Empty configuration',
        header_override: null,
        setting: '',
      },
      null,
      2
    )
  )
  expect(document.body.innerHTML).not.toMatch(
    /unexpected-object-secret|unrelated-key/
  )
})
