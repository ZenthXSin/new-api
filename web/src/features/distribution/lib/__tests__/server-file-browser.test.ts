/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

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

class MemoryStorage {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

function installStorage() {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  return storage
}

after(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
})

test('normalizeServerPath strips the browser root and edge slashes', () => {
  assert.equal(normalizeServerPath(''), '')
  assert.equal(normalizeServerPath('/root'), '')
  assert.equal(normalizeServerPath('/root/'), '')
  assert.equal(normalizeServerPath('/root/sub'), 'sub')
  assert.equal(normalizeServerPath('/root/sub/'), 'sub')
  assert.equal(normalizeServerPath('sub/a.bin'), 'sub/a.bin')
})

test('normalizeServerPath rejects traversal and absolute paths outside the root', () => {
  assert.equal(normalizeServerPath('/root/../etc'), null)
  assert.equal(normalizeServerPath('../etc'), null)
  assert.equal(normalizeServerPath('a/../b'), null)
  assert.equal(normalizeServerPath('/etc'), null)
})

test('joinServerPath joins a directory and a name', () => {
  assert.equal(joinServerPath('', 'x'), 'x')
  assert.equal(joinServerPath('sub', 'x'), 'sub/x')
})

test('parentServerPath returns the parent directory', () => {
  assert.equal(parentServerPath(''), '')
  assert.equal(parentServerPath('a'), '')
  assert.equal(parentServerPath('a/b'), 'a')
  assert.equal(parentServerPath('a/b/c'), 'a/b')
})

test('displayServerPath renders the absolute display path', () => {
  assert.equal(displayServerPath(''), '/root')
  assert.equal(displayServerPath('a'), '/root/a')
})

test('writeBrowserMemory then readBrowserMemory round-trips dir and selected', () => {
  installStorage()
  writeBrowserMemory('sub', 'a.bin')
  assert.deepEqual(readBrowserMemory(), { dir: 'sub', selected: 'a.bin' })
})

test('readBrowserMemory returns null for unparsable or invalid stored JSON', () => {
  const storage = installStorage()
  storage.setItem(BROWSER_STORAGE_KEY, 'not-json{')
  assert.equal(readBrowserMemory(), null)
  storage.setItem(
    BROWSER_STORAGE_KEY,
    JSON.stringify({ dir: '../etc', selected: '' })
  )
  assert.equal(readBrowserMemory(), null)
  storage.setItem(BROWSER_STORAGE_KEY, JSON.stringify({ dir: 42 }))
  assert.equal(readBrowserMemory(), null)
})

test('clearBrowserSelection keeps the remembered dir and clears selected', () => {
  installStorage()
  writeBrowserMemory('sub', 'a.bin')
  clearBrowserSelection()
  assert.deepEqual(readBrowserMemory(), { dir: 'sub', selected: '' })
})

test('clearBrowserSelection with no stored memory is a no-op', () => {
  installStorage()
  assert.doesNotThrow(() => clearBrowserSelection())
  assert.equal(readBrowserMemory(), null)
})
