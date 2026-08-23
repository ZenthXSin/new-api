/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { beforeEach, expect, test } from 'vitest'

import {
  BROWSER_STORAGE_KEY,
  clearBrowserSelection,
  displayServerPath,
  joinServerPath,
  normalizeServerPath,
  parentServerPath,
  readBrowserMemory,
  writeBrowserMemory,
} from '../server-file-browser'

beforeEach(() => {
  localStorage.clear()
})

test('normalizeServerPath strips the browser root and edge slashes', () => {
  expect(normalizeServerPath('')).toBe('')
  expect(normalizeServerPath('/root')).toBe('')
  expect(normalizeServerPath('/root/')).toBe('')
  expect(normalizeServerPath('/root/sub')).toBe('sub')
  expect(normalizeServerPath('/root/sub/')).toBe('sub')
  expect(normalizeServerPath('sub/a.bin')).toBe('sub/a.bin')
})

test('normalizeServerPath rejects traversal and absolute paths outside the root', () => {
  expect(normalizeServerPath('/root/../etc')).toBe(null)
  expect(normalizeServerPath('../etc')).toBe(null)
  expect(normalizeServerPath('a/../b')).toBe(null)
  expect(normalizeServerPath('/etc')).toBe(null)
})

test('joinServerPath joins a directory and a name', () => {
  expect(joinServerPath('', 'x')).toBe('x')
  expect(joinServerPath('sub', 'x')).toBe('sub/x')
})

test('parentServerPath returns the parent directory', () => {
  expect(parentServerPath('')).toBe('')
  expect(parentServerPath('a')).toBe('')
  expect(parentServerPath('a/b')).toBe('a')
  expect(parentServerPath('a/b/c')).toBe('a/b')
})

test('displayServerPath renders the absolute display path', () => {
  expect(displayServerPath('')).toBe('/root')
  expect(displayServerPath('a')).toBe('/root/a')
})

test('writeBrowserMemory then readBrowserMemory round-trips dir and selected', () => {
  writeBrowserMemory('sub', 'a.bin')
  expect(readBrowserMemory()).toEqual({ dir: 'sub', selected: 'a.bin' })
})

test('readBrowserMemory returns null for unparsable or invalid stored JSON', () => {
  localStorage.setItem(BROWSER_STORAGE_KEY, 'not-json{')
  expect(readBrowserMemory()).toBe(null)
  localStorage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({ dir: '../etc', selected: '' })
  )
  expect(readBrowserMemory()).toBe(null)
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify({ dir: 42 }))
  expect(readBrowserMemory()).toBe(null)
})

test('clearBrowserSelection keeps the remembered dir and clears selected', () => {
  writeBrowserMemory('sub', 'a.bin')
  clearBrowserSelection()
  expect(readBrowserMemory()).toEqual({ dir: 'sub', selected: '' })
})

test('clearBrowserSelection with no stored memory is a no-op', () => {
  expect(() => clearBrowserSelection()).not.toThrow()
  expect(readBrowserMemory()).toBe(null)
})