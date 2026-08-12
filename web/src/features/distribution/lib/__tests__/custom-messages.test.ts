/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  formatMessageTime,
  getMessagePageBounds,
  joinMessageRegion,
  MESSAGE_PAGE_SIZE,
} from '../../api'

process.env.TZ = 'UTC'

test('joinMessageRegion joins non-empty parts and returns an empty string when all are empty', () => {
  assert.equal(
    joinMessageRegion({ country: 'US', region: 'California', city: 'San Francisco' }),
    'US / California / San Francisco'
  )
  assert.equal(joinMessageRegion({ country: 'US', region: '', city: '' }), 'US')
  assert.equal(joinMessageRegion({ country: '', region: '', city: 'Tokyo' }), 'Tokyo')
  assert.equal(joinMessageRegion({ country: '', region: '', city: '' }), '')
  assert.equal(joinMessageRegion({ country: '  ', region: 'CA', city: '' }), 'CA')
})

test('formatMessageTime renders a seconds timestamp as local wall-clock time', () => {
  assert.equal(formatMessageTime(1700000000), '2023-11-14 22:13:20')
})

test('formatMessageTime renders a placeholder for zero or missing timestamps', () => {
  assert.equal(formatMessageTime(0), '-')
})

test('getMessagePageBounds reports the previous and next page availability', () => {
  assert.deepEqual(getMessagePageBounds(0, 1, MESSAGE_PAGE_SIZE), {
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
  })
  assert.deepEqual(getMessagePageBounds(120, 1, MESSAGE_PAGE_SIZE), {
    totalPages: 3,
    hasPrevious: false,
    hasNext: true,
  })
  assert.deepEqual(getMessagePageBounds(120, 2, MESSAGE_PAGE_SIZE), {
    totalPages: 3,
    hasPrevious: true,
    hasNext: true,
  })
  assert.deepEqual(getMessagePageBounds(120, 3, MESSAGE_PAGE_SIZE), {
    totalPages: 3,
    hasPrevious: true,
    hasNext: false,
  })
  assert.deepEqual(getMessagePageBounds(100, 2, MESSAGE_PAGE_SIZE), {
    totalPages: 2,
    hasPrevious: true,
    hasNext: false,
  })
})
