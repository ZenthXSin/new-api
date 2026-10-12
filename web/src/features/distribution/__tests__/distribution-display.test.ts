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
import { expect, test } from 'vitest'

import { formatDistributionDate } from '../distribution-display'

test('formats distribution dates for project interface language codes', () => {
  expect(() =>
    formatDistributionDate('2026-08-08T15:37:09+08:00', 'zhCN', 'medium')
  ).not.toThrow()
  expect(() =>
    formatDistributionDate('2026-08-08T15:37:09+08:00', 'zhTW', 'medium')
  ).not.toThrow()
  expect(
    formatDistributionDate('2026-08-08T15:37:09+08:00', 'zhCN', 'medium')
  ).toMatch(/2026/)
})
