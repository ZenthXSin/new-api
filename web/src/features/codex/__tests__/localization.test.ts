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
import { expect, test } from 'vitest'

import en from '@/i18n/locales/en.json'
import fr from '@/i18n/locales/fr.json'
import ja from '@/i18n/locales/ja.json'
import ru from '@/i18n/locales/ru.json'
import vi from '@/i18n/locales/vi.json'
import zhTW from '@/i18n/locales/zh-TW.json'
import zh from '@/i18n/locales/zh.json'

test.each([
  { language: 'en', resource: en, title: 'New conversation' },
  { language: 'zh', resource: zh, title: '新对话' },
  { language: 'zh-TW', resource: zhTW, title: '新增對話' },
  { language: 'fr', resource: fr, title: 'Nouvelle conversation' },
  { language: 'ru', resource: ru, title: 'Новый диалог' },
  { language: 'ja', resource: ja, title: '新しい会話' },
  { language: 'vi', resource: vi, title: 'Cuộc trò chuyện mới' },
])(
  'conversation controls are translated in $language without fallback',
  async (entry) => {
    const i18n = createInstance()
    await i18n.init({
      lng: entry.language,
      fallbackLng: false,
      resources: {
        [entry.language]: { translation: entry.resource.translation },
      },
    })
    expect(i18n.t('New conversation')).toBe(entry.title)
    for (const key of [
      'Projects',
      'Auto approve',
      'Full access',
      'Manage projects and conversations',
      'Archive selected',
      'Restore selected',
      'Delete selected',
      'Conversations',
      'Rename conversation',
      'Delete conversation?',
      'Delete conversation',
      'Archive conversation',
      'Restore conversation',
      'Conversation name',
      'Choose a name that helps you find this conversation.',
      'This deletes this conversation and its history. Project files and other conversations are kept.',
      'Restore this conversation to continue.',
      'Expand project {{name}}',
      'Collapse project {{name}}',
      'New conversation in {{name}}',
      'Conversation actions for {{name}}',
      'Show archived conversations',
      'Show active conversations',
      'No conversations yet.',
      'No archived conversations.',
      'Loading conversations...',
      'Conversations could not be loaded.',
      'Edit files and run commands',
      'Explore your project without changing files',
      'Queue message',
      'Start parallel task',
      'Interrupt and send',
      'Queued messages',
      'Queued messages ({{count}})',
      'Cancel queued message',
      'Cancel queued message: {{prompt}}',
      'Resume queued message',
      'Resume queued message: {{prompt}}',
      'Upload files',
      'Uploaded files',
      'Remove attachment {{name}}',
      'Conversation {{number}}',
    ]) {
      expect(i18n.exists(key), `${entry.language}: ${key}`).toBe(true)
    }
    expect(i18n.t('Expand project {{name}}', { name: 'Example' })).toContain(
      'Example'
    )
    expect(
      i18n.t('Expand project {{name}}', { name: 'Example' })
    ).not.toContain('{{')
  }
)

const codexModeTranslations = [
  ['What do you want to build?', '你想构建什么？'],
  ['Do anything', '执行任务'],
  ['Approval mode', '审批模式'],
  ['Request approval', '请求批准'],
  ['Read-only', '只读'],
  ['Cloud', '云端'],
  ['Work in', '运行位置'],
  ['Published environments', '已发布环境'],
  ['Create environment', '创建环境'],
  ['Manage environments', '管理环境'],
  ['Local environment', '本地环境'],
  ['Repositories', '仓库'],
  ['Search repositories', '搜索仓库'],
  ['Private repository', '私有仓库'],
  ['Show archived tasks', '显示已归档任务'],
] as const

test('Codex task, approval, and environment controls switch from Chinese to English', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zhCN',
    fallbackLng: 'en',
    nsSeparator: false,
    resources: { en, zhCN: zh },
  })

  for (const [key, translation] of codexModeTranslations) {
    expect(i18n.t(key), key).toBe(translation)
  }

  await i18n.changeLanguage('en')

  for (const [key] of codexModeTranslations) {
    expect(i18n.exists(key), key).toBe(true)
    expect(i18n.t(key), key).toBe(key)
  }
})

test('Chinese task and environment labels preserve names, counts, and versions', async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zhCN',
    fallbackLng: false,
    nsSeparator: false,
    resources: { zhCN: zh },
  })

  expect(i18n.t('Task options for {{title}}', { title: '接口重构' })).toBe(
    '任务“接口重构”的选项'
  )
  expect(i18n.t('{{count}} selected', { count: 3 })).toBe('已选择 3 项')
  expect(i18n.t('Version {{version}}', { version: 2 })).toBe('版本 2')
})
