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
import type { BackendModule } from 'i18next'

// The two common languages are bundled by config.ts. Load each remaining
// translation only when selected, using the same versioned asset as the app.
const loaders: Record<
  string,
  () => Promise<{ default: { translation: Record<string, unknown> } }>
> = {
  fr: () => import('./locales/fr.json'),
  ja: () => import('./locales/ja.json'),
  ru: () => import('./locales/ru.json'),
  vi: () => import('./locales/vi.json'),
  zhTW: () => import('./locales/zh-TW.json'),
}

export const localeBackend: BackendModule = {
  type: 'backend',
  init() {},
  async read(language, namespace) {
    const load = loaders[language]
    if (!load || namespace !== 'translation') {
      return {}
    }
    return (await load()).default.translation
  },
}
