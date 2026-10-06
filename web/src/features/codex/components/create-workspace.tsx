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
import { zodResolver } from '@hookform/resolvers/zod'
import { Check, FolderPlus, GitBranch, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { codexError } from '../api'

const projectSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Enter a project name.')
      .max(120, 'Project names can contain up to 120 characters.'),
    source: z.enum(['blank', 'git']),
    repository: z.string().trim().max(2048, 'Repository URL is too long.'),
  })
  .superRefine((value, context) => {
    if (value.source !== 'git') return
    try {
      const url = new URL(value.repository)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.port && url.port !== '443') ||
        url.pathname === '/'
      ) {
        throw new Error('invalid_repository')
      }
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['repository'],
        message:
          'Enter a public HTTPS repository URL without credentials or query parameters.',
      })
    }
  })
type ProjectForm = z.infer<typeof projectSchema>

export function CreateWorkspaceDialog(props: {
  open: boolean
  onClose: () => void
  onCreate: (title: string, repository?: string) => Promise<void>
  disabled?: boolean
  initialSource?: 'blank' | 'git'
}) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const form = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: { title: '', source: 'blank', repository: '' },
  })
  const source = form.watch('source')
  const busy = form.formState.isSubmitting
  const wasOpen = useRef(false)
  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setError('')
      form.setValue('source', props.initialSource ?? 'blank')
    }
    wasOpen.current = props.open
  }, [props.open, props.initialSource, form])
  async function create(values: ProjectForm) {
    if (props.disabled) return
    setError('')
    try {
      await props.onCreate(
        values.title,
        values.source === 'git' ? values.repository : undefined
      )
      form.reset()
      props.onClose()
    } catch (cause) {
      setError(codexError(cause))
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose()
      }}
    >
      <DialogContent
        className='max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl p-5 sm:max-w-lg sm:p-6'
        showCloseButton={!busy}
      >
        <form
          onSubmit={form.handleSubmit(create)}
          className='space-y-5'
          noValidate
        >
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2 font-sans'>
              <FolderPlus className='size-5' aria-hidden />
              {t('New project')}
            </DialogTitle>
            <DialogDescription>
              {t('Start from scratch or bring an existing repository.')}
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={busy || props.disabled}
            className='grid grid-cols-2 gap-3'
          >
            <legend className='sr-only'>{t('Project source')}</legend>
            {[
              {
                value: 'blank' as const,
                label: t('Blank project'),
                description: t('Start with an empty folder'),
                Icon: FolderPlus,
              },
              {
                value: 'git' as const,
                label: t('Import repository'),
                description: t('Clone a public Git repository'),
                Icon: GitBranch,
              },
            ].map((option) => (
              <label
                key={option.value}
                className={cn(
                  'relative cursor-pointer rounded-xl border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
                  source === option.value
                    ? 'border-foreground/40 bg-muted/60'
                    : 'hover:bg-muted/30',
                  (busy || props.disabled) && 'cursor-default opacity-60'
                )}
              >
                <input
                  type='radio'
                  className='sr-only'
                  value={option.value}
                  {...form.register('source')}
                />
                <option.Icon
                  className='text-muted-foreground mb-3 size-5'
                  aria-hidden
                />
                {source === option.value && (
                  <Check
                    className='absolute top-3 right-3 size-4'
                    aria-hidden
                  />
                )}
                <span className='block text-sm font-medium'>
                  {option.label}
                </span>
                <span className='text-muted-foreground mt-1 block text-xs leading-5'>
                  {option.description}
                </span>
              </label>
            ))}
          </fieldset>
          <div className='space-y-2'>
            <label htmlFor='codex-project-name' className='text-sm font-medium'>
              {t('Project name')}
            </label>
            <Input
              id='codex-project-name'
              autoFocus
              className='h-10 text-base md:text-sm'
              disabled={busy}
              placeholder={t('My project')}
              maxLength={120}
              aria-invalid={!!form.formState.errors.title}
              aria-describedby={
                form.formState.errors.title
                  ? 'codex-project-name-error'
                  : undefined
              }
              {...form.register('title')}
            />
            {form.formState.errors.title && (
              <p
                role='alert'
                id='codex-project-name-error'
                className='text-destructive text-xs'
              >
                {t(form.formState.errors.title.message || '')}
              </p>
            )}
          </div>
          {source === 'git' ? (
            <div className='space-y-2'>
              <label
                htmlFor='codex-project-repository'
                className='text-sm font-medium'
              >
                {t('Repository URL')}
              </label>
              <Input
                id='codex-project-repository'
                type='url'
                inputMode='url'
                className='h-10 text-base md:text-sm'
                disabled={busy}
                placeholder='https://github.com/owner/project.git'
                aria-label={t('Repository URL')}
                aria-invalid={!!form.formState.errors.repository}
                aria-describedby={
                  form.formState.errors.repository
                    ? 'codex-project-repository-error'
                    : 'codex-project-repository-help'
                }
                {...form.register('repository')}
              />
              <p
                id='codex-project-repository-help'
                className='text-muted-foreground text-xs leading-5'
              >
                {t(
                  'Public HTTPS repositories only. Private repositories are not supported yet.'
                )}
              </p>
              {form.formState.errors.repository && (
                <p
                  role='alert'
                  id='codex-project-repository-error'
                  className='text-destructive text-xs'
                >
                  {t(form.formState.errors.repository.message || '')}
                </p>
              )}
            </div>
          ) : (
            <p className='text-muted-foreground bg-muted/40 rounded-lg px-3 py-2.5 text-xs leading-5'>
              {t(
                'You can create files or upload a ZIP after opening the project.'
              )}
            </p>
          )}
          {error && (
            <p
              role='alert'
              className='text-destructive bg-destructive/5 rounded-lg px-3 py-2.5 text-sm break-words'
            >
              {t(error)}
            </p>
          )}
          {props.disabled && (
            <p role='status' className='text-muted-foreground text-xs'>
              {t(
                'Project creation is paused while your environment is busy or unavailable.'
              )}
            </p>
          )}
          {busy && (
            <p
              role='status'
              className='text-muted-foreground flex items-center gap-2 text-xs'
            >
              <LoaderCircle className='size-3.5 animate-spin' aria-hidden />
              {source === 'git'
                ? t('Importing repository. This may take a moment.')
                : t('Creating project...')}
            </p>
          )}
          <DialogFooter className='border-t pt-4'>
            <Button
              type='button'
              variant='ghost'
              className='h-10'
              disabled={busy}
              onClick={props.onClose}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='submit'
              className='h-10'
              disabled={busy || props.disabled}
            >
              {busy && (
                <LoaderCircle className='size-4 animate-spin' aria-hidden />
              )}
              {t('Create project')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
