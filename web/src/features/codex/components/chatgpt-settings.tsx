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
import { Tabs } from '@base-ui/react/tabs'
import {
  ArrowUpRight,
  Cloud,
  LoaderCircle,
  Plug,
  Server,
  Settings2,
  X,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTheme } from '@/context/theme-provider'
import { updateUserLanguage } from '@/features/profile/api'
import { parseUserSettings } from '@/features/profile/lib'
import { useMediaQuery } from '@/hooks/use-media-query'
import {
  INTERFACE_LANGUAGE_OPTIONS,
  normalizeInterfaceLanguage,
} from '@/i18n/languages'
import { useAuthStore } from '@/stores/auth-store'

import { CodexSelect } from './select'

export type CodexSettingsSection =
  | 'general'
  | 'cloud'
  | 'environment'
  | 'connections'

type ChatgptSettingsProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: CodexSettingsSection
  cloud?: ReactNode
  environment?: ReactNode
  connections?: ReactNode
  onManageEnvironments?: () => void
  onManageConnections?: () => void
}

export function ChatgptSettings(props: ChatgptSettingsProps) {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const user = useAuthStore((state) => state.auth.user)
  const sessionId = useAuthStore((state) => state.auth.session?.sid)
  const isMobile = useMediaQuery('(max-width: 639px)')
  const content = useRef<HTMLDivElement>(null)
  const appearanceId = useId()
  const languageId = useId()
  const hasCloud = props.cloud != null || !!props.onManageEnvironments
  const [section, setSection] = useState<CodexSettingsSection>(
    props.initialSection ?? 'general'
  )
  const wasOpen = useRef(false)
  const [savingLanguage, setSavingLanguage] = useState(false)
  const [languageError, setLanguageError] = useState(false)
  const languageRequest = useRef(0)
  const currentLanguage = useRef(normalizeInterfaceLanguage(i18n.language))

  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setSection(props.initialSection ?? 'general')
    }
    wasOpen.current = props.open
  }, [props.open, props.initialSection])

  useEffect(() => {
    const trackLanguage = (language: string): void => {
      currentLanguage.current = normalizeInterfaceLanguage(language)
    }
    trackLanguage(i18n.language)
    i18n.on('languageChanged', trackLanguage)
    return () => {
      i18n.off('languageChanged', trackLanguage)
    }
  }, [i18n])

  useEffect(() => {
    languageRequest.current += 1
    setSavingLanguage(false)
    setLanguageError(false)
    return () => {
      languageRequest.current += 1
    }
  }, [user?.id, sessionId])

  const handleLanguageChange = async (language: string): Promise<void> => {
    const nextLanguage = normalizeInterfaceLanguage(language)
    const previousLanguage = currentLanguage.current
    if (nextLanguage === previousLanguage || savingLanguage) return

    const requestId = ++languageRequest.current
    setSavingLanguage(true)
    setLanguageError(false)
    try {
      await i18n.changeLanguage(nextLanguage)
      if (languageRequest.current !== requestId) return
      if (user) {
        const response = await updateUserLanguage(nextLanguage)
        const currentAuth = useAuthStore.getState().auth
        if (
          languageRequest.current !== requestId ||
          currentAuth.user?.id !== user.id ||
          currentAuth.session?.sid !== sessionId
        ) {
          return
        }
        if (!response.success) {
          throw new Error('Language preference was not saved')
        }

        if (currentLanguage.current === nextLanguage) {
          const settings =
            typeof currentAuth.user.setting === 'string'
              ? parseUserSettings(currentAuth.user.setting)
              : (currentAuth.user.setting ?? {})
          currentAuth.setUser({
            ...currentAuth.user,
            setting: JSON.stringify({ ...settings, language: nextLanguage }),
          })
        }
      }
    } catch {
      const currentAuth = useAuthStore.getState().auth
      if (
        languageRequest.current !== requestId ||
        currentAuth.user?.id !== user?.id ||
        currentAuth.session?.sid !== sessionId ||
        currentLanguage.current !== nextLanguage
      ) {
        return
      }
      await i18n.changeLanguage(previousLanguage)
      if (languageRequest.current === requestId) setLanguageError(true)
    } finally {
      if (languageRequest.current === requestId) setSavingLanguage(false)
    }
  }

  const sections = [
    { value: 'general', label: t('General'), icon: Settings2 },
    ...(hasCloud
      ? [{ value: 'cloud', label: t('Codex Cloud'), icon: Cloud }]
      : []),
    {
      value: 'environment',
      label: hasCloud ? t('Docker') : t('Environment'),
      icon: Server,
    },
    { value: 'connections', label: t('Connections'), icon: Plug },
  ]

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className='codex-zcode codex-chatgpt codex-web chatgpt-dialog codex-settings flex max-h-[min(760px,90dvh)] w-[calc(100%-1.5rem)] max-w-[980px] flex-col gap-0 overflow-hidden rounded-2xl p-0 text-sm shadow-2xl sm:max-w-[980px]'
      >
        <header className='border-border flex shrink-0 items-center justify-between border-b px-5 py-4 sm:px-6'>
          <div className='flex min-w-0 items-center gap-3'>
            <DialogTitle className='text-xl leading-7 font-semibold'>
              {t('Settings')}
            </DialogTitle>
            <span className='text-muted-foreground border-border border-l pl-3 text-sm'>
              Codex
            </span>
          </div>
          <DialogClose
            aria-label={t('Close settings')}
            className='text-foreground hover:bg-accent focus-visible:outline-ring flex size-9 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2'
          >
            <X className='size-5' aria-hidden />
          </DialogClose>
        </header>
        <Tabs.Root
          value={section === 'cloud' && !hasCloud ? 'general' : section}
          onValueChange={(value) => {
            if (
              value === 'general' ||
              value === 'cloud' ||
              value === 'environment' ||
              value === 'connections'
            ) {
              setSection(value)
              if (content.current) content.current.scrollTop = 0
            }
          }}
          orientation={isMobile ? 'horizontal' : 'vertical'}
          className='flex min-h-0 flex-1 flex-col sm:min-h-[min(560px,calc(90dvh-76px))] sm:flex-row'
        >
          <Tabs.List
            activateOnFocus
            aria-label={t('Settings navigation')}
            aria-orientation={isMobile ? 'horizontal' : 'vertical'}
            className='border-border bg-muted/35 flex shrink-0 gap-1 overflow-x-auto border-b p-3 sm:w-52 sm:flex-col sm:border-r sm:border-b-0 sm:p-3'
          >
            {sections.map((section) => (
              <Tabs.Tab
                key={section.value}
                value={section.value}
                className='text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring data-active:bg-accent data-active:text-foreground flex min-h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 sm:w-full'
              >
                <section.icon className='size-[18px] shrink-0' aria-hidden />
                {section.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <div
            ref={content}
            className='codex-settings-content min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-8'
          >
            <Tabs.Panel value='general' keepMounted className='outline-none'>
              <h2 className='border-border border-b pb-5 text-lg font-semibold'>
                {t('General')}
              </h2>
              <div className='border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-5'>
                <div className='min-w-0 flex-1 basis-52'>
                  <label htmlFor={appearanceId} className='font-medium'>
                    {t('Appearance')}
                  </label>
                  <p className='text-muted-foreground mt-1 text-xs leading-5'>
                    {t('Choose how Codex looks on this device.')}
                  </p>
                </div>
                <CodexSelect
                  id={appearanceId}
                  label={t('Appearance')}
                  value={theme}
                  options={[
                    { value: 'system', label: t('System') },
                    { value: 'light', label: t('Light') },
                    { value: 'dark', label: t('Dark') },
                  ]}
                  onChange={(value) => {
                    if (
                      value === 'system' ||
                      value === 'light' ||
                      value === 'dark'
                    ) {
                      setTheme(value)
                    }
                  }}
                  compact
                  className='min-w-28 justify-end'
                />
              </div>
              <div
                className='border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-5'
                aria-busy={savingLanguage}
              >
                <div className='min-w-0 flex-1 basis-52'>
                  <label htmlFor={languageId} className='font-medium'>
                    {t('Language')}
                  </label>
                  <p className='text-muted-foreground mt-1 text-xs leading-5'>
                    {t('Choose the language used throughout your account.')}
                  </p>
                </div>
                <div className='flex items-center gap-2'>
                  {savingLanguage && (
                    <span role='status' aria-label={t('Saving...')}>
                      <LoaderCircle
                        className='size-4 animate-spin'
                        aria-hidden
                      />
                    </span>
                  )}
                  <CodexSelect
                    id={languageId}
                    label={t('Language')}
                    value={normalizeInterfaceLanguage(i18n.language)}
                    options={INTERFACE_LANGUAGE_OPTIONS.map((language) => ({
                      value: language.code,
                      label: language.label,
                    }))}
                    onChange={handleLanguageChange}
                    disabled={savingLanguage}
                    compact
                    className='min-w-28 justify-end'
                  />
                </div>
              </div>
              {languageError && (
                <p role='alert' className='text-destructive mt-3 text-sm'>
                  {t('Failed to update settings')}
                </p>
              )}
            </Tabs.Panel>
            {hasCloud && (
              <Tabs.Panel
                value='cloud'
                keepMounted
                className='space-y-5 outline-none'
              >
                {props.cloud ?? (
                  <>
                    <div>
                      <h2 className='text-lg font-semibold'>
                        {t('Codex Cloud')}
                      </h2>
                      <p className='text-muted-foreground mt-2 text-sm leading-6'>
                        {t('Manage the environments used by your cloud tasks.')}
                      </p>
                    </div>
                    {props.onManageEnvironments && (
                      <button
                        type='button'
                        onClick={() => {
                          props.onOpenChange(false)
                          props.onManageEnvironments?.()
                        }}
                        className='border-border hover:bg-accent focus-visible:outline-ring flex min-h-10 items-center gap-2 rounded-lg border px-4 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2'
                      >
                        {t('Manage environments')}
                        <ArrowUpRight className='size-4' aria-hidden />
                      </button>
                    )}
                  </>
                )}
              </Tabs.Panel>
            )}
            <Tabs.Panel
              value='environment'
              keepMounted
              className='outline-none'
            >
              {props.environment ?? (
                <p className='text-muted-foreground'>
                  {t('No environment is available.')}
                </p>
              )}
            </Tabs.Panel>
            <Tabs.Panel
              value='connections'
              keepMounted
              className='space-y-6 outline-none'
            >
              <h2 className='border-border border-b pb-5 text-lg font-semibold'>
                {t('Connections')}
              </h2>
              {props.connections ?? (
                <div className='space-y-5'>
                  <p className='text-muted-foreground text-sm leading-6'>
                    {props.onManageConnections
                      ? t('Connect your development server and GitHub account.')
                      : t('No connections are available.')}
                  </p>
                  {props.onManageConnections && (
                    <button
                      type='button'
                      onClick={() => {
                        props.onOpenChange(false)
                        props.onManageConnections?.()
                      }}
                      className='border-border hover:bg-accent focus-visible:outline-ring flex min-h-10 items-center gap-2 rounded-lg border px-4 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2'
                    >
                      {t('Manage connections')}
                      <ArrowUpRight className='size-4' aria-hidden />
                    </button>
                  )}
                </div>
              )}
            </Tabs.Panel>
          </div>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  )
}
