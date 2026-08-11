/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
export const BROWSER_ROOT = '/root'
export const BROWSER_STORAGE_KEY = 'app-center-server-file-browser'

export type BrowserMemory = {
  dir: string
  selected: string
}

export function normalizeServerPath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return ''
  let rel = trimmed
  if (rel === BROWSER_ROOT || rel.startsWith(`${BROWSER_ROOT}/`)) {
    rel = rel.slice(BROWSER_ROOT.length)
  } else if (rel.startsWith('/')) {
    // Absolute path outside the browser root cannot be expressed as a
    // relative path under BROWSER_ROOT.
    return null
  }
  rel = rel.replaceAll(/^\/+|\/+$/g, '')
  if (!rel) return ''
  const segments = rel.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
  }
  return rel
}

export function joinServerPath(dir: string, name: string): string {
  if (!dir) return name
  return `${dir}/${name}`
}

export function parentServerPath(path: string): string {
  if (!path) return ''
  const slashIndex = path.lastIndexOf('/')
  if (slashIndex <= 0) return ''
  return path.slice(0, slashIndex)
}

export function displayServerPath(path: string): string {
  if (!path) return BROWSER_ROOT
  return `${BROWSER_ROOT}/${path}`
}

export function readBrowserMemory(): BrowserMemory | null {
  try {
    const raw = localStorage.getItem(BROWSER_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { dir?: unknown; selected?: unknown }
    if (
      typeof candidate.dir !== 'string' ||
      typeof candidate.selected !== 'string'
    ) {
      return null
    }
    const dir = normalizeServerPath(candidate.dir)
    if (dir === null) return null
    const selected =
      candidate.selected === '' ? '' : normalizeServerPath(candidate.selected)
    if (selected === null) return null
    return { dir, selected }
  } catch {
    return null
  }
}

export function writeBrowserMemory(dir: string, selected: string): void {
  localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify({ dir, selected }))
}

export function clearBrowserSelection(): void {
  const memory = readBrowserMemory()
  if (!memory) return
  writeBrowserMemory(memory.dir, '')
}
