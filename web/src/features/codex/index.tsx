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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  CodeXml,
  Download,
  Ellipsis,
  FileCode2,
  FolderPlus,
  GitCompareArrows,
  LoaderCircle,
  Menu,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

import { codexApi, codexError, downloadCodexFile } from './api'
import { CodexComposer } from './components/composer'
import { CodexConversation } from './components/conversation'
import { CreateWorkspaceDialog } from './components/create-workspace'
import { EnvironmentPanel } from './components/environment-panel'
import { WorkspaceInspector } from './components/workspace-inspector'
import { ProjectTime, WorkspaceList } from './components/workspace-list'
import { useCodexThread } from './hooks/use-codex-thread'
import { isCodexBusy } from './lib/events'
import type { CodexApprovalAnswer, CodexMode, CodexTurnInput } from './types'

interface CodexProps {
  workspaceId?: string
  onSelect: (id?: string) => void
  onBack: () => void
  onDirty?: (dirty: boolean) => void
}
export function Codex(props: CodexProps) {
  const actor = useAuthStore(
    (state) => `${state.auth.user?.id}:${state.auth.session?.sid}`
  )
  return <CodexSession key={actor} {...props} actor={actor} />
}
function CodexSession(props: CodexProps & { actor: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const wide = useMediaQuery('(min-width: 1024px)')
  const [createOpen, setCreateOpen] = useState(false)
  const [createSource, setCreateSource] = useState<'blank' | 'git'>('blank')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [fileDirty, setFileDirty] = useState(false)
  const currentSelection = useRef(props.workspaceId)
  currentSelection.current = props.workspaceId
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  function currentActor() {
    const auth = useAuthStore.getState().auth
    return (
      mounted.current && `${auth.user?.id}:${auth.session?.sid}` === props.actor
    )
  }
  function canDiscard() {
    return !fileDirty || window.confirm(t('Discard unsaved file changes?'))
  }
  function setDirty(dirty: boolean) {
    setFileDirty(dirty)
    props.onDirty?.(dirty)
  }
  function selectWorkspace(id?: string) {
    if (canDiscard()) {
      setDirty(false)
      props.onSelect(id)
      setSidebarOpen(false)
    }
  }
  const [tab, setTab] = useState<'files' | 'diff' | 'logs'>('diff')
  const [menuOpen, setMenuOpen] = useState(false)
  const actionMenu = useRef<HTMLDivElement>(null)
  const actionTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    actionMenu.current
      ?.querySelector<HTMLButtonElement>('button:not([disabled])')
      ?.focus()
    function navigateMenu(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        actionTrigger.current?.focus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const controls = [
        ...(actionMenu.current?.querySelectorAll<HTMLButtonElement>(
          'button:not([disabled])'
        ) ?? []),
      ]
      if (!controls.length) return
      event.preventDefault()
      const current = controls.indexOf(
        document.activeElement as HTMLButtonElement
      )
      const direction = event.key === 'ArrowDown' ? 1 : -1
      controls[
        (current + direction + controls.length) % controls.length
      ]?.focus()
    }
    document.addEventListener('keydown', navigateMenu)
    return () => document.removeEventListener('keydown', navigateMenu)
  }, [menuOpen])
  const [confirm, setConfirm] = useState<'rename' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [mode, setMode] = useState<CodexMode>('code')
  const homeWorkspace = useRef<string | null>(null)
  const upload = useRef<HTMLInputElement>(null)
  const status = useQuery({
    queryKey: ['codex', props.actor, 'status'],
    queryFn: ({ signal }) => codexApi.status(signal),
    staleTime: 30_000,
    retry: 1,
  })
  const list = useQuery({
    queryKey: ['codex', props.actor, 'list'],
    queryFn: ({ signal }) => codexApi.list(signal),
    refetchInterval: 10_000,
    retry: 1,
  })
  const environmentQuery = useQuery({
    queryKey: ['codex', props.actor, 'environment'],
    queryFn: ({ signal }) => codexApi.environment(signal),
    refetchInterval: 5000,
    staleTime: 2000,
    retry: 1,
  })
  const environmentChange = useMutation({
    mutationFn: (operation: 'start' | 'stop') =>
      operation === 'start'
        ? codexApi.startEnvironment()
        : codexApi.stopEnvironment(),
    onSuccess: (result) => {
      if (!currentActor()) return
      client.setQueryData(['codex', props.actor, 'environment'], result)
      void client.invalidateQueries({ queryKey: ['codex', props.actor] })
    },
    onError: () => {
      void environmentQuery.refetch()
    },
  })
  const detail = useCodexThread(props.workspaceId, props.actor)
  const workspace = detail.data?.workspace
  const workspaceLoaded = !!workspace
  const taskRunning = isCodexBusy(workspace?.status ?? '')
  const previousTaskRunning = useRef(taskRunning)
  useEffect(() => {
    if (previousTaskRunning.current && !taskRunning) {
      void client.invalidateQueries({
        queryKey: ['codex', props.actor, 'environment'],
      })
    }
    previousTaskRunning.current = taskRunning
  }, [taskRunning, client, props.actor])
  useEffect(() => {
    void client.invalidateQueries({
      queryKey: ['codex', props.actor, 'environment'],
    })
  }, [props.workspaceId, props.actor, client])
  const running =
    taskRunning ||
    (!!props.workspaceId &&
      environmentQuery.data?.environment.activeWorkspaceId ===
        props.workspaceId)
  const ready = !!status.data?.available && !!status.data.configured
  const environment = environmentQuery.data?.environment
  const environmentUnavailable = environmentQuery.isError || !environment
  const environmentStarting =
    environment?.status === 'starting' || environmentChange.isPending
  const otherProjectRunning =
    !!environment?.activeWorkspaceId &&
    environment.activeWorkspaceId !== props.workspaceId
  const environmentBusy = running || !!environment?.activeWorkspaceId
  const mutationBlocked =
    environmentBusy || environmentStarting || environmentUnavailable
  let workspaceSaveStatus = running
    ? t('Working in the cloud')
    : t('Saved project')
  if (running && !taskRunning) workspaceSaveStatus = t('Finishing task...')
  if (detail.data?.persistenceError) {
    workspaceSaveStatus = t('Project not saved')
  }
  const currentModel =
    model || workspace?.model || status.data?.defaultModel || ''
  const currentEffort =
    effort || workspace?.effort || status.data?.defaultEffort || 'medium'
  useEffect(() => {
    setModel('')
    setEffort('')
    setMode('code')
    setMenuOpen(false)
    setInspectorOpen(false)
    homeWorkspace.current = null
  }, [props.workspaceId])
  useEffect(() => {
    if (workspaceLoaded) setMode(workspace?.mode ?? 'code')
  }, [props.workspaceId, workspaceLoaded, workspace?.mode])
  const change = useMutation({
    mutationFn: async (action: {
      type: 'rename' | 'archive' | 'delete' | 'interrupt' | 'import' | 'export'
      file?: File
    }) => {
      if (!workspace) return
      if (action.type === 'rename') {
        await codexApi.update(workspace.id, { name: name.trim() })
      }
      if (action.type === 'archive') {
        await codexApi.update(workspace.id, { archived: !workspace.archived })
      }
      if (action.type === 'delete') await codexApi.remove(workspace.id)
      if (action.type === 'interrupt') await codexApi.interrupt(workspace.id)
      if (action.type === 'import' && action.file) {
        await codexApi.import(workspace.id, action.file)
        toast.success(t('Project files imported.'))
      }
      if (action.type === 'export') {
        downloadCodexFile(
          await codexApi.export(workspace.id),
          `${workspace.name.replaceAll(/[^\p{L}\p{N}_.-]+/gu, '-') || 'workspace'}.zip`
        )
      }
      return action.type
    },
    onSuccess: (action) => {
      setConfirm(null)
      setMenuOpen(false)
      void client.invalidateQueries({ queryKey: ['codex', props.actor] })
      if (action === 'delete') props.onSelect(undefined)
    },
  })
  function action(type: 'archive' | 'interrupt' | 'export') {
    change.mutate({ type })
  }
  async function create(nameValue: string, repository?: string) {
    const result = await codexApi.create({
      name: nameValue,
      repositoryUrl: repository,
    })
    await client.invalidateQueries({ queryKey: ['codex', props.actor, 'list'] })
    void client.invalidateQueries({
      queryKey: ['codex', props.actor, 'environment'],
    })
    if (!currentActor()) return
    props.onSelect(result.workspace.id)
    setSidebarOpen(false)
  }
  async function submit(input: CodexTurnInput) {
    let id = props.workspaceId || homeWorkspace.current
    if (!id) {
      const created = await codexApi.create({
        name: input.prompt.replaceAll(/\s+/g, ' ').slice(0, 60),
      })
      id = created.workspace.id
      homeWorkspace.current = id
      void client.invalidateQueries({
        queryKey: ['codex', props.actor, 'list'],
      })
    }
    if (!currentActor() || currentSelection.current !== props.workspaceId) {
      throw new Error(
        t(
          'The session or project changed. Please open the project to continue.'
        )
      )
    }
    await codexApi.turn(id, input)
    if (!currentActor() || currentSelection.current !== props.workspaceId) {
      return
    }
    await client.invalidateQueries({ queryKey: ['codex', props.actor] })
    props.onSelect(id)
  }
  async function approve(id: string, answer: CodexApprovalAnswer) {
    if (!props.workspaceId) return
    await codexApi.approve(props.workspaceId, id, answer)
    await client.invalidateQueries({
      queryKey: ['codex', props.actor, 'workspace', props.workspaceId],
    })
  }
  function chooseModel(value: string) {
    setModel(value)
    const choice = status.data?.models.find((entry) => entry.id === value)
    if (choice?.efforts?.length && !choice.efforts.includes(currentEffort)) {
      setEffort(choice.defaultEffort || choice.efforts[0])
    }
  }
  const workspaces = (list.data?.workspaces ?? []).map((entry) =>
    entry.id === workspace?.id ? workspace : entry
  )
  let blockedReason: string | undefined
  if (otherProjectRunning) {
    blockedReason = t(
      'Another project is using your environment. Finish or stop its task before starting a new one.'
    )
  } else if (environmentUnavailable) {
    blockedReason = t(
      'Reconnect to your environment before starting a task. Your draft is preserved.'
    )
  } else if (environmentStarting) {
    blockedReason = t(
      'Your environment is being updated. Your draft is preserved.'
    )
  }
  let environmentError: string | undefined
  if (environmentChange.isError) {
    environmentError = codexError(environmentChange.error)
  } else if (environmentQuery.isError) {
    environmentError = codexError(environmentQuery.error)
  }
  const composer = (
    <CodexComposer
      key={props.workspaceId || 'new'}
      draftKey={`${props.actor}:${props.workspaceId || 'new'}`}
      status={status.data}
      model={currentModel}
      effort={currentEffort}
      mode={mode}
      onModel={chooseModel}
      onEffort={setEffort}
      onMode={setMode}
      onSubmit={submit}
      onStop={() =>
        change.mutateAsync({ type: 'interrupt' }).then(() => undefined)
      }
      running={running}
      finishing={running && !taskRunning}
      disabled={
        !ready ||
        environmentUnavailable ||
        environmentStarting ||
        otherProjectRunning ||
        change.isPending ||
        !!workspace?.archived ||
        (!!props.workspaceId && !workspace)
      }
      compact={!!props.workspaceId}
      workspaceTitle={workspace?.name}
      blockedReason={blockedReason}
      onActiveProject={
        otherProjectRunning
          ? () => selectWorkspace(environment?.activeWorkspaceId ?? undefined)
          : undefined
      }
    />
  )
  return (
    <div className='bg-background text-foreground relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden font-sans [&_h1]:font-sans [&_h2]:font-sans [&_h3]:font-sans [&_h4]:font-sans'>
      <WorkspaceList
        workspaces={workspaces}
        selected={props.workspaceId}
        open={sidebarOpen}
        onClose={closeSidebar}
        onNew={() => selectWorkspace(undefined)}
        onSelect={selectWorkspace}
        onBack={props.onBack}
        loading={list.isLoading}
      />
      <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
        <header className='border-border/60 flex h-16 shrink-0 items-center gap-1.5 border-b px-3 sm:gap-3 sm:px-6'>
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            className='size-10 md:hidden'
            aria-label={t('Open project list')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu />
          </Button>
          <div className='min-w-0 flex-1'>
            <h1 className='truncate text-[15px] font-semibold tracking-tight'>
              {workspace?.name || t('Codex')}
            </h1>
            {workspace && (
              <p
                className={cn(
                  'mt-0.5 flex items-center gap-1.5 text-xs',
                  running
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-muted-foreground'
                )}
              >
                {running && (
                  <span
                    className='size-1.5 rounded-full bg-current'
                    aria-hidden
                  />
                )}
                {workspaceSaveStatus}
                {workspace.archived ? ` · ${t('Archived')}` : ''}
              </p>
            )}
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            aria-label={t('New project')}
            onClick={() => {
              setCreateSource('blank')
              setCreateOpen(true)
            }}
            disabled={!ready || mutationBlocked}
          >
            <FolderPlus className='size-3.5' />
            <span className='hidden sm:inline'>{t('New project')}</span>
          </Button>
          <EnvironmentPanel
            environment={environment}
            loading={environmentQuery.isLoading}
            taskRunning={running}
            unavailable={environmentUnavailable}
            pending={
              environmentChange.isPending ? environmentChange.variables : null
            }
            error={environmentError}
            onStart={() => environmentChange.mutate('start')}
            onStop={() => environmentChange.mutate('stop')}
            onRetry={() => {
              environmentChange.reset()
              void environmentQuery.refetch()
            }}
            onSelect={selectWorkspace}
          />
          {workspace && (
            <>
              <Button
                type='button'
                variant={inspectorOpen ? 'secondary' : 'outline'}
                size='sm'
                aria-label={t('Review changes')}
                aria-pressed={inspectorOpen}
                onClick={() => {
                  if (!inspectorOpen || canDiscard()) {
                    setDirty(false)
                    setInspectorOpen(!inspectorOpen)
                  }
                }}
              >
                <GitCompareArrows className='size-3.5' />
                <span className='hidden xl:inline'>{t('Review changes')}</span>
                <span className='xl:hidden'>{t('Changes')}</span>
              </Button>
              <div className='relative'>
                <Button
                  type='button'
                  size='icon-sm'
                  variant='ghost'
                  aria-label={t('Project actions')}
                  aria-expanded={menuOpen}
                  ref={actionTrigger}
                  onClick={() => setMenuOpen(!menuOpen)}
                >
                  <Ellipsis />
                </Button>
                {menuOpen && (
                  <>
                    <button
                      type='button'
                      tabIndex={-1}
                      className='fixed inset-0 z-30 cursor-default'
                      aria-label={t('Close project actions')}
                      onClick={() => setMenuOpen(false)}
                    />
                    <div
                      ref={actionMenu}
                      className='bg-popover absolute top-11 right-0 z-40 w-56 space-y-0.5 rounded-xl border p-1.5 shadow-md'
                    >
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-10 w-full justify-start rounded-lg text-sm'
                        onClick={() => {
                          setName(workspace.name)
                          setConfirm('rename')
                          setMenuOpen(false)
                        }}
                        disabled={mutationBlocked || change.isPending}
                      >
                        <Pencil className='size-3.5' />
                        {t('Rename project')}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-10 w-full justify-start rounded-lg text-sm'
                        disabled={mutationBlocked || change.isPending}
                        onClick={() => {
                          upload.current?.click()
                          setMenuOpen(false)
                        }}
                      >
                        <Upload className='size-3.5' />
                        {t('Import ZIP')}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-10 w-full justify-start rounded-lg text-sm'
                        disabled={mutationBlocked || change.isPending}
                        onClick={() => action('export')}
                      >
                        <Download className='size-3.5' />
                        {t('Export project')}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        className='h-10 w-full justify-start rounded-lg text-sm'
                        disabled={mutationBlocked || change.isPending}
                        onClick={() => action('archive')}
                      >
                        {workspace.archived ? (
                          <ArchiveRestore className='size-3.5' />
                        ) : (
                          <Archive className='size-3.5' />
                        )}
                        {workspace.archived
                          ? t('Restore project')
                          : t('Archive project')}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        className='text-destructive h-10 w-full justify-start rounded-lg text-sm'
                        disabled={mutationBlocked || change.isPending}
                        onClick={() => {
                          setConfirm('delete')
                          setMenuOpen(false)
                        }}
                      >
                        <Trash2 className='size-3.5' />
                        {t('Delete project')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
              <input
                ref={upload}
                type='file'
                accept='.zip,application/zip'
                className='hidden'
                aria-label={t('Import project ZIP')}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  if (
                    file.size >
                    (status.data?.limits.uploadBytes ?? 25 * 1024 * 1024)
                  ) {
                    toast.error(t('The ZIP exceeds the project upload limit.'))
                    return
                  }
                  change.mutate({ type: 'import', file })
                }}
              />
            </>
          )}
        </header>

        {(status.isError || list.isError || (status.data && !ready)) && (
          <div
            className='flex items-center gap-3 border-b bg-amber-500/5 px-4 py-3 text-xs'
            role='alert'
          >
            <span className='min-w-0 flex-1'>
              {status.data?.reason ||
                t(
                  'Codex is unavailable. Check the project service and model configuration.'
                )}
            </span>
            <Button
              type='button'
              variant='outline'
              size='xs'
              onClick={() => {
                void status.refetch()
                void list.refetch()
              }}
            >
              <RefreshCw className='size-3' />
              {t('Retry')}
            </Button>
          </div>
        )}
        {change.isError && (
          <div
            role='alert'
            className='bg-destructive/5 text-destructive flex items-center gap-2 border-b px-4 py-2 text-xs'
          >
            <span className='flex-1'>{t(codexError(change.error))}</span>
            <Button
              type='button'
              size='icon-xs'
              variant='ghost'
              aria-label={t('Dismiss error')}
              onClick={() => change.reset()}
            >
              <X />
            </Button>
          </div>
        )}
        {detail.data?.persistenceError && (
          <div
            role='alert'
            className='bg-destructive/5 text-destructive flex items-center gap-3 border-b px-4 py-3 text-xs'
          >
            <span className='min-w-0 flex-1'>
              {t(
                'Project history could not be saved. Export important files and retry after storage is available.'
              )}
            </span>
            <Button
              type='button'
              variant='outline'
              size='xs'
              disabled={detail.isFetching}
              onClick={() => void detail.refetch()}
            >
              <RefreshCw className='size-3' />
              {t('Retry')}
            </Button>
          </div>
        )}
        {!!detail.connectionError && (
          <p
            role='status'
            className='border-b bg-amber-500/5 px-4 py-2 text-xs'
          >
            {t(
              'Connection interrupted. Reconnecting; your task continues on the server.'
            )}
          </p>
        )}
        {change.isPending && (
          <p
            role='status'
            className='text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs'
          >
            <LoaderCircle className='size-3 animate-spin' />
            {t('Updating project...')}
          </p>
        )}
        {!props.workspaceId ? (
          <div className='min-h-0 flex-1 overflow-y-auto'>
            <div className='mx-auto w-full max-w-4xl px-1 py-8 sm:px-6 sm:py-12'>
              <div className='mx-auto mb-6 w-full max-w-3xl px-4 sm:mb-8'>
                <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium'>
                  <CodeXml className='size-4' aria-hidden />
                  {t('Your coding workspace')}
                </div>
                <h2 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
                  {t('What should we build next?')}
                </h2>
                <p className='text-muted-foreground mt-3 max-w-xl text-sm leading-6'>
                  {t(
                    'Describe a change, fix a bug, or explore your code. Your projects and progress stay here.'
                  )}
                </p>
              </div>
              {composer}
              <div className='mx-auto mt-4 flex w-full max-w-3xl flex-wrap items-center gap-2 px-4'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground text-xs'
                  onClick={() => {
                    setMode('ask')
                    document
                      .querySelector<HTMLTextAreaElement>(
                        '[data-codex-composer]'
                      )
                      ?.focus()
                  }}
                >
                  <Search className='size-3.5' />
                  {t('Ask about code')}
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='text-muted-foreground text-xs'
                  onClick={() => {
                    setCreateSource('git')
                    setCreateOpen(true)
                  }}
                  disabled={!ready || mutationBlocked}
                >
                  <FileCode2 className='size-3.5' />
                  {t('Import a repository')}
                </Button>
              </div>
              <section
                aria-label={t('Continue a project')}
                className='mx-auto mt-10 w-full max-w-3xl px-4 sm:mt-12'
              >
                <div className='mb-3 flex items-center justify-between'>
                  <h3 className='text-sm font-semibold'>
                    {t('Continue a project')}
                  </h3>
                  <span className='text-muted-foreground text-xs'>
                    {workspaces.filter((entry) => !entry.archived).length}
                  </span>
                </div>
                {list.isLoading && (
                  <p
                    role='status'
                    className='text-muted-foreground py-6 text-sm'
                  >
                    {t('Loading projects...')}
                  </p>
                )}
                {!list.isLoading &&
                  !workspaces.some((entry) => !entry.archived) && (
                    <div className='rounded-xl border border-dashed px-5 py-6'>
                      <p className='text-sm font-medium'>
                        {t('Your first project starts with a task.')}
                      </p>
                      <p className='text-muted-foreground mt-2 text-sm leading-6'>
                        {t(
                          'Send a task above, or create a project to bring in existing code.'
                        )}
                      </p>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        className='mt-4'
                        onClick={() => {
                          setCreateSource('blank')
                          setCreateOpen(true)
                        }}
                        disabled={!ready || mutationBlocked}
                      >
                        <FolderPlus className='size-3.5' />
                        {t('Create project')}
                      </Button>
                    </div>
                  )}
                <div className='divide-border/50 divide-y'>
                  {workspaces
                    .filter((entry) => !entry.archived)
                    .slice(0, 6)
                    .map((entry) => (
                      <button
                        type='button'
                        key={entry.id}
                        className='hover:bg-muted/40 focus-visible:ring-ring/40 group flex w-full items-center gap-3 rounded-lg px-2 py-4 text-left outline-none focus-visible:ring-2'
                        onClick={() => selectWorkspace(entry.id)}
                      >
                        {isCodexBusy(entry.status) ? (
                          <LoaderCircle className='size-4 shrink-0 animate-spin text-emerald-700 dark:text-emerald-400' />
                        ) : (
                          <CheckCircle2 className='text-muted-foreground size-4 shrink-0' />
                        )}
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-sm font-medium'>
                            {entry.name}
                          </span>
                          <span className='text-muted-foreground mt-1 block truncate text-xs'>
                            {entry.model || t('New project')}
                            {isCodexBusy(entry.status)
                              ? ` · ${t('Running')}`
                              : ''}
                          </span>
                        </span>
                        <span className='text-muted-foreground text-xs'>
                          <ProjectTime value={entry.updatedAt} />
                        </span>
                      </button>
                    ))}
                </div>
              </section>
            </div>
          </div>
        ) : (
          <ResizablePanelGroup
            orientation='horizontal'
            className='min-h-0 flex-1'
            key={wide ? 'wide' : 'narrow'}
          >
            {(wide || !inspectorOpen) && (
              <ResizablePanel
                id='conversation'
                defaultSize={inspectorOpen && wide ? '54%' : '100%'}
                minSize={wide && inspectorOpen ? '35%' : '0%'}
                className='flex min-h-0 min-w-0 flex-col'
              >
                {detail.isLoading && (
                  <div
                    role='status'
                    className='text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm'
                  >
                    <LoaderCircle className='size-4 animate-spin' />
                    {t('Restoring project...')}
                  </div>
                )}
                {detail.isError && (
                  <div className='flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center'>
                    <p role='alert' className='text-destructive text-sm'>
                      {t(codexError(detail.error))}
                    </p>
                    <Button
                      type='button'
                      variant='outline'
                      onClick={() => void detail.refetch()}
                    >
                      {t('Retry')}
                    </Button>
                  </div>
                )}
                {workspace && (
                  <>
                    <CodexConversation
                      thread={detail.data?.thread ?? null}
                      running={taskRunning}
                      approvals={detail.data?.pendingApprovals ?? []}
                      onApprove={approve}
                    />
                    {workspace.lastError && (
                      <p role='alert' className='text-destructive px-5 text-xs'>
                        {workspace.lastError}
                      </p>
                    )}
                    {workspace.archived && (
                      <p className='text-muted-foreground px-5 py-2 text-xs'>
                        {t(
                          'Restore this project to continue the conversation.'
                        )}
                      </p>
                    )}
                    {composer}
                  </>
                )}
              </ResizablePanel>
            )}
            {wide && inspectorOpen && workspace && (
              <ResizableHandle
                aria-label={t('Resize conversation and project panels')}
                className='hover:bg-foreground/30 w-1 bg-transparent transition-colors'
              />
            )}
            {inspectorOpen && workspace && (
              <ResizablePanel
                id='inspector'
                defaultSize={wide ? '46%' : '100%'}
                minSize={wide ? '30%' : '0%'}
                className='flex min-h-0 min-w-0 flex-col'
              >
                <WorkspaceInspector
                  key={workspace.id}
                  id={workspace.id}
                  actor={props.actor}
                  running={mutationBlocked}
                  diffBlocked={
                    environmentUnavailable ||
                    environmentStarting ||
                    otherProjectRunning ||
                    (running && mode === 'ask')
                  }
                  thread={detail.data?.thread ?? null}
                  tab={tab}
                  onTab={(next) => {
                    if (canDiscard()) {
                      setDirty(false)
                      setTab(next)
                    }
                  }}
                  onClose={() => {
                    if (canDiscard()) {
                      setDirty(false)
                      setInspectorOpen(false)
                    }
                  }}
                  onDirty={setDirty}
                />
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
        )}
      </div>
      <CreateWorkspaceDialog
        open={createOpen}
        initialSource={createSource}
        onClose={() => setCreateOpen(false)}
        onCreate={create}
        disabled={mutationBlocked}
      />
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !change.isPending) {
            setConfirm(null)
            change.reset()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className='font-sans'>
              {confirm === 'delete'
                ? t('Delete project?')
                : t('Rename project')}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'delete'
                ? t(
                    'This permanently deletes this project, its files, and its conversation. Your personal environment and other projects are kept. Export anything you want to keep first.'
                  )
                : t('Choose a name that helps you find this project.')}
            </DialogDescription>
          </DialogHeader>
          {confirm === 'rename' && (
            <Input
              aria-label={t('Project name')}
              autoFocus
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={change.isPending}
              onClick={() => setConfirm(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='button'
              variant={confirm === 'delete' ? 'destructive' : 'default'}
              disabled={
                mutationBlocked ||
                change.isPending ||
                (confirm === 'rename' && !name.trim())
              }
              onClick={() => {
                if (confirm) change.mutate({ type: confirm })
              }}
            >
              {confirm === 'delete' ? t('Delete project') : t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
