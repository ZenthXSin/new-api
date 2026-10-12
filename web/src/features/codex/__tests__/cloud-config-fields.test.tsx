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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'

import type { CloudEnvironmentCapabilities, CloudEnvironmentConfig } from '../cloud-types'
import { CloudConfigFields } from '../components/cloud-config-fields'

const emptyConfig: CloudEnvironmentConfig = {
  repositories: [],
  installScript: '',
  startSkill: '',
  internetAccess: 'enabled',
  allowedDomains: [],
  environmentVariables: [],
  privacy: 'private',
  advanced: { setupTimeoutSeconds: 600 },
}

const capabilities: CloudEnvironmentCapabilities = {
  runtime: 'docker',
  internetModes: ['enabled'],
  networkSecrets: false,
  sharingModes: ['private'],
  snapshotScope: 'project_and_user_tools',
  systemPackageInstall: false,
  limits: { maxRepositories: 2, maxEnvironmentVariables: 1 },
  unsupportedReasons: {
    internetAccess: 'Outbound networking is always enabled.',
    networkSecrets: 'A domain secret proxy is not provided.',
    sharing: 'Only the environment owner has access.',
    systemPackageInstall: 'Use the writable home directory for tools.',
  },
}

function ControlledFields(props: {
  initialValue?: CloudEnvironmentConfig
  onChange?: (config: CloudEnvironmentConfig) => void
  disabled?: boolean
  capabilities?: CloudEnvironmentCapabilities
}) {
  const [value, setValue] = useState(props.initialValue ?? emptyConfig)
  return <CloudConfigFields value={value} disabled={props.disabled} capabilities={props.capabilities} onChange={(config) => { setValue(config); props.onChange?.(config) }} />
}

test('adding and editing repository fields preserves focus and every typed character, then removing the repository clears it', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields onChange={onChange} />)
  const add = screen.getByRole('button', { name: 'Add repository' })
  add.focus()
  await user.keyboard('{Enter}')
  const url = screen.getByRole('textbox', { name: 'Repository URL' })
  await user.type(url, 'https://github.com/acme/web.git')
  expect(url).toHaveFocus()
  await user.type(screen.getByRole('textbox', { name: 'Branch' }), 'feature/setup')
  await user.type(screen.getByRole('textbox', { name: 'Checkout path' }), 'web')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ repositories: [{ url: 'https://github.com/acme/web.git', branch: 'feature/setup', path: 'web' }] }))

  await user.click(screen.getByRole('button', { name: 'Remove repository 1' }))

  expect(screen.queryByRole('textbox', { name: 'Repository URL' })).not.toBeInTheDocument()
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ repositories: [] }))
  expect(screen.getByText('No repositories added. Add a repository to include it in this environment.')).toBeVisible()
})

test('multiple repositories require distinct nonempty paths without discarding invalid text', async () => {
  const user = userEvent.setup()
  render(<ControlledFields initialValue={{ ...emptyConfig, repositories: [{ url: 'https://github.com/acme/web.git', branch: '', path: 'web' }] }} />)
  await user.click(screen.getByRole('button', { name: 'Add repository' }))
  const repository = screen.getByRole('group', { name: 'Repository 2' })
  const path = within(repository).getByRole('textbox', { name: 'Checkout path' })
  expect(path).toHaveAttribute('aria-invalid', 'true')
  expect(path).toHaveAccessibleDescription('Set a checkout path for each repository when using multiple repositories.')

  await user.type(path, 'web/')

  expect(path).toHaveValue('web/')
  expect(path).toHaveAccessibleDescription('Each repository needs a unique checkout path.')
  await user.clear(path)
  await user.type(path, 'api')
  expect(path).not.toHaveAttribute('aria-invalid')
  expect(screen.queryByText('Each repository needs a unique checkout path.')).not.toBeInTheDocument()
})

test('removing an earlier repository keeps the remaining repository fields and edits associated with it', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields onChange={onChange} initialValue={{ ...emptyConfig, repositories: [
    { url: 'https://github.com/acme/web.git', branch: 'main', path: 'web' },
    { url: 'https://github.com/acme/api.git', branch: 'release', path: 'api' },
  ] }} />)
  await user.click(screen.getByRole('button', { name: 'Remove repository 1' }))
  expect(screen.getByRole('textbox', { name: 'Repository URL' })).toHaveValue('https://github.com/acme/api.git')
  await user.type(screen.getByRole('textbox', { name: 'Branch' }), '-next')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ repositories: [{ url: 'https://github.com/acme/api.git', branch: 'release-next', path: 'api' }] }))
})

test('saved secret placeholders remain absent from the outgoing value while other configuration changes', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  const secret = { name: 'REGISTRY_TOKEN', secret: true, hasValue: true }
  render(<ControlledFields onChange={onChange} initialValue={{ ...emptyConfig, environmentVariables: [secret] }} />)
  const value = screen.getByLabelText('Variable value')
  expect(value).toHaveAttribute('type', 'password')
  expect(value).toHaveValue('')
  expect(value).toHaveAttribute('placeholder', 'Saved secret retained; enter a value to replace it')
  expect(screen.getByRole('checkbox', { name: 'Secret variable 1' })).toBeDisabled()

  await user.type(screen.getByRole('textbox', { name: 'Install script' }), 'npm ci')

  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ installScript: 'npm ci', environmentVariables: [secret] }))
  expect(value).toHaveValue('')
})

test('replacing a saved secret sends only the replacement and permits changing its secret setting', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields onChange={onChange} initialValue={{ ...emptyConfig, environmentVariables: [{ name: 'TOKEN', secret: true, hasValue: true }] }} />)
  const value = screen.getByLabelText('Variable value')
  await user.type(value, 'replacement-value')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ environmentVariables: [{ name: 'TOKEN', secret: true, hasValue: true, value: 'replacement-value' }] }))
  expect(value).toHaveAttribute('type', 'password')
  const secret = screen.getByRole('checkbox', { name: 'Secret variable 1' })
  expect(secret).toBeEnabled()
  secret.focus()
  await user.keyboard(' ')
  expect(value).toHaveAttribute('type', 'text')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ environmentVariables: [{ name: 'TOKEN', secret: false, hasValue: true, value: 'replacement-value' }] }))
})

test('adding editing and removing variables emits their names values and secret flags', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields onChange={onChange} />)
  await user.click(screen.getByRole('button', { name: 'Add variable' }))
  await user.type(screen.getByRole('textbox', { name: 'Variable name' }), 'REGISTRY_URL')
  await user.type(screen.getByRole('textbox', { name: 'Variable value' }), 'https://registry.example')
  await user.click(screen.getByRole('checkbox', { name: 'Secret variable 1' }))
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ environmentVariables: [{ name: 'REGISTRY_URL', value: 'https://registry.example', secret: true, hasValue: false }] }))
  expect(screen.getByLabelText('Variable value')).toHaveAttribute('type', 'password')
  await user.click(screen.getByRole('button', { name: 'Remove variable 1' }))
  expect(screen.getByText('No environment variables added.')).toBeVisible()
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ environmentVariables: [] }))
})

test('install commands and start instructions retain multiline input independently', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields onChange={onChange} />)
  await user.type(screen.getByRole('textbox', { name: 'Install script' }), 'npm ci{Enter}npm run build')
  await user.type(screen.getByRole('textbox', { name: 'Start skill' }), 'Read AGENTS.md.{Enter}Run the tests.')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ installScript: 'npm ci\nnpm run build', startSkill: 'Read AGENTS.md.\nRun the tests.' }))
})

test('capabilities explain runtime limits without offering unsupported toggles or secret proxy controls', () => {
  render(<ControlledFields capabilities={capabilities} />)
  expect(screen.getByText('Outbound networking is always enabled.')).toBeVisible()
  expect(screen.getByText('A domain secret proxy is not provided.')).toBeVisible()
  expect(screen.getByText('Only the environment owner has access.')).toBeVisible()
  expect(screen.getByText('Use the writable home directory for tools.')).toBeVisible()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Internet access' })).getByText('Enabled')).toBeVisible()
  expect(within(screen.getByRole('region', { name: 'Privacy' })).getByText('Private')).toBeVisible()
})

test('runtime repository and variable limits disable addition until an entry is removed', async () => {
  const user = userEvent.setup()
  render(<ControlledFields capabilities={capabilities} />)
  const addRepository = screen.getByRole('button', { name: 'Add repository' })
  await user.click(addRepository)
  await user.click(addRepository)
  expect(addRepository).toBeDisabled()
  expect(screen.getByText('This environment supports up to 2 repositories.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Remove repository 1' }))
  expect(addRepository).toBeEnabled()
  const addVariable = screen.getByRole('button', { name: 'Add variable' })
  await user.click(addVariable)
  expect(addVariable).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Remove variable 1' }))
  expect(addVariable).toBeEnabled()
})

test('timeout editing keeps empty and invalid input visible and becomes valid after correction', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields onChange={onChange} />)
  await user.click(screen.getByText('Advanced'))
  const timeout = screen.getByRole('textbox', { name: 'Setup timeout (seconds)' })
  expect(timeout).toHaveValue('600')
  await user.clear(timeout)
  expect(timeout).toHaveValue('')
  expect(timeout).toHaveAttribute('aria-invalid', 'true')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ advanced: { setupTimeoutSeconds: Number.NaN } }))
  await user.type(timeout, 'oops')
  expect(timeout).toHaveValue('oops')
  await user.clear(timeout)
  await user.type(timeout, '1801')
  expect(timeout).toHaveValue('1801')
  expect(timeout).toHaveAttribute('aria-invalid', 'true')
  await user.clear(timeout)
  await user.type(timeout, '1800')
  expect(timeout).not.toHaveAttribute('aria-invalid')
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ advanced: { setupTimeoutSeconds: 1800 } }))
})

test('external timeout changes replace the displayed value after loading a new saved configuration', async () => {
  const user = userEvent.setup()
  const view = render(<CloudConfigFields value={emptyConfig} onChange={vi.fn()} />)
  await user.click(screen.getByText('Advanced'))
  view.rerender(<CloudConfigFields value={{ ...emptyConfig, advanced: { setupTimeoutSeconds: 900 } }} onChange={vi.fn()} />)
  expect(screen.getByRole('textbox', { name: 'Setup timeout (seconds)' })).toHaveValue('900')
})

test('disabled configuration prevents editing adding deleting and changing secret flags', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<ControlledFields disabled onChange={onChange} initialValue={{ ...emptyConfig, repositories: [{ url: 'https://github.com/acme/web.git', branch: 'main', path: 'web' }], environmentVariables: [{ name: 'MODE', value: 'test', secret: false, hasValue: true }] }} />)
  await user.click(screen.getByText('Advanced'))
  for (const input of screen.getAllByRole('textbox')) expect(input).toBeDisabled()
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  const secret = screen.getByRole('checkbox', { name: 'Secret variable 1' })
  expect(secret).toBeDisabled()
  await user.click(secret)
  await user.click(screen.getByRole('button', { name: 'Remove repository 1' }))
  expect(onChange).not.toHaveBeenCalled()
})
