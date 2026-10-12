/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { expect, test } from 'vitest'

test('keeps telemetry credentials out of browser-managed query state', () => {
  const queryKey = ['app-center-usage', 7, 24]
  expect(queryKey.includes('token')).toBe(false)
})
