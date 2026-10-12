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
import { createInstance } from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { expect, test } from 'vitest'

import { convertDetectedLanguage } from '../languages'
import { localeBackend } from '../locale-backend'
import en from '../locales/en.json'
import fr from '../locales/fr.json'
import zhTW from '../locales/zh-TW.json'

test('a saved Traditional Chinese preference survives browser language detection', async () => {
  const previous = localStorage.getItem('i18nextLng')
  localStorage.setItem('i18nextLng', 'zhTW')
  try {
    const instance = createInstance()
    await instance
      .use(LanguageDetector)
      .use(localeBackend)
      .init({
        fallbackLng: 'en',
        supportedLngs: ['en', 'zhCN', 'zhTW'],
        resources: { en },
        partialBundledLanguages: true,
        detection: {
          order: ['localStorage'],
          caches: [],
          convertDetectedLanguage,
        },
      })
    expect(instance.resolvedLanguage).toBe('zhTW')
    expect(instance.t('Describe your coding task')).toBe(
      zhTW.translation['Describe your coding task']
    )
  } finally {
    if (previous === null) localStorage.removeItem('i18nextLng')
    else localStorage.setItem('i18nextLng', previous)
  }
})

test('a selected language loads before translations are shown and switching retains fallback English', async () => {
  const instance = createInstance()
  await instance.use(localeBackend).init({
    lng: 'fr',
    fallbackLng: 'en',
    resources: { en },
    partialBundledLanguages: true,
    nsSeparator: false,
  })
  expect(instance.resolvedLanguage).toBe('fr')
  expect(instance.t('Codex management')).toBe(
    fr.translation['Codex management']
  )
  await instance.changeLanguage('zhTW')
  expect(instance.t('Codex management')).toBe(
    zhTW.translation['Codex management']
  )
  await instance.changeLanguage('en')
  expect(instance.t('Codex management')).toBe('Codex management')
  await instance.changeLanguage('fr')
  expect(instance.t('Codex management')).toBe(
    fr.translation['Codex management']
  )
})
