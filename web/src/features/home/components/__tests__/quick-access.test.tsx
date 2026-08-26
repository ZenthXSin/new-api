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
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { AnnouncementItem } from '@/features/dashboard/types'

const statusDataState = vi.hoisted(() => ({
  items: [] as AnnouncementItem[],
  loading: false,
}))

vi.mock('@/features/dashboard/hooks/use-status-data', () => ({
  useStatusData: () => statusDataState,
  useAnnouncements: () => statusDataState,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: (props: { to: string; className?: string; children?: ReactNode }) => (
    <a href={props.to} className={props.className}>
      {props.children}
    </a>
  ),
}))

const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { QuickAccess } = await import('../sections/quick-access')

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'Quick Access': 'Quick Access',
        'Download Center': 'Download Center',
        'Get the latest installers, release notes and announcements':
          'Get the latest installers, release notes and announcements',
        Announcements: 'Announcements',
        'No announcements yet': 'No announcements yet',
      },
    },
  },
})

function renderQuickAccess() {
  return render(
    <I18nextProvider i18n={i18n}>
      <QuickAccess />
    </I18nextProvider>
  )
}

function announcement(content: string): AnnouncementItem {
  return {
    id: content.length,
    content,
    publishDate: '2026-08-01T08:00:00Z',
    type: 'default',
  }
}

describe('home quick access section', () => {
  test('renders both portal cards with a link to /downloads', () => {
    statusDataState.items = []
    statusDataState.loading = false

    renderQuickAccess()

    const downloadLink = screen.getByRole('link', { name: /Download Center/ })
    expect(downloadLink).toHaveAttribute('href', '/downloads')
    expect(
      screen.getByText(
        'Get the latest installers, release notes and announcements'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Announcements' })
    ).toBeInTheDocument()
  })

  test('shows only the first three announcements with their publish dates', () => {
    statusDataState.items = [
      announcement('First announcement'),
      announcement('Second announcement'),
      announcement('Third announcement'),
      announcement('Fourth announcement'),
    ]
    statusDataState.loading = false

    renderQuickAccess()

    expect(screen.getByText('First announcement')).toBeInTheDocument()
    expect(screen.getByText('Second announcement')).toBeInTheDocument()
    expect(screen.getByText('Third announcement')).toBeInTheDocument()
    expect(screen.queryByText('Fourth announcement')).not.toBeInTheDocument()

    const timeNodes = document.querySelectorAll('time')
    expect(timeNodes).toHaveLength(3)
    for (const node of timeNodes) {
      expect(node).toHaveAttribute('dateTime', '2026-08-01T08:00:00Z')
    }
  })

  test('shows the empty placeholder when announcements are disabled or empty', () => {
    statusDataState.items = []
    statusDataState.loading = false

    renderQuickAccess()

    expect(screen.getByText('No announcements yet')).toBeInTheDocument()
    expect(document.querySelector('time')).toBeNull()
  })

  test('renders without crashing while the status data is loading', () => {
    statusDataState.items = []
    statusDataState.loading = true

    renderQuickAccess()

    expect(
      screen.getByRole('link', { name: /Download Center/ })
    ).toHaveAttribute('href', '/downloads')
    expect(screen.queryByText('No announcements yet')).not.toBeInTheDocument()
  })
})
