/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { expect, test } from 'vitest'

import {
  formatMessageTime,
  getMessagePageBounds,
  joinMessageRegion,
  MESSAGE_PAGE_SIZE,
} from '../../api'

process.env.TZ = 'UTC'

test('joinMessageRegion joins non-empty parts and returns an empty string when all are empty', () => {
  expect(
    joinMessageRegion({ country: 'US', region: 'California', city: 'San Francisco' })
  ).toBe('US / California / San Francisco')
  expect(joinMessageRegion({ country: 'US', region: '', city: '' })).toBe('US')
  expect(joinMessageRegion({ country: '', region: '', city: 'Tokyo' })).toBe('Tokyo')
  expect(joinMessageRegion({ country: '', region: '', city: '' })).toBe('')
  expect(joinMessageRegion({ country: '  ', region: 'CA', city: '' })).toBe('CA')
})

test('formatMessageTime renders a seconds timestamp as local wall-clock time', () => {
  expect(formatMessageTime(1700000000)).toBe('2023-11-14 22:13:20')
})

test('formatMessageTime renders a placeholder for zero or missing timestamps', () => {
  expect(formatMessageTime(0)).toBe('-')
})

test('getMessagePageBounds reports the previous and next page availability', () => {
  expect(getMessagePageBounds(0, 1, MESSAGE_PAGE_SIZE)).toEqual({
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  })
  expect(getMessagePageBounds(120, 1, MESSAGE_PAGE_SIZE)).toEqual({
    totalPages: 3,
    hasPrevious: false,
    hasNext: true,
  })
  expect(getMessagePageBounds(120, 2, MESSAGE_PAGE_SIZE)).toEqual({
    totalPages: 3,
    hasPrevious: true,
    hasNext: true,
  })
  expect(getMessagePageBounds(120, 3, MESSAGE_PAGE_SIZE)).toEqual({
    totalPages: 3,
    hasPrevious: true,
    hasNext: false,
  })
  expect(getMessagePageBounds(100, 2, MESSAGE_PAGE_SIZE)).toEqual({
    totalPages: 2,
    hasPrevious: true,
    hasNext: false,
  })
})