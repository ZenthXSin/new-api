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
import { useQuery } from '@tanstack/react-query'
import { FolderPlus, GitBranch, LoaderCircle, Server, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/features/codex/vendor/zcode/utils'

import { codexApi, codexError } from '../api'
import type { CodexCreateInput, CodexSshConnection } from '../types'
import { Button } from '../vendor/zcode/button'
import { CodexSelect } from './select'

const projectSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Enter a project name.')
      .max(120, 'Project names can contain up to 120 characters.'),
    source: z.enum(['blank', 'git', 'ssh', 'host']),
    repository: z.string().trim(),
    branch: z.string().trim(),
    connection: z.string(),
    remotePath: z.string().trim(),
  })
  .superRefine((value, context) => {
    if (value.source === 'ssh' || value.source === 'host') {
      if (value.source === 'ssh' && !value.connection) {
        context.addIssue({
          code: 'custom',
          path: ['connection'],
          message: 'Choose a remote server.',
        })
      }
      if (
        !value.remotePath.startsWith('/') ||
        value.remotePath === '/' ||
        value.remotePath.length > 1024 ||
        [...value.remotePath].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ) ||
        value.remotePath
          .split('/')
          .some((part) => part === '..' || part === '.')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['remotePath'],
          message:
            value.source === 'host'
              ? 'Enter an absolute host project directory.'
              : 'Enter an absolute remote project directory.',
        })
      }
    }
    if (value.source !== 'git') return
    if (
      value.branch &&
      (value.branch.length > 200 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value.branch) ||
        value.branch.includes('..') ||
        value.branch.includes('//') ||
        value.branch.endsWith('/') ||
        value.branch.endsWith('.lock'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['branch'],
        message: 'Enter a valid repository branch (up to 200 characters).',
      })
    }
    if (value.repository.length > 2048) {
      context.addIssue({
        code: 'custom',
        path: ['repository'],
        message: 'Repository URL is too long.',
      })
      return
    }
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
  onCreate: (input: CodexCreateInput) => Promise<void>
  connections?: CodexSshConnection[]
  actor?: string
  onManageConnections?: () => void
  disabled?: boolean
  allowHost?: boolean
  initialSource?: 'blank' | 'git' | 'ssh' | 'host'
}) {
  const { t } = useTranslation()
  const [error, setError] = useState('')
  const form = useForm<ProjectForm>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      title: '',
      source: props.initialSource ?? 'blank',
      repository: '',
      branch: '',
      connection: '',
      remotePath: '',
    },
  })
  const source = form.watch('source')
  const [repositoryPage, setRepositoryPage] = useState(1)
  const nameInput = useRef<HTMLInputElement>(null)
  const errorMessage = useRef<HTMLParagraphElement>(null)
  const resumeDraft = useRef(false)
  const creating = useRef(false)
  const github = useQuery({
    queryKey: ['codex', 'github', props.actor],
    queryFn: ({ signal }) => codexApi.githubStatus(signal),
    enabled: props.open && source === 'git',
    retry: false,
  })
  const repositories = useQuery({
    queryKey: ['codex', 'github', props.actor, 'repositories', repositoryPage],
    queryFn: ({ signal }) =>
      codexApi.githubRepositories(repositoryPage, signal),
    enabled: props.open && source === 'git' && github.data?.connected === true,
    retry: false,
  })
  const busy = form.formState.isSubmitting
  const unavailable = busy || props.disabled
  const nameField = form.register('title')
  const wasOpen = useRef(false)
  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setError('')
      form.clearErrors()
      if (!resumeDraft.current) {
        form.setValue('source', props.initialSource ?? 'blank')
        setRepositoryPage(1)
      }
      resumeDraft.current = false
    }
    wasOpen.current = props.open
  }, [props.open, props.initialSource, form])
  useEffect(() => {
    if (props.open && error && !busy) errorMessage.current?.focus()
  }, [props.open, error, busy])

  function close(): void {
    if (busy || creating.current) return
    resumeDraft.current = false
    form.reset()
    setError('')
    props.onClose()
  }

  async function create(values: ProjectForm): Promise<void> {
    if (props.disabled || creating.current) return
    setError('')
    if (
      values.source === 'ssh' &&
      !props.connections?.some((entry) => entry.id === values.connection)
    ) {
      form.setError('connection', { message: 'Choose a remote server.' })
      return
    }
    if (values.source === 'host' && !props.allowHost) return
    creating.current = true
    try {
      await props.onCreate({
        name: values.title,
        ...(values.source === 'host'
          ? { host: { path: values.remotePath } }
          : {}),
        ...(values.source === 'git'
          ? {
              repositoryUrl: values.repository,
              ...(values.branch ? { branch: values.branch } : {}),
            }
          : {}),
        ...(values.source === 'ssh'
          ? {
              remote: {
                connectionId: values.connection,
                path: values.remotePath,
              },
            }
          : {}),
      })
      form.reset()
      props.onClose()
    } catch (cause) {
      setError(codexError(cause))
    } finally {
      creating.current = false
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className='codex-zcode codex-chatgpt chatgpt-dialog codex-create-dialog bg-background ring-foreground/10 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-3xl border-0 p-6 shadow-2xl ring-1 sm:max-w-[520px] sm:p-7'
        showCloseButton={false}
        initialFocus={nameInput}
      >
        <form
          onSubmit={form.handleSubmit(create)}
          className='space-y-6'
          noValidate
          aria-busy={busy}
        >
          <DialogHeader className='gap-2 pr-9'>
            <DialogTitle className='font-sans text-xl leading-7 font-semibold tracking-tight'>
              {t('New project')}
            </DialogTitle>
            <DialogDescription className='text-sm leading-6'>
              {t('Start from scratch or bring an existing repository.')}
            </DialogDescription>
          </DialogHeader>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='focus-visible:ring-ring absolute top-5 right-5 size-9 rounded-full focus-visible:ring-2'
            aria-label={t('Close')}
            disabled={busy}
            onClick={close}
          >
            <X className='size-5' aria-hidden />
          </Button>
          <div className='space-y-2.5'>
            <label htmlFor='codex-project-name' className='text-sm font-medium'>
              {t('Project name')}
            </label>
            <Input
              id='codex-project-name'
              className='border-border h-12 rounded-xl bg-transparent px-4 text-base focus-visible:ring-1 md:text-base'
              disabled={unavailable}
              placeholder={t('My project')}
              maxLength={120}
              autoComplete='off'
              aria-invalid={!!form.formState.errors.title}
              aria-describedby={
                form.formState.errors.title
                  ? 'codex-project-name-error'
                  : undefined
              }
              {...nameField}
              ref={(element) => {
                nameField.ref(element)
                nameInput.current = element
              }}
            />
            {form.formState.errors.title && (
              <p
                role='alert'
                id='codex-project-name-error'
                className='text-destructive text-xs leading-5'
              >
                {t(form.formState.errors.title.message || '')}
              </p>
            )}
          </div>
          <fieldset disabled={unavailable} className='min-w-0'>
            <legend className='mb-2.5 text-sm font-medium'>
              {t('Project source')}
            </legend>
            <div
              className={cn(
                'bg-muted/70 grid gap-1 rounded-2xl p-1',
                props.allowHost ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'
              )}
            >
              {[
                {
                  value: 'blank' as const,
                  label: t('Blank project'),
                  Icon: FolderPlus,
                },
                {
                  value: 'git' as const,
                  label: t('Import repository'),
                  Icon: GitBranch,
                },
                {
                  value: 'ssh' as const,
                  label: t('Remote server'),
                  Icon: Server,
                },
                ...(props.allowHost
                  ? [{ value: 'host' as const, label: t('Host'), Icon: Server }]
                  : []),
              ].map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'relative flex min-h-12 min-w-0 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-center text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring sm:flex-row sm:gap-2 sm:text-sm',
                    source === option.value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                    unavailable && 'cursor-default opacity-50'
                  )}
                >
                  <input
                    type='radio'
                    className='sr-only'
                    value={option.value}
                    {...form.register('source', {
                      onChange: () => {
                        form.clearErrors()
                        setError('')
                      },
                    })}
                  />
                  <option.Icon className='size-4 shrink-0' aria-hidden />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {source === 'git' && (
            <div className='space-y-4'>
              {github.isError && (
                <div className='bg-muted/50 flex items-center justify-between gap-3 rounded-xl px-3 py-2'>
                  <p
                    role='alert'
                    className='text-muted-foreground min-w-0 text-xs leading-5 break-words'
                  >
                    {t(codexError(github.error))}
                  </p>
                  <Button
                    type='button'
                    variant='ghost'
                    className='h-9 rounded-full px-3 text-xs'
                    disabled={busy || github.isFetching}
                    onClick={() => {
                      void github.refetch()
                    }}
                  >
                    {t('Retry GitHub connection')}
                  </Button>
                </div>
              )}
              {github.data?.connected && (
                <div className='space-y-2.5'>
                  <label
                    htmlFor='codex-github-repository'
                    className='text-sm font-medium'
                  >
                    {t('Your GitHub repositories')}
                  </label>
                  <CodexSelect
                    id='codex-github-repository'
                    label={t('Your GitHub repositories')}
                    value={form.watch('repository') || ''}
                    className='h-12 rounded-xl px-4'
                    disabled={
                      unavailable ||
                      repositories.isFetching ||
                      !repositories.data?.repositories.length
                    }
                    placeholder={
                      repositories.isFetching
                        ? t('Loading repositories…')
                        : t('Choose a repository')
                    }
                    options={(repositories.data?.repositories ?? []).map(
                      (repo) => ({
                        value: repo.cloneUrl,
                        label:
                          repo.fullName +
                          (repo.private ? ` · ${t('Private')}` : ''),
                      })
                    )}
                    onChange={(value) => {
                      const repo = repositories.data?.repositories.find(
                        (entry) => entry.cloneUrl === value
                      )
                      if (!repo) return
                      form.setValue('repository', repo.cloneUrl, {
                        shouldValidate: true,
                        shouldDirty: true,
                      })
                      if (!form.getValues('title').trim()) {
                        form.setValue('title', repo.name, {
                          shouldValidate: true,
                          shouldDirty: true,
                        })
                      }
                    }}
                  />
                  {repositories.isError && (
                    <div className='flex items-center justify-between gap-3'>
                      <p
                        role='alert'
                        className='text-destructive min-w-0 text-xs leading-5 break-words'
                      >
                        {t(codexError(repositories.error))}
                      </p>
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-9 rounded-full px-3 text-xs'
                        disabled={busy || repositories.isFetching}
                        onClick={() => {
                          void repositories.refetch()
                        }}
                      >
                        {t('Retry')}
                      </Button>
                    </div>
                  )}
                  {repositories.isSuccess &&
                    !repositories.data.repositories.length && (
                      <p
                        role='status'
                        className='text-muted-foreground text-xs leading-5'
                      >
                        {t(
                          'No repositories found. Paste a repository URL below.'
                        )}
                      </p>
                    )}
                  {(repositoryPage > 1 || repositories.data?.hasMore) && (
                    <div className='flex justify-end gap-1'>
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-9 rounded-full px-3 text-xs'
                        disabled={
                          unavailable ||
                          repositoryPage <= 1 ||
                          repositories.isFetching
                        }
                        onClick={() => setRepositoryPage((page) => page - 1)}
                      >
                        {t('Previous')}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-9 rounded-full px-3 text-xs'
                        disabled={
                          unavailable ||
                          !repositories.data?.hasMore ||
                          repositories.isFetching
                        }
                        onClick={() => setRepositoryPage((page) => page + 1)}
                      >
                        {t('Next')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className='space-y-2.5'>
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
                  autoComplete='off'
                  spellCheck={false}
                  className='border-border h-12 rounded-xl px-4 text-base focus-visible:ring-1 md:text-sm'
                  disabled={unavailable}
                  placeholder='https://github.com/owner/project.git'
                  maxLength={2048}
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
                    'Use an HTTPS repository URL. Connect GitHub to clone private repositories you can access.'
                  )}
                </p>
                {form.formState.errors.repository && (
                  <p
                    role='alert'
                    id='codex-project-repository-error'
                    className='text-destructive text-xs leading-5'
                  >
                    {t(form.formState.errors.repository.message || '')}
                  </p>
                )}
              </div>
              <div className='space-y-2.5'>
                <label
                  htmlFor='codex-project-branch'
                  className='text-sm font-medium'
                >
                  {t('Branch (optional)')}
                </label>
                <Input
                  id='codex-project-branch'
                  autoComplete='off'
                  spellCheck={false}
                  className='border-border h-12 rounded-xl px-4 text-base focus-visible:ring-1 md:text-sm'
                  disabled={unavailable}
                  placeholder={t('Default branch')}
                  maxLength={200}
                  aria-invalid={!!form.formState.errors.branch}
                  aria-describedby={
                    form.formState.errors.branch
                      ? 'codex-project-branch-error'
                      : 'codex-project-branch-help'
                  }
                  {...form.register('branch')}
                />
                <p
                  id='codex-project-branch-help'
                  className='text-muted-foreground text-xs leading-5'
                >
                  {t('Leave blank to use the repository’s default branch.')}
                </p>
                {form.formState.errors.branch && (
                  <p
                    role='alert'
                    id='codex-project-branch-error'
                    className='text-destructive text-xs leading-5'
                  >
                    {t(form.formState.errors.branch.message || '')}
                  </p>
                )}
              </div>
            </div>
          )}
          {source === 'ssh' && (
            <div className='space-y-4'>
              <div className='space-y-2.5'>
                <div className='flex items-center justify-between gap-2'>
                  <label
                    htmlFor='codex-remote-connection'
                    className='text-sm font-medium'
                  >
                    {t('Remote server')}
                  </label>
                  {props.onManageConnections && (
                    <Button
                      type='button'
                      variant='ghost'
                      className='h-8 rounded-full px-3 text-xs'
                      onClick={() => {
                        resumeDraft.current = true
                        props.onManageConnections?.()
                      }}
                      disabled={busy}
                    >
                      {t('Manage connections')}
                    </Button>
                  )}
                </div>
                <CodexSelect
                  id='codex-remote-connection'
                  label={t('Remote server')}
                  value={form.watch('connection')}
                  className='h-12 rounded-xl px-4'
                  disabled={unavailable || !props.connections?.length}
                  invalid={!!form.formState.errors.connection}
                  placeholder={t('Choose a remote server')}
                  options={(props.connections ?? []).map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                    description: `${connection.username}@${connection.host}`,
                  }))}
                  onChange={(value) =>
                    form.setValue('connection', value, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                />
                {!props.connections?.length && (
                  <p
                    role='status'
                    className='text-muted-foreground text-xs leading-5'
                  >
                    {t('No SSH servers connected yet.')}
                  </p>
                )}
                {form.formState.errors.connection && (
                  <p
                    role='alert'
                    className='text-destructive text-xs leading-5'
                  >
                    {t(form.formState.errors.connection.message || '')}
                  </p>
                )}
              </div>
              <div className='space-y-2.5'>
                <label
                  htmlFor='codex-remote-path'
                  className='block text-sm font-medium'
                >
                  {t('Remote project directory')}
                </label>
                <Input
                  id='codex-remote-path'
                  placeholder='/home/developer/project'
                  autoComplete='off'
                  spellCheck={false}
                  className='border-border h-12 rounded-xl px-4 text-base focus-visible:ring-1 md:text-sm'
                  disabled={unavailable}
                  maxLength={1024}
                  {...form.register('remotePath')}
                  aria-invalid={!!form.formState.errors.remotePath}
                  aria-describedby={
                    form.formState.errors.remotePath
                      ? 'codex-remote-path-error'
                      : 'codex-remote-path-help'
                  }
                />
                {form.formState.errors.remotePath && (
                  <p
                    role='alert'
                    id='codex-remote-path-error'
                    className='text-destructive text-xs leading-5'
                  >
                    {t(form.formState.errors.remotePath.message || '')}
                  </p>
                )}
                <p
                  id='codex-remote-path-help'
                  className='text-muted-foreground text-xs leading-5'
                >
                  {t(
                    'Choose an existing directory. Commands and changes run directly on the remote server; deleting this project keeps the remote files.'
                  )}
                </p>
              </div>
            </div>
          )}
          {source === 'host' && props.allowHost && (
            <div className='space-y-2'>
              <label htmlFor='codex-host-path' className='text-sm font-medium'>
                {t('Host project directory')}
              </label>
              <Input
                id='codex-host-path'
                placeholder='/root/project'
                {...form.register('remotePath')}
                disabled={unavailable}
                aria-invalid={!!form.formState.errors.remotePath}
              />
              {form.formState.errors.remotePath && (
                <p role='alert' className='text-destructive text-xs'>
                  {t(form.formState.errors.remotePath.message || '')}
                </p>
              )}
              <p className='text-muted-foreground text-xs leading-5'>
                {t(
                  'Choose an existing host directory. Commands run directly on the server; deleting this project keeps its files.'
                )}
              </p>
            </div>
          )}
          {source === 'blank' && (
            <p className='text-muted-foreground text-sm leading-6'>
              {t(
                'You can create files or upload a ZIP after opening the project.'
              )}
            </p>
          )}
          {error && (
            <p
              ref={errorMessage}
              role='alert'
              tabIndex={-1}
              className='text-destructive bg-destructive/5 rounded-xl px-4 py-3 text-sm leading-6 break-words'
            >
              {t(error)}
            </p>
          )}
          {props.disabled && (
            <p
              role='status'
              className='text-muted-foreground text-xs leading-5'
            >
              {t(
                'Project creation is paused while your environment is busy or unavailable.'
              )}
            </p>
          )}
          {busy && (
            <p
              role='status'
              className='text-muted-foreground flex items-center gap-2 text-xs leading-5'
            >
              <LoaderCircle
                className='size-3.5 shrink-0 animate-spin'
                aria-hidden
              />
              {source === 'git'
                ? t('Importing repository. This may take a moment.')
                : t('Creating project...')}
            </p>
          )}
          <div className='flex flex-wrap items-center justify-end gap-2 pt-1'>
            <Button
              type='button'
              variant='ghost'
              className='focus-visible:ring-ring h-11 rounded-full px-5 text-sm font-medium focus-visible:ring-2'
              disabled={busy}
              onClick={close}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='submit'
              className='bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-ring h-11 gap-2 rounded-full px-5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2'
              disabled={unavailable}
            >
              {busy && (
                <LoaderCircle className='size-4 animate-spin' aria-hidden />
              )}
              {t('Create project')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
