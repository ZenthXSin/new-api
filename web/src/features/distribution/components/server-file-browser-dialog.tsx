/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, File, Folder, FolderOpen, HardDrive } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { getAppCenterServerFiles } from '../api'
import {
  BROWSER_ROOT,
  displayServerPath,
  joinServerPath,
  parentServerPath,
  readBrowserMemory,
  writeBrowserMemory,
} from '../lib/server-file-browser'

type ServerFileBrowserDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (relPath: string) => void
  selectedPath?: string
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function ServerFileBrowserDialog(props: ServerFileBrowserDialogProps) {
  const { t } = useTranslation()
  const [dir, setDir] = useState('')
  const [selected, setSelected] = useState('')

  useEffect(() => {
    if (!props.open) return
    const rememberedDir = readBrowserMemory()?.dir ?? ''
    setDir(rememberedDir)
    setSelected(
      props.selectedPath &&
        parentServerPath(props.selectedPath) === rememberedDir
        ? props.selectedPath
        : ''
    )
  }, [props.open, props.selectedPath])

  const filesQuery = useQuery({
    queryKey: ['app-center-server-files', dir],
    queryFn: () => getAppCenterServerFiles(dir),
    enabled: props.open,
  })
  const entries = useMemo(() => {
    const items = filesQuery.data?.data ?? []
    return [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [filesQuery.data])

  const navigateTo = (nextDir: string) => {
    setDir(nextDir)
    setSelected('')
    writeBrowserMemory(nextDir, '')
  }
  const chooseFile = (name: string) => {
    const relPath = joinServerPath(dir, name)
    setSelected(relPath)
    writeBrowserMemory(dir, relPath)
  }
  const confirmSelection = () => {
    if (!selected) return
    props.onSelect(selected)
  }

  const crumbs = useMemo(() => {
    if (!dir) return []
    const parts = dir.split('/')
    const result: Array<{ label: string; path: string }> = []
    let acc = ''
    for (const part of parts) {
      acc = joinServerPath(acc, part)
      result.push({ label: part, path: acc })
    }
    return result
  }, [dir])

  let listContent: ReactNode
  if (filesQuery.isLoading) {
    listContent = (
      <li className='text-muted-foreground px-3 py-6 text-center text-sm'>
        {t('Loading')}
      </li>
    )
  } else if (filesQuery.isError) {
    listContent = (
      <li className='text-destructive px-3 py-6 text-center text-sm'>
        {t('Directory does not exist')}
      </li>
    )
  } else if (entries.length === 0) {
    listContent = (
      <li className='text-muted-foreground px-3 py-6 text-center text-sm'>
        {t(
          'No files in this directory. Put packages under /root on the server.'
        )}
      </li>
    )
  } else {
    listContent = entries.map((entry) => (
      <li key={entry.name}>
        {entry.is_dir ? (
          <button
            type='button'
            onClick={() => navigateTo(joinServerPath(dir, entry.name))}
            className='hover:bg-muted flex w-full items-center gap-2 px-3 py-2 text-start'
          >
            <Folder
              className='text-muted-foreground size-4 shrink-0'
              aria-hidden
            />
            <span className='min-w-0 flex-1 truncate'>{entry.name}</span>
          </button>
        ) : (
          <button
            type='button'
            aria-pressed={selected === joinServerPath(dir, entry.name)}
            onClick={() => chooseFile(entry.name)}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-muted',
              selected === joinServerPath(dir, entry.name) && 'bg-muted'
            )}
          >
            <File
              className='text-muted-foreground size-4 shrink-0'
              aria-hidden
            />
            <span className='min-w-0 flex-1 truncate'>{entry.name}</span>
            <span className='text-muted-foreground text-xs tabular-nums'>
              {formatFileSize(entry.size)}
            </span>
          </button>
        )}
      </li>
    ))
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t('Select server file')}
      contentClassName='sm:max-w-xl'
      footer={
        <>
          <Button variant='outline' onClick={() => props.onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button disabled={!selected} onClick={confirmSelection}>
            {t('Choose this file')}
          </Button>
        </>
      }
    >
      <div className='space-y-3'>
        <div className='flex items-center gap-2'>
          {dir ? (
            <Button
              variant='outline'
              size='icon-sm'
              aria-label={t('Parent directory')}
              onClick={() => navigateTo(parentServerPath(dir))}
            >
              <ArrowUp />
            </Button>
          ) : null}
          <nav
            aria-label={t('Select server file')}
            className='bg-muted/50 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md px-1 py-0.5'
          >
            <button
              type='button'
              onClick={() => navigateTo('')}
              className='hover:bg-muted flex shrink-0 items-center gap-1 rounded px-1.5 py-1'
            >
              <HardDrive className='size-3.5' aria-hidden />
              {BROWSER_ROOT}
            </button>
            {crumbs.map((crumb) => (
              <span
                key={crumb.path}
                className='flex min-w-0 shrink-0 items-center gap-0.5'
              >
                <span className='text-muted-foreground'>/</span>
                <button
                  type='button'
                  onClick={() => navigateTo(crumb.path)}
                  className='hover:bg-muted max-w-32 truncate rounded px-1.5 py-1'
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <ul className='divide-border max-h-64 divide-y overflow-y-auto rounded-md border'>
          {listContent}
        </ul>
        <div className='text-muted-foreground flex items-center justify-between gap-3 text-xs'>
          <span className='flex min-w-0 items-center gap-1.5'>
            <FolderOpen className='size-3.5 shrink-0' aria-hidden />
            <span className='truncate'>{displayServerPath(dir)}</span>
          </span>
          {selected ? (
            <span className='text-foreground min-w-0 truncate font-medium'>
              {selected}
            </span>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
