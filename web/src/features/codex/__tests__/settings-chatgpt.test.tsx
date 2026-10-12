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
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { useState } from 'react'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { ThemeProvider } from '@/context/theme-provider'
import { api } from '@/lib/api'
import { getCookie, removeCookie } from '@/lib/cookies'
import { useAuthStore } from '@/stores/auth-store'

import { ChatgptSettings } from '../components/chatgpt-settings'

let language: i18n

beforeEach(async () => {
  removeCookie('vite-ui-theme')
  localStorage.removeItem('i18nextLng')
  useAuthStore.getState().auth.reset()
  language = createInstance()
  await language
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: {
        en: { translation: {} },
        zhCN: {
          translation: {
            Settings: '设置',
            Language: '语言',
            'Close settings': '关闭设置',
          },
        },
      },
      detection: { order: ['localStorage'], caches: ['localStorage'] },
    })
})

afterEach(() => {
  cleanup()
  removeCookie('vite-ui-theme')
  localStorage.removeItem('i18nextLng')
  useAuthStore.getState().auth.reset()
  document.documentElement.classList.remove('light', 'dark')
})

function SettingsFixture(props: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(props.initiallyOpen ?? true)
  return (
    <I18nextProvider i18n={language}>
      <ThemeProvider>
        <button type='button' onClick={() => setOpen(true)}>
          Open settings
        </button>
        <ChatgptSettings
          open={open}
          onOpenChange={setOpen}
          environment={
            <input
              aria-label='Environment name'
              defaultValue='Personal environment'
            />
          }
          connections={<button type='button'>Connect GitHub</button>}
        />
      </ThemeProvider>
    </I18nextProvider>
  )
}

test('changing appearance updates the page and restores the saved preference after remount', async () => {
  const view = render(<SettingsFixture />)
  await userEvent.click(screen.getByRole('combobox', { name: 'Appearance' }))
  await userEvent.click(screen.getByRole('option', { name: 'Dark' }))

  expect(document.documentElement).toHaveClass('dark')
  expect(getCookie('vite-ui-theme')).toBe('dark')

  view.unmount()
  render(<SettingsFixture />)
  expect(
    screen.getByRole('combobox', { name: 'Appearance' })
  ).toHaveTextContent('Dark')

  await userEvent.click(screen.getByRole('combobox', { name: 'Appearance' }))
  await userEvent.click(screen.getByRole('option', { name: 'System' }))
  expect(getCookie('vite-ui-theme')).toBe('system')
  expect(document.documentElement).toHaveClass('light')
})

test('changing language updates visible labels and the existing browser preference', async () => {
  const put = vi.spyOn(api, 'put')
  render(<SettingsFixture />)
  await userEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await userEvent.click(screen.getByRole('option', { name: '简体中文' }))

  expect(await screen.findByRole('dialog', { name: '设置' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: '语言' })).toHaveTextContent(
    '简体中文'
  )
  expect(localStorage.getItem('i18nextLng')).toBe('zhCN')
  expect(put).not.toHaveBeenCalled()
})

test('signed-in language changes persist to the account without dropping other settings', async () => {
  useAuthStore.getState().auth.setUser({
    id: 27,
    username: 'settings-user',
    role: 1,
    setting: JSON.stringify({ language: 'en', notify: true }),
  })
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  render(<SettingsFixture />)
  await userEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await userEvent.click(screen.getByRole('option', { name: '简体中文' }))

  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: '语言' })).toBeEnabled()
  )
  expect(put).toHaveBeenCalledWith('/api/user/self', { language: 'zhCN' })
  expect(
    JSON.parse(String(useAuthStore.getState().auth.user?.setting))
  ).toEqual({
    language: 'zhCN',
    notify: true,
  })
})

test('failed account persistence restores the previous language and permits retry', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 27, username: 'settings-user', role: 1 })
  let finishSave: (response: { data: { success: boolean } }) => void = () =>
    undefined
  const put = vi.spyOn(api, 'put').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve
      })
  )
  render(<SettingsFixture />)
  await userEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await userEvent.click(screen.getByRole('option', { name: '简体中文' }))
  expect(screen.getByRole('combobox', { name: '语言' })).toBeDisabled()
  expect(screen.getByRole('status', { name: 'Saving...' })).toBeVisible()

  await act(async () => finishSave({ data: { success: false } }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Failed to update settings'
  )
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeEnabled()
  expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent(
    'English'
  )
  expect(localStorage.getItem('i18nextLng')).toBe('en')

  put.mockResolvedValueOnce({ data: { success: true } })
  await userEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await userEvent.click(screen.getByRole('option', { name: '简体中文' }))
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  )
  expect(screen.getByRole('combobox', { name: '语言' })).toHaveTextContent(
    '简体中文'
  )
})

test('desktop keyboard navigation changes sections and retains edits in mounted panels', async () => {
  render(<SettingsFixture />)
  const navigation = screen.getByRole('tablist', {
    name: 'Settings navigation',
  })
  expect(navigation).toHaveAttribute('aria-orientation', 'vertical')
  screen.getByRole('tab', { name: 'General' }).focus()
  await userEvent.keyboard('{ArrowDown}')
  expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await userEvent.clear(
    screen.getByRole('textbox', { name: 'Environment name' })
  )
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Environment name' }),
    'Updated environment'
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Connections' }))
  expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeVisible()
  expect(
    screen.queryByRole('textbox', { name: 'Environment name' })
  ).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name: 'Environment' }))
  expect(screen.getByRole('textbox', { name: 'Environment name' })).toHaveValue(
    'Updated environment'
  )
})

test('a failed request from a replaced session cannot roll back the new session language', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 27, username: 'settings-user', role: 1 })
  let rejectSave: (error: Error) => void = () => undefined
  vi.spyOn(api, 'put').mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject
      })
  )
  render(<SettingsFixture />)
  await userEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await userEvent.click(screen.getByRole('option', { name: '简体中文' }))
  expect(screen.getByRole('combobox', { name: '语言' })).toBeDisabled()

  await act(async () => {
    useAuthStore.setState((state) => ({
      auth: {
        ...state.auth,
        session: {
          sid: 'replacement-session',
          current: true,
          login_method: 'password',
          ip: '',
          user_agent: '',
          created_at: 0,
          last_active_at: 0,
          expires_at: 0,
        },
      },
    }))
    await language.changeLanguage('fr')
  })
  await act(async () => rejectSave(new Error('Old session failed')))

  expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent(
    'Français'
  )
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeEnabled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(localStorage.getItem('i18nextLng')).toBe('fr')
})

test('a pending save failure cannot undo a newer language choice made outside settings', async () => {
  useAuthStore
    .getState()
    .auth.setUser({ id: 27, username: 'settings-user', role: 1 })
  let rejectSave: (error: Error) => void = () => undefined
  vi.spyOn(api, 'put').mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectSave = reject
      })
  )
  render(<SettingsFixture />)
  await userEvent.click(screen.getByRole('combobox', { name: 'Language' }))
  await userEvent.click(screen.getByRole('option', { name: '简体中文' }))
  await act(() => language.changeLanguage('fr'))
  await act(async () => rejectSave(new Error('Old preference failed')))

  expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent(
    'Français'
  )
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeEnabled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(localStorage.getItem('i18nextLng')).toBe('fr')
})

test('mobile navigation uses horizontal keyboard movement above scrollable content', async () => {
  const originalMatchMedia = window.matchMedia
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...originalMatchMedia(query),
    matches: query === '(max-width: 639px)',
  }))
  render(<SettingsFixture />)
  const navigation = screen.getByRole('tablist', {
    name: 'Settings navigation',
  })
  expect(navigation).toHaveAttribute('aria-orientation', 'horizontal')
  expect(navigation).toHaveClass('overflow-x-auto')
  expect(navigation.parentElement).toHaveClass('flex-col')
  expect(
    screen.getByRole('tabpanel', { name: 'General' }).parentElement
  ).toHaveClass('overflow-y-auto', 'min-h-0')
  screen.getByRole('tab', { name: 'General' }).focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('Escape closes settings and restores focus to the initiating control', async () => {
  render(<SettingsFixture initiallyOpen={false} />)
  const trigger = screen.getByRole('button', { name: 'Open settings' })
  await userEvent.click(trigger)
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
  expect(trigger).toHaveFocus()
  await userEvent.click(trigger)
  await userEvent.click(screen.getByRole('button', { name: 'Close settings' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
})

test('missing optional panels show their actual unavailable state without invented actions', async () => {
  render(<ChatgptSettings open onOpenChange={vi.fn()} />)
  await userEvent.click(screen.getByRole('tab', { name: 'Environment' }))
  expect(
    screen.getByRole('tabpanel', { name: 'Environment' })
  ).toHaveTextContent('No environment is available.')
  await userEvent.click(screen.getByRole('tab', { name: 'Connections' }))
  expect(
    screen.getByRole('tabpanel', { name: 'Connections' })
  ).toHaveTextContent('No connections are available.')
})

test('opening cloud settings keeps Docker separate and invokes the real management action after closing', async () => {
  const actions: string[] = []
  render(
    <ChatgptSettings
      open
      initialSection='cloud'
      onOpenChange={(open) => actions.push(`open:${open}`)}
      onManageEnvironments={() => actions.push('manage-cloud')}
      environment={<p>Docker containers and resources</p>}
    />
  )
  expect(screen.getByRole('tab', { name: 'Codex Cloud' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(screen.getByRole('tab', { name: 'Docker' })).toBeVisible()
  await userEvent.click(
    screen.getByRole('button', { name: 'Manage environments' })
  )
  expect(actions).toEqual(['open:false', 'manage-cloud'])
})

test('the initial section is applied when settings reopen without resetting navigation while open', async () => {
  const props = {
    onOpenChange: vi.fn(),
    environment: <p>Docker containers and resources</p>,
    connections: <button type='button'>Manage GitHub connection</button>,
  }
  const view = render(
    <ChatgptSettings {...props} open={false} initialSection='connections' />
  )
  view.rerender(
    <ChatgptSettings {...props} open initialSection='connections' />
  )
  expect(screen.getByRole('tab', { name: 'Connections' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Environment' }))
  view.rerender(<ChatgptSettings {...props} open initialSection='general' />)
  expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  view.rerender(
    <ChatgptSettings {...props} open={false} initialSection='general' />
  )
  view.rerender(<ChatgptSettings {...props} open initialSection='general' />)
  expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
})

test('an unavailable cloud section falls back to general settings without advertising a fake management action', () => {
  render(<ChatgptSettings open initialSection='cloud' onOpenChange={vi.fn()} />)
  expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(
    screen.queryByRole('tab', { name: 'Codex Cloud' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Manage environments' })
  ).not.toBeInTheDocument()
})

test('connection management from its section closes settings before opening the connection manager', async () => {
  const actions: string[] = []
  render(
    <ChatgptSettings
      open
      initialSection='connections'
      onOpenChange={(open) => actions.push(`open:${open}`)}
      onManageConnections={() => actions.push('manage-connections')}
    />
  )
  const panel = screen.getByRole('tabpanel', { name: 'Connections' })
  await userEvent.click(
    within(panel).getByRole('button', { name: 'Manage connections' })
  )
  expect(actions).toEqual(['open:false', 'manage-connections'])
})
