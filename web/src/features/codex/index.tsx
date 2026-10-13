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
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  useInfiniteQuery,
} from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import {
  FileCode2,
  GitBranch,
  FolderPlus,
  GitCompareArrows,
  LoaderCircle,
  Menu,
  Settings,
  MoreHorizontal,
  Download,
  SquarePen,
  RefreshCw,
  Server,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { SystemBrand } from '@/components/layout/components/system-brand'
import { ProfileDropdown } from '@/components/profile-dropdown'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAuthStore } from '@/stores/auth-store'

import { codexApi, codexError, downloadCodexFile } from './api'
import { cloudApi } from './cloud-api'
import type { CloudEnvironment, ExecutionTarget } from './cloud-types'

import './chatgpt.css'
import { BulkManagement } from './components/bulk-management'
import { ChatGPTSearch } from './components/chatgpt-search'
import { ChatgptSettings } from './components/chatgpt-settings'
import { CloudEnvironmentsPanel } from './components/cloud-environments-panel'
import {
  CodexProjectPicker,
  CodexBranchPicker,
} from './components/codex-project-picker'
import { CodexComposer } from './components/composer'
import { CodexConversation } from './components/conversation'
import { CreateWorkspaceDialog } from './components/create-workspace'
import { EnvironmentPanel } from './components/environment-panel'
import { EnvironmentPorts } from './components/environment-ports'
import { ExecutionTargetPicker } from './components/execution-target-picker'
import { GitHubConnection } from './components/github-connection'
import { PullRequestPanel } from './components/pull-request-panel'
import { SidebarTasks } from './components/sidebar-tasks'
import { SshConnections } from './components/ssh-connections'
import { WorkspaceActions } from './components/workspace-actions'
import { WorkspaceInspector } from './components/workspace-inspector'
import { WorkspaceList } from './components/workspace-list'
import { useCodexAttachments } from './hooks/use-codex-attachments'
import { useCodexThread } from './hooks/use-codex-thread'
import { exportCodexConversation } from './lib/conversation-export'
import { isCodexBusy } from './lib/events'
import {
  readModelPreferences,
  resolveModelPreferences,
  saveModelPreferences,
  type CodexModelPreferences,
} from './lib/model-preferences'
import type {
  CodexApprovalAnswer,
  CodexCreateInput,
  CodexMode,
  CodexTurnInput,
  CodexProjectConversation,
  CodexWorkspace,
  CodexTask,
} from './types'
import { Button } from './vendor/zcode/button'

interface CodexProps {
  filePath?: string
  fileLine?: number
  workspaceId?: string
  conversationId?: string
  onSelect: (id?: string, conversationId?: string) => void
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [homeWorkspaceId, setHomeWorkspaceId] = useState<string | undefined>()
  const [environmentsOpen, setEnvironmentsOpen] = useState(false)
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false)
  const [environmentView, setEnvironmentView] = useState<
    'cloud' | 'docker' | 'host'
  >('cloud')
  const [createCloudEnvironment, setCreateCloudEnvironment] = useState(false)
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget>({
    type: 'docker',
  })
  const homeDraftKey =
    executionTarget.type === 'cloud'
      ? `cloud:${executionTarget.environmentId || 'unselected'}`
      : homeWorkspaceId || 'blank'
  const user = useAuthStore((state) => state.auth.user)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [scrollToLatestKey, setScrollToLatestKey] = useState(0)
  const [focusTurnId, setFocusTurnId] = useState<string | undefined>()
  const [focusTurnKey, setFocusTurnKey] = useState(0)
  const [focusTurnIndex, setFocusTurnIndex] = useState<number | undefined>()
  const inspectorTrigger = useRef<HTMLButtonElement>(null)
  const homeProject = useRef<{
    actor: string
    workspaceId: string
    conversationId?: string
  } | null>(null)
  const preparedHomeProjects = useRef(
    new Map<
      string,
      {
        actor: string
        workspaceId: string
        conversationId?: string
      }
    >()
  )
  const [homeAttachmentTarget, setHomeAttachmentTarget] = useState<{
    workspaceId: string
    conversationId?: string
  } | null>(null)
  const cloudTaskRequests = useRef(new Map<string, string>())
  const preparingHome = useRef<Promise<{
    workspaceId: string
    conversationId?: string
  }> | null>(null)
  const [openingChat, setOpeningChat] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(searchQuery.trim()),
      200
    )
    return () => window.clearTimeout(timer)
  }, [searchQuery])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const wide = useMediaQuery('(min-width: 1024px)')
  const [createOpen, setCreateOpen] = useState(false)
  const [createSource, setCreateSource] = useState<
    'blank' | 'git' | 'ssh' | 'host'
  >('blank')
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [connectionTab, setConnectionTab] = useState<'ssh' | 'github'>('ssh')
  const githubCallbackStarted = useRef(false)
  const [githubCallbackState, setGithubCallbackState] = useState<
    'idle' | 'pending' | 'complete' | 'error'
  >('idle')
  const [githubCallbackError, setGithubCallbackError] = useState('')
  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    if (query.get('github_oauth') !== '1' || githubCallbackStarted.current) {
      return
    }
    githubCallbackStarted.current = true
    setConnectionsOpen(true)
    setConnectionTab('github')
    const code = query.get('code')
    const state = query.get('state')
    const denied = query.has('error')
    const clean = new URL(window.location.href)
    for (const key of [
      'github_oauth',
      'code',
      'state',
      'error',
      'error_description',
      'iss',
    ]) {
      clean.searchParams.delete(key)
    }
    window.history.replaceState(
      window.history.state,
      '',
      clean.pathname + clean.search + clean.hash
    )
    if (denied || !code || !state) {
      setGithubCallbackError(
        t('GitHub authorization was not completed. Please connect again.')
      )
      setGithubCallbackState('error')
      return
    }
    setGithubCallbackState('pending')
    void codexApi
      .githubCallback({ code, state })
      .then(async () => {
        setGithubCallbackState('complete')
        await client.invalidateQueries({
          queryKey: ['codex'],
        })
      })
      .catch((error: unknown) => {
        setGithubCallbackError(codexError(error))
        setGithubCallbackState('error')
      })
  }, [client, props.actor, t])
  const [inspectorOpen, setInspectorOpen] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 1024px)').matches
  )
  const [fileDirty, setFileDirty] = useState(false)
  const [inspectorBusy, setInspectorBusy] = useState(false)
  const selectionKey = `${props.workspaceId || ''}:${props.conversationId || ''}`
  const currentSelection = useRef(selectionKey)
  currentSelection.current = selectionKey
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
    if (inspectorBusy) return false
    return !fileDirty || window.confirm(t('Discard unsaved file changes?'))
  }
  function setDirty(dirty: boolean) {
    setFileDirty(dirty)
    props.onDirty?.(dirty)
  }
  function selectWorkspace(
    id?: string,
    conversationId?: string,
    turnId?: string
  ) {
    if (canDiscard()) {
      setDirty(false)
      setFocusTurnIndex(undefined)
      setFocusTurnId(turnId)
      setFocusTurnKey((value) => value + 1)
      props.onSelect(id, conversationId)
      setSidebarOpen(false)
      return true
    }
    return false
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        setSidebarOpen(false)
        setSearchOpen(true)
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault()
        event.stopPropagation()
        selectWorkspace(undefined)
      }
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  })
  const [tab, setTab] = useState<'files' | 'diff' | 'logs'>('diff')
  const [confirm, setConfirm] = useState<'rename' | 'delete' | null>(null)
  const [projectTarget, setProjectTarget] = useState<CodexWorkspace | null>(
    null
  )
  const [conversationDialog, setConversationDialog] = useState<{
    type: 'rename' | 'delete'
    workspaceId: string
    conversation: CodexProjectConversation
  } | null>(null)
  const [conversationName, setConversationName] = useState('')
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<string[]>(
    () => (props.workspaceId ? [props.workspaceId] : [])
  )
  useEffect(() => {
    if (props.workspaceId) {
      const id = props.workspaceId
      setExpandedWorkspaceIds((ids) => (ids.includes(id) ? ids : [...ids, id]))
    }
  }, [props.workspaceId])
  const [name, setName] = useState('')
  const [modelPreferences, setModelPreferences] =
    useState<CodexModelPreferences | null>(() =>
      readModelPreferences(props.actor)
    )
  const [mode, setMode] = useState<CodexMode>(() => {
    try {
      const saved = localStorage.getItem(
        `codex-permission-mode:${props.actor.split(':')[0]}`
      )
      if (
        saved === 'code' ||
        saved === 'ask' ||
        saved === 'auto' ||
        saved === 'full-access'
      ) {
        return saved
      }
    } catch {
      /* Storage may be unavailable. */
    }
    return 'code'
  })
  const preferredMode = useRef(mode)
  function chooseMode(value: CodexMode) {
    preferredMode.current = value
    setMode(value)
    try {
      localStorage.setItem(
        `codex-permission-mode:${props.actor.split(':')[0]}`,
        value
      )
    } catch {
      /* Keep the current preference in memory. */
    }
  }
  const upload = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string | undefined>(undefined)
  const fileUploadInput = useRef<HTMLInputElement>(null)
  const status = useQuery({
    queryKey: ['codex', props.actor, 'status'],
    queryFn: ({ signal }) => codexApi.status(signal),
    staleTime: 30_000,
    retry: 1,
  })
  const catalog = useQuery({
    queryKey: ['codex', props.actor, 'catalog'],
    queryFn: ({ signal }) => codexApi.catalog(signal),
    staleTime: 30_000,
    retry: 1,
  })
  const ssh = useQuery({
    queryKey: ['codex', props.actor, 'ssh'],
    queryFn: ({ signal }) => codexApi.sshConnections(signal),
    enabled: connectionsOpen || createOpen,
    staleTime: 15_000,
    retry: 1,
  })
  const remoteTest = useMutation({
    mutationFn: (id: string) => codexApi.sshTest(id),
  })
  const list = useQuery({
    queryKey: ['codex', props.actor, 'list'],
    queryFn: ({ signal }) => codexApi.list(signal),
    refetchInterval: (query) =>
      query.state.data?.workspaces.some((entry) => isCodexBusy(entry.status))
        ? 10_000
        : 30_000,
    retry: 1,
  })
  const tasks = useInfiniteQuery({
    queryKey: ['codex', props.actor, 'tasks'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => codexApi.tasks(pageParam, signal),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.tasks.some((entry) => isCodexBusy(entry.status))
      )
        ? 10_000
        : 30_000,
    retry: 1,
  })
  const repositoryId =
    props.workspaceId || homeWorkspaceId || homeAttachmentTarget?.workspaceId
  const repository = useQuery({
    queryKey: ['codex', props.actor, 'repository', repositoryId],
    queryFn: ({ signal }) => {
      if (!repositoryId) throw new Error(t('Select environment'))
      return codexApi.repository(repositoryId, signal)
    },
    enabled: !!repositoryId,
    staleTime: 5000,
    retry: 1,
  })
  const checkout = useMutation({
    mutationFn: (input: { branch: string; remote?: string }) => {
      if (!repositoryId) throw new Error(t('Select environment'))
      return codexApi.checkoutBranch(repositoryId, input)
    },
    onSuccess: () => {
      if (!currentActor()) return
      void client.invalidateQueries({ queryKey: ['codex', props.actor] })
    },
    onError: (error) => toast.error(t(codexError(error))),
  })
  const indexedWorkspaceIds = searchOpen
    ? (list.data?.workspaces ?? []).map((entry) => entry.id)
    : expandedWorkspaceIds
  const searchResults = useQuery({
    queryKey: ['codex', props.actor, 'search', debouncedSearch],
    queryFn: ({ signal }) => codexApi.search(debouncedSearch, signal),
    enabled: searchOpen && !!debouncedSearch,
    retry: 1,
  })
  const conversationQueries = useQueries({
    queries: indexedWorkspaceIds.map((id) => ({
      queryKey: ['codex', props.actor, 'conversations', id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        codexApi.conversations(id, signal),
      refetchInterval: (query: {
        state: { data?: { conversations: CodexProjectConversation[] } }
      }) =>
        query.state.data?.conversations.some((entry) =>
          isCodexBusy(entry.status)
        )
          ? 10_000
          : 30_000,
      retry: 1,
    })),
  })
  const environmentQuery = useQuery({
    queryKey: ['codex', props.actor, 'environment'],
    queryFn: ({ signal }) => codexApi.environment(signal),
    refetchInterval: (query) =>
      environmentsOpen ||
      query.state.data?.environment.status === 'starting' ||
      query.state.data?.environment.activeTasks?.length
        ? 5000
        : 30_000,
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
  const detail = useCodexThread(
    props.workspaceId,
    props.actor,
    props.conversationId
  )
  const workspace = detail.data?.workspace
  const attachments = useCodexAttachments(
    props.actor,
    props.workspaceId || homeAttachmentTarget?.workspaceId,
    workspace?.conversationId || homeAttachmentTarget?.conversationId,
    status.data?.limits.uploadBytes ?? 25 * 1024 * 1024
  )
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
  }, [props.workspaceId, props.conversationId, props.actor, client])
  const running =
    taskRunning ||
    !!environmentQuery.data?.environment.activeTasks?.some(
      (task) =>
        task.workspaceId === props.workspaceId &&
        task.conversationId ===
          (props.conversationId || workspace?.conversationId)
    )
  const ready = !!status.data?.available && !!status.data.configured
  const environment = environmentQuery.data?.environment
  const remote =
    workspace?.remote ||
    (!props.workspaceId
      ? list.data?.workspaces.find((entry) => entry.id === homeWorkspaceId)
          ?.remote
      : undefined)
  const host =
    workspace?.host ||
    (!props.workspaceId
      ? list.data?.workspaces.find((entry) => entry.id === homeWorkspaceId)
          ?.host
      : undefined)
  const allowHost = (user?.role ?? 0) >= 10
  let workspaceExecutionType: ExecutionTarget['type'] = 'docker'
  if (remote) workspaceExecutionType = 'ssh'
  if (host) workspaceExecutionType = 'host'
  let environmentTitle = t('Docker environment')
  if (environmentView === 'cloud') environmentTitle = t('Codex Cloud')
  if (environmentView === 'host') environmentTitle = t('Host')
  const environmentUnavailable =
    !remote &&
    !host &&
    executionTarget.type !== 'host' &&
    (environmentQuery.isError || !environment)
  const environmentStarting =
    !remote &&
    !host &&
    (environment?.status === 'starting' || environmentChange.isPending)
  const otherProjectRunning =
    !!environment?.activeWorkspaceId &&
    (environment.activeWorkspaceId !== props.workspaceId ||
      (!!environment.activeConversationId &&
        environment.activeConversationId !==
          (props.conversationId || workspace?.conversationId)))
  const environmentBusy = running
  const ownerEnvironmentBusy =
    !!environment?.activeWorkspaceId || !!environment?.activeTasks?.length
  const creationBlocked = environmentStarting || environmentUnavailable
  const mutationBlocked =
    ownerEnvironmentBusy || environmentStarting || environmentUnavailable
  let workspaceSaveStatus = running ? t('Working') : t('Saved project')
  if (running && !taskRunning) workspaceSaveStatus = t('Finishing task...')
  if (detail.data?.persistenceError) {
    workspaceSaveStatus = t('Project not saved')
  }
  const {
    model: currentModel,
    group: currentGroup,
    effort: currentEffort,
  } = resolveModelPreferences(
    modelPreferences,
    status.data,
    catalog.data,
    workspace
  )
  const groupModels = catalog.data?.groups?.find(
    (entry) => entry.id === currentGroup
  )?.models
  const modelSupported =
    !catalog.data?.groups ||
    !!groupModels?.some((entry) => entry.id === currentModel && entry.supported)
  useEffect(() => {
    setMode(preferredMode.current)
    setInspectorOpen(window.matchMedia('(min-width: 1024px)').matches)
  }, [props.workspaceId, props.conversationId])
  useEffect(() => {
    if (workspaceLoaded) setMode(workspace?.mode ?? 'code')
  }, [
    props.workspaceId,
    props.conversationId,
    workspaceLoaded,
    workspace?.mode,
  ])
  const change = useMutation({
    mutationFn: async (action: {
      type: 'rename' | 'archive' | 'delete' | 'interrupt' | 'import' | 'export'
      file?: File
      workspaceId?: string
    }) => {
      const requestedWorkspaceId = action.workspaceId
      let target = projectTarget || workspace
      if (requestedWorkspaceId) {
        target =
          workspace?.id === requestedWorkspaceId
            ? workspace
            : list.data?.workspaces.find(
                (entry) => entry.id === requestedWorkspaceId
              )
      }
      if (!target) return
      if (action.type === 'rename') {
        await codexApi.update(target.id, { name: name.trim() })
      }
      if (action.type === 'archive') {
        await codexApi.update(target.id, { archived: !target.archived })
      }
      if (action.type === 'delete') await codexApi.remove(target.id)
      if (action.type === 'interrupt') {
        await codexApi.interrupt(target.id, props.conversationId)
      }
      if (action.type === 'import' && action.file) {
        await codexApi.import(target.id, action.file)
        toast.success(t('Project files imported.'))
      }
      if (action.type === 'export') {
        downloadCodexFile(
          await codexApi.export(target.id),
          `${target.name.replaceAll(/[^\p{L}\p{N}_.-]+/gu, '-') || 'workspace'}.zip`
        )
      }
      return { type: action.type, workspaceId: target.id }
    },
    onSuccess: (action) => {
      if (!currentActor()) return
      setConfirm(null)
      void client.invalidateQueries({ queryKey: ['codex', props.actor] })
      setProjectTarget(null)
      if (
        action?.type === 'delete' &&
        props.workspaceId === action.workspaceId
      ) {
        props.onSelect(undefined)
      }
    },
  })
  const setupWorkspaceInUse =
    isAxiosError<{ code?: string }>(change.error) &&
    change.error.response?.data?.code === 'environment_workspace_in_use'
  async function create(input: CodexCreateInput) {
    const result = await codexApi.create(input)
    await client.invalidateQueries({
      queryKey: ['codex', props.actor, 'list'],
    })
    void client.invalidateQueries({
      queryKey: ['codex', props.actor, 'environment'],
    })
    if (!currentActor()) return
    if (props.workspaceId) {
      props.onSelect(result.workspace.id)
    } else {
      setHomeWorkspaceId(result.workspace.id)
      let type: ExecutionTarget['type'] = 'docker'
      if (result.workspace.host) type = 'host'
      else if (result.workspace.remote) type = 'ssh'
      setExecutionTarget({ type })
      const target = {
        actor: props.actor,
        workspaceId: result.workspace.id,
        conversationId: result.workspace.conversationId,
      }
      homeProject.current = target
      preparedHomeProjects.current.set(result.workspace.id, target)
      setHomeAttachmentTarget(target)
    }
    setSidebarOpen(false)
  }
  async function prepareHomeProject(name = t('New task')) {
    if (homeProject.current?.actor === props.actor) return homeProject.current
    if (preparingHome.current) return preparingHome.current
    let requestProject: ReturnType<typeof codexApi.create>
    if (executionTarget.type === 'cloud') {
      if (!executionTarget.environmentId) {
        throw new Error(
          t('Select a published environment to start a cloud task.')
        )
      }
      let requestId = cloudTaskRequests.current.get(homeDraftKey)
      if (!requestId) {
        requestId = crypto.randomUUID()
        cloudTaskRequests.current.set(homeDraftKey, requestId)
      }
      requestProject = cloudApi.startTask(executionTarget.environmentId, {
        name,
        requestId,
      })
    } else if (homeWorkspaceId) {
      requestProject = codexApi.createConversation(homeWorkspaceId)
    } else {
      if (executionTarget.type === 'ssh' || executionTarget.type === 'host') {
        throw new Error(
          t(
            executionTarget.type === 'host'
              ? 'Choose a host project to work on the server.'
              : 'Choose a remote project to work over SSH.'
          )
        )
      }
      requestProject = codexApi.create({ name })
    }
    const request = requestProject.then((result) => {
      const target = {
        actor: props.actor,
        workspaceId: result.workspace.id,
        conversationId:
          ('conversationId' in result
            ? (result.conversationId as string | undefined)
            : undefined) || result.workspace.conversationId,
      }
      if (currentActor()) {
        homeProject.current = target
        preparedHomeProjects.current.set(homeDraftKey, target)
        setHomeAttachmentTarget(target)
        void client.invalidateQueries({
          queryKey: ['codex', props.actor, 'list'],
        })
      }
      return target
    })
    preparingHome.current = request
    setOpeningChat(true)
    try {
      return await request
    } finally {
      preparingHome.current = null
      if (currentActor()) setOpeningChat(false)
    }
  }
  async function attachFiles(files: File[]) {
    if (!files.length) return
    if (props.workspaceId) {
      attachments.uploadFiles(files)
      return
    }
    const requestedSelection = selectionKey
    try {
      const target = await prepareHomeProject()
      if (!currentActor() || currentSelection.current !== requestedSelection) {
        return
      }
      attachments.uploadFiles(files, target)
    } catch (error) {
      if (currentActor()) toast.error(t(codexError(error)))
    }
  }
  const parallelRequests = useRef(
    new Map<string, ReturnType<typeof codexApi.createConversation>>()
  )
  async function submitParallel(input: CodexTurnInput) {
    if (
      !currentActor() ||
      currentSelection.current !== selectionKey ||
      !props.workspaceId
    ) {
      throw new Error(
        t(
          'The session or project changed. Please open the project to continue.'
        )
      )
    }
    const key = `${props.actor}:${input.requestId}`
    let creating = parallelRequests.current.get(key)
    if (!creating) {
      creating = codexApi.createConversation(props.workspaceId)
      parallelRequests.current.set(key, creating)
      void creating.catch(() => {
        if (parallelRequests.current.get(key) === creating) {
          parallelRequests.current.delete(key)
        }
      })
    }
    const target = await creating
    if (!currentActor() || currentSelection.current !== selectionKey) {
      throw new Error(
        t(
          'The session or project changed. Please open the project to continue.'
        )
      )
    }
    await codexApi.turn(target.workspace.id, input, target.conversationId)
    parallelRequests.current.delete(key)
    await client.invalidateQueries({ queryKey: ['codex', props.actor] })
    if (currentActor() && currentSelection.current === selectionKey) {
      props.onSelect(target.workspace.id, target.conversationId)
    }
  }
  async function submitWithAttachments(
    input: CodexTurnInput,
    parallel = false
  ) {
    const paths = attachments.uploadedFiles
    const prompt = paths.length
      ? `${input.prompt}\n\nUploaded project files:\n${paths.map((path) => `- ${JSON.stringify(path)}`).join('\n')}`
      : input.prompt
    if (prompt.length > 100_000) {
      throw new Error(
        t('The message and file references exceed the task limit.')
      )
    }
    if (parallel) await submitParallel({ ...input, prompt })
    else await submit({ ...input, prompt })
    attachments.clearSubmitted(paths)
  }
  async function submit(input: CodexTurnInput) {
    if (!currentActor() || currentSelection.current !== selectionKey) {
      throw new Error(
        t(
          'The session or project changed. Please open the project to continue.'
        )
      )
    }
    let id = props.workspaceId
    let conversationId = props.conversationId
    if (!id) {
      const target = await prepareHomeProject(
        input.prompt.trim().split('\n')[0].slice(0, 80) || t('New task')
      )
      id = target.workspaceId
      conversationId = target.conversationId
      if (!currentActor() || currentSelection.current !== selectionKey) {
        throw new Error(
          t(
            'The session or project changed. Please open the project to continue.'
          )
        )
      }
    }
    await codexApi.turn(id, input, conversationId)
    if (!currentActor() || currentSelection.current !== selectionKey) return
    homeProject.current = null
    preparedHomeProjects.current.delete(homeDraftKey)
    cloudTaskRequests.current.delete(homeDraftKey)
    setHomeAttachmentTarget(null)
    setFocusTurnId(undefined)
    setFocusTurnIndex(undefined)
    setScrollToLatestKey((value) => value + 1)
    await client.invalidateQueries({ queryKey: ['codex', props.actor] })
    props.onSelect(id, conversationId)
  }

  const conversationChange = useMutation({
    mutationFn: (input: { workspaceId: string; selection: string }) =>
      codexApi.createConversation(input.workspaceId),
    onSuccess: (result, input) => {
      if (!currentActor() || currentSelection.current !== input.selection) {
        return
      }
      const conversationId = result.conversationId
      client.setQueryData(
        [
          'codex',
          props.actor,
          'workspace',
          result.workspace.id,
          conversationId || 'default',
        ],
        result
      )
      void client.invalidateQueries({ queryKey: ['codex', props.actor] })
      selectWorkspace(result.workspace.id, conversationId)
    },
    onError: (error) => toast.error(t(codexError(error))),
  })
  function newConversation(workspaceId: string) {
    if (canDiscard()) {
      conversationChange.mutate({
        workspaceId,
        selection: currentSelection.current,
      })
    }
  }
  const conversationAction = useMutation({
    mutationFn: async (input: {
      workspaceId: string
      conversationId: string
      type: 'rename' | 'archive' | 'delete'
      name?: string
      archived?: boolean
    }) => {
      if (input.type === 'delete') {
        return codexApi.deleteConversation(
          input.workspaceId,
          input.conversationId
        )
      }
      return codexApi.updateConversation(
        input.workspaceId,
        input.conversationId,
        input.type === 'rename'
          ? { name: input.name }
          : { archived: input.archived }
      )
    },
    onSuccess: (result, input) => {
      if (!currentActor()) return
      setConversationDialog(null)
      if (
        input.type === 'delete' &&
        props.workspaceId === input.workspaceId &&
        workspace?.conversationId === input.conversationId
      ) {
        setDirty(false)
        props.onSelect(input.workspaceId, result.conversationId)
        setSidebarOpen(false)
      }
      void client.invalidateQueries({ queryKey: ['codex', props.actor] })
    },
    onError: (error) => toast.error(t(codexError(error))),
  })
  async function retryMessage(turnId: string, prompt: string) {
    await submit({
      prompt,
      replayTurnId: turnId,
      requestId: crypto.randomUUID(),
      model: currentModel,
      group: currentGroup,
      effort: currentEffort,
      mode,
    })
  }
  async function deleteMessage(turnId: string, role: 'user' | 'assistant') {
    const id = props.workspaceId
    if (!id) return
    const result = await codexApi.deleteMessage(
      id,
      turnId,
      role,
      props.conversationId
    )
    if (!currentActor() || currentSelection.current !== selectionKey) return
    client.setQueryData(
      [
        'codex',
        props.actor,
        'workspace',
        id,
        props.conversationId || 'default',
      ],
      result
    )
  }
  async function approve(id: string, answer: CodexApprovalAnswer) {
    if (!props.workspaceId) return
    await codexApi.approve(props.workspaceId, id, answer, props.conversationId)
    await client.invalidateQueries({
      queryKey: [
        'codex',
        props.actor,
        'workspace',
        props.workspaceId,
        props.conversationId || 'default',
      ],
    })
  }
  function chooseModel(value: string, groupValue?: string) {
    const next = resolveModelPreferences(
      {
        version: 1,
        model: value,
        group: groupValue ?? currentGroup,
        effort: currentEffort,
      },
      status.data,
      catalog.data,
      workspace
    )
    setModelPreferences(next)
    saveModelPreferences(props.actor, next)
  }
  function chooseEffort(value: string) {
    const next = resolveModelPreferences(
      { version: 1, model: currentModel, group: currentGroup, effort: value },
      status.data,
      catalog.data,
      workspace
    )
    setModelPreferences(next)
    saveModelPreferences(props.actor, next)
  }
  const workspaces = (list.data?.workspaces ?? []).map((entry) =>
    entry.id === workspace?.id ? workspace : entry
  )
  function chooseHomeWorkspace(id?: string) {
    if (openingChat || attachments.uploading) return
    setHomeWorkspaceId(id)
    const project = workspaces.find((entry) => entry.id === id)
    let type: ExecutionTarget['type'] = 'docker'
    if (project?.host) type = 'host'
    else if (project?.remote) type = 'ssh'
    setExecutionTarget({ type })
    const target = preparedHomeProjects.current.get(id || 'blank') ?? null
    homeProject.current = target
    setHomeAttachmentTarget(target)
  }
  function chooseExecutionTarget(value: ExecutionTarget) {
    if (openingChat || attachments.uploading) return
    setExecutionTarget(value)
    const project = workspaces.find((entry) => entry.id === homeWorkspaceId)
    let nextWorkspaceId = homeWorkspaceId
    if (
      value.type === 'cloud' ||
      (value.type === 'host' && !project?.host) ||
      (value.type === 'ssh' && !project?.remote) ||
      (value.type === 'docker' && (project?.remote || project?.host))
    ) {
      nextWorkspaceId = undefined
      setHomeWorkspaceId(undefined)
    }
    const draftKey =
      value.type === 'cloud'
        ? `cloud:${value.environmentId || 'unselected'}`
        : nextWorkspaceId || 'blank'
    const target = preparedHomeProjects.current.get(draftKey) ?? null
    homeProject.current = target
    setHomeAttachmentTarget(target)
    if ((value.type === 'ssh' || value.type === 'host') && !nextWorkspaceId) {
      setCreateSource(value.type)
      setCreateOpen(true)
    }
  }
  function startCloudTask(environment: CloudEnvironment) {
    if (!selectWorkspace(undefined)) return
    chooseExecutionTarget({ type: 'cloud', environmentId: environment.id })
    setEnvironmentsOpen(false)
    setSettingsOpen(false)
  }
  function manageCloudEnvironments(create = false) {
    setEnvironmentView('cloud')
    setCreateCloudEnvironment(create)
    setEnvironmentsOpen(true)
  }
  function taskConversation(task: CodexTask): CodexProjectConversation {
    return {
      id: task.conversationId,
      name: task.title,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      turnCount: task.turnCount,
      archived: task.conversationArchived,
    }
  }
  let blockedReason: string | undefined
  if (
    !props.workspaceId &&
    executionTarget.type === 'cloud' &&
    !executionTarget.environmentId
  ) {
    blockedReason = t('Select a published environment to start a cloud task.')
  } else if (
    !props.workspaceId &&
    (executionTarget.type === 'ssh' || executionTarget.type === 'host') &&
    !homeWorkspaceId
  ) {
    blockedReason = t(
      executionTarget.type === 'host'
        ? 'Choose a host project to work on the server.'
        : 'Choose a remote project to work over SSH.'
    )
  } else if (!modelSupported) {
    blockedReason = t(
      'Choose an available model and group before starting a task.'
    )
  } else if (catalog.isError) {
    blockedReason = t(
      'Models could not be loaded. Try again before starting a task.'
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
      key={`${selectionKey}:${props.workspaceId ? '' : homeDraftKey}`}
      draftKey={`${props.actor}:${selectionKey}:${props.workspaceId ? '' : homeDraftKey}`}
      contextControls={
        <>
          {!props.workspaceId && (
            <CodexProjectPicker
              workspaces={workspaces}
              selected={homeWorkspaceId}
              onSelect={chooseHomeWorkspace}
              onCreate={() => {
                setCreateSource('git')
                setCreateOpen(true)
              }}
              onConnections={() => setConnectionsOpen(true)}
              disabled={openingChat || attachments.uploading}
              loading={list.isLoading}
            />
          )}
          <ExecutionTargetPicker
            allowHost={allowHost}
            actor={props.actor}
            value={
              props.workspaceId
                ? { type: workspaceExecutionType }
                : executionTarget
            }
            onChange={chooseExecutionTarget}
            onManageEnvironments={() => manageCloudEnvironments()}
            onCreateEnvironment={() => manageCloudEnvironments(true)}
            disabled={
              !!props.workspaceId || openingChat || attachments.uploading
            }
          />
          {!!repositoryId && (
            <CodexBranchPicker
              repository={repository.data?.repository}
              loading={repository.isLoading}
              error={
                repository.isError ? codexError(repository.error) : undefined
              }
              onRetry={() => void repository.refetch()}
              onSelect={(branch, remote) => checkout.mutate({ branch, remote })}
              disabled={
                running ||
                checkout.isPending ||
                attachments.uploading ||
                !!props.workspaceId
              }
            />
          )}
        </>
      }
      status={status.data}
      catalog={catalog.data?.groups ? catalog.data : undefined}
      group={currentGroup}
      catalogLoading={catalog.isLoading}
      catalogError={catalog.isError}
      onCatalogRetry={() => void catalog.refetch()}
      model={currentModel}
      effort={currentEffort}
      mode={mode}
      onModel={chooseModel}
      onEffort={chooseEffort}
      onMode={chooseMode}
      onSubmit={submitWithAttachments}
      onParallel={
        props.workspaceId
          ? (input) => submitWithAttachments(input, true)
          : undefined
      }
      busy={environmentBusy}
      queuedTurns={detail.data?.queuedTurns}
      onCancelQueued={async (requestId) => {
        if (!workspace) return
        await codexApi.cancelQueued(
          workspace.id,
          requestId,
          props.conversationId
        )
        await client.invalidateQueries({ queryKey: ['codex', props.actor] })
      }}
      onResumeQueued={async (requestId) => {
        const queued = detail.data?.queuedTurns?.find(
          (entry) => entry.requestId === requestId
        )
        if (!queued) return
        await submit({
          requestId: queued.requestId,
          prompt: queued.prompt,
          model: queued.model,
          group: queued.group,
          effort: queued.effort,
          mode: queued.mode,
          busyAction: 'queue',
        })
      }}
      onUploadFiles={() => fileUploadInput.current?.click()}
      onAttachFiles={(files) => {
        void attachFiles(files)
      }}
      uploading={attachments.uploading}
      uploadedFiles={attachments.uploadedFiles}
      onRemoveUploadedFile={attachments.removeFile}
      onStop={() =>
        change
          .mutateAsync({ type: 'interrupt', workspaceId: workspace?.id })
          .then(() => undefined)
      }
      running={running}
      finishing={running && !taskRunning}
      disabled={
        !ready ||
        (!props.workspaceId &&
          executionTarget.type === 'cloud' &&
          !executionTarget.environmentId) ||
        (!props.workspaceId &&
          (executionTarget.type === 'ssh' || executionTarget.type === 'host') &&
          !homeWorkspaceId) ||
        openingChat ||
        !modelSupported ||
        catalog.isError ||
        catalog.isLoading ||
        environmentUnavailable ||
        environmentStarting ||
        attachments.uploading ||
        change.isPending ||
        checkout.isPending ||
        !!workspace?.archived ||
        !!workspace?.conversationArchived ||
        (!!props.workspaceId && !workspace)
      }
      compact={!!props.workspaceId}
      workspaceTitle={workspace?.name}
      blockedReason={blockedReason}
    />
  )
  const conversationsByWorkspace: Record<string, CodexProjectConversation[]> =
    {}
  const conversationErrors: Record<string, string | undefined> = {}
  const loadingWorkspaceIds: string[] = []
  indexedWorkspaceIds.forEach((id, index) => {
    const query = conversationQueries[index]
    conversationsByWorkspace[id] =
      query.data?.conversations ??
      (id === props.workspaceId ? (detail.data?.conversations ?? []) : [])
    if (query.isLoading) loadingWorkspaceIds.push(id)
    if (query.isError) conversationErrors[id] = t(codexError(query.error))
  })
  return (
    <div
      data-workspace-shell
      className='codex-zcode codex-chatgpt codex-web codex-workspace-shell chatgpt-shell relative isolate flex h-full min-h-0 min-w-0 flex-1 overflow-hidden'
    >
      <WorkspaceList
        presentation='sidebar'
        onManage={() => {
          setSidebarOpen(false)
          setBulkOpen(true)
        }}
        onEnvironments={() => manageCloudEnvironments()}
        onPullRequests={() => setPullRequestsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        tasks={
          <SidebarTasks
            workspaceId={props.workspaceId}
            conversationId={workspace?.conversationId || props.conversationId}
            tasks={tasks.data?.pages.flatMap((page) => page.tasks) ?? []}
            loading={tasks.isLoading}
            error={tasks.isError ? codexError(tasks.error) : undefined}
            onRetry={() => void tasks.refetch()}
            onSelect={selectWorkspace}
            onRename={(task) => {
              setConversationName(task.title)
              setConversationDialog({
                type: 'rename',
                workspaceId: task.workspaceId,
                conversation: taskConversation(task),
              })
            }}
            onArchive={(task) => {
              if (task.workspaceArchived) return
              conversationAction.mutate({
                type: 'archive',
                workspaceId: task.workspaceId,
                conversationId: task.conversationId,
                archived: !task.conversationArchived,
              })
            }}
            onDelete={(task) =>
              setConversationDialog({
                type: 'delete',
                workspaceId: task.workspaceId,
                conversation: taskConversation(task),
              })
            }
            onSearch={(query = '') => {
              setSearchQuery(query)
              setSearchOpen(true)
            }}
            disabled={conversationAction.isPending || change.isPending}
            hasMore={tasks.hasNextPage}
            loadingMore={tasks.isFetchingNextPage}
            onLoadMore={() => void tasks.fetchNextPage()}
          />
        }
        workspaces={workspaces}
        selected={props.workspaceId}
        open={sidebarOpen}
        onClose={closeSidebar}
        onNew={newConversation}
        onNewChat={() => selectWorkspace(undefined)}
        onSearch={() => {
          setSidebarOpen(false)
          setSearchOpen(true)
        }}
        newDisabled={creationBlocked || conversationChange.isPending}
        onCreate={() => {
          setSidebarOpen(false)
          setCreateSource('blank')
          setCreateOpen(true)
        }}
        onConnections={() => {
          setSidebarOpen(false)
          setConnectionsOpen(true)
        }}
        renderProjectActions={(entry) => (
          <WorkspaceActions
            workspace={entry}
            disabled={mutationBlocked || change.isPending}
            onRename={() => {
              change.reset()
              setProjectTarget(entry)
              setName(entry.name)
              setConfirm('rename')
            }}
            onDelete={() => {
              change.reset()
              setProjectTarget(entry)
              setConfirm('delete')
            }}
            onArchive={() =>
              change.mutate({ type: 'archive', workspaceId: entry.id })
            }
            onExport={() =>
              change.mutate({ type: 'export', workspaceId: entry.id })
            }
            onImport={() => {
              uploadTarget.current = entry.id
              upload.current?.click()
            }}
          />
        )}
        expandedWorkspaceIds={expandedWorkspaceIds}
        onToggleWorkspace={(id) =>
          setExpandedWorkspaceIds((ids) =>
            ids.includes(id)
              ? ids.filter((entry) => entry !== id)
              : [...ids, id]
          )
        }
        conversationsByWorkspace={conversationsByWorkspace}
        loadingWorkspaceIds={loadingWorkspaceIds}
        conversationErrors={conversationErrors}
        onRetryConversations={(id) =>
          void client.invalidateQueries({
            queryKey: ['codex', props.actor, 'conversations', id],
          })
        }
        conversationActionsDisabled={
          change.isPending || conversationAction.isPending
        }
        onRenameConversation={(workspaceId, conversation) => {
          setConversationName(conversation.name)
          setConversationDialog({ type: 'rename', workspaceId, conversation })
        }}
        onArchiveConversation={(workspaceId, conversation) => {
          conversationAction.mutate({
            type: 'archive',
            workspaceId,
            conversationId: conversation.id,
            archived: !conversation.archived,
          })
        }}
        onDeleteConversation={(workspaceId, conversation) => {
          const selected =
            props.workspaceId === workspaceId &&
            workspace?.conversationId === conversation.id
          if (!selected || canDiscard()) {
            setConversationDialog({
              type: 'delete',
              workspaceId,
              conversation,
            })
          }
        }}
        conversationId={workspace?.conversationId}
        onConversation={selectWorkspace}
        createDisabled={!ready || creationBlocked}
        onSelect={selectWorkspace}
        onBack={props.onBack}
        loading={list.isLoading}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        brand={<SystemBrand variant='inline' />}
        footer={
          <div className='chatgpt-account-row flex min-w-0 items-center gap-2 rounded-lg px-1 py-1.5'>
            <ProfileDropdown />
            <button
              type='button'
              className='min-w-0 flex-1 text-left'
              onClick={() => {
                setSidebarOpen(false)
                setSettingsOpen(true)
              }}
              aria-label={t('Account settings')}
            >
              <span className='block truncate text-sm font-medium'>
                {user?.display_name || user?.username || t('Account')}
              </span>
              <span className='text-muted-foreground block truncate text-xs'>
                New API
              </span>
            </button>
            <Button
              type='button'
              variant='ghost'
              size='icon-md'
              aria-label={t('Settings')}
              onClick={() => {
                setSidebarOpen(false)
                setSettingsOpen(true)
              }}
            >
              <Settings />
            </Button>
          </div>
        }
      />
      <div className='chatgpt-main bg-panel flex min-h-0 min-w-0 flex-1 flex-col'>
        <header className='chatgpt-header codex-task-header flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-5'>
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className='size-10 md:hidden'
            aria-label={t('Open project list')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu aria-hidden />
          </Button>
          <div className='flex min-w-0 flex-1 flex-col justify-center'>
            <h1 className='truncate text-sm font-medium sm:text-base'>
              {workspace?.conversationName || workspace?.name || t('New task')}
            </h1>
            {workspace && (
              <div
                className='text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs'
                title={workspaceSaveStatus}
              >
                <span className='truncate'>{workspace.name}</span>
                {repository.data?.repository.branch && (
                  <>
                    <span aria-hidden>·</span>
                    <GitBranch className='size-3 shrink-0' />
                    <span className='truncate'>
                      {repository.data.repository.branch}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          {!props.workspaceId && (
            <>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={() => manageCloudEnvironments()}
              >
                {t('Environments')}
              </Button>
              <ProfileDropdown />
            </>
          )}
          {remote && (
            <Button
              type='button'
              variant='ghost'
              size='icon-md'
              aria-label={t('Remote server details')}
              onClick={() => {
                setConnectionTab('ssh')
                setConnectionsOpen(true)
              }}
            >
              <Server />
            </Button>
          )}
          {workspace && (
            <Button
              ref={inspectorTrigger}
              type='button'
              variant={inspectorOpen ? 'secondary' : 'ghost'}
              size='sm'
              className='rounded-full'
              aria-label={t('Review changes')}
              aria-pressed={inspectorOpen}
              onClick={() => {
                if (!inspectorOpen || canDiscard()) {
                  setDirty(false)
                  setInspectorOpen(!inspectorOpen)
                }
              }}
            >
              <GitCompareArrows className='size-4' />
              <span className='hidden sm:inline'>{t('Changes')}</span>
            </Button>
          )}
          <Button
            type='button'
            variant='ghost'
            size='icon-md'
            className={!props.workspaceId ? 'hidden' : undefined}
            aria-label={t('New task')}
            onClick={() => selectWorkspace(undefined)}
          >
            <SquarePen />
          </Button>
          {workspace && detail.data && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-md'
                    aria-label={t('Conversation options')}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='end'
                className='codex-zcode codex-chatgpt chatgpt-popover'
              >
                <DropdownMenuItem
                  onClick={() => {
                    if (!detail.data) return
                    const file = exportCodexConversation(
                      detail.data,
                      'markdown',
                      { translate: (key) => t(key) }
                    )
                    downloadCodexFile(
                      new Blob([file.content], { type: file.mimeType }),
                      file.filename
                    )
                  }}
                >
                  <Download className='size-4' />
                  {t('Export conversation as Markdown')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    if (!detail.data) return
                    const file = exportCodexConversation(detail.data, 'json', {
                      translate: (key) => t(key),
                    })
                    downloadCodexFile(
                      new Blob([file.content], { type: file.mimeType }),
                      file.filename
                    )
                  }}
                >
                  <Download className='size-4' />
                  {t('Export conversation as JSON')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>
        {workspace && (
          <span
            role='status'
            aria-label={t('Project save status')}
            className='sr-only'
          >
            {workspaceSaveStatus}
          </span>
        )}

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
        {change.isError && confirm === null && (
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
          <div className='codex-new-task-page min-h-0 flex-1 overflow-y-auto'>
            <div className='codex-new-task-content mx-auto flex w-full max-w-3xl flex-col px-5 py-16 sm:px-8'>
              <div className='codex-new-task-heading mb-8'>
                <h2 className='text-3xl font-medium tracking-tight'>
                  {t('What do you want to build?')}
                </h2>
                <p className='text-muted-foreground mt-3 text-sm'>
                  {t(
                    'Choose a project and a place to work, then give Codex a task.'
                  )}
                </p>
              </div>
              {composer}
              {attachments.error && (
                <p role='alert' className='text-destructive px-5 text-sm'>
                  {attachments.error}
                </p>
              )}
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
                defaultSize={inspectorOpen && wide ? '55%' : '100%'}
                minSize={wide && inspectorOpen ? '28%' : '0%'}
                className='codex-task-transcript flex min-h-0 min-w-0 flex-col'
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
                      workspaceId={workspace.id}
                      actor={props.actor}
                      remoteRoot={workspace.remote?.path}
                      initialFile={props.filePath}
                      initialLine={props.fileLine}
                      thread={detail.data?.thread ?? null}
                      scrollToLatestKey={scrollToLatestKey}
                      branches={detail.data?.conversations}
                      conversationId={workspace.conversationId}
                      onSelectBranch={(id, turnIndex) => {
                        if (selectWorkspace(workspace.id, id)) {
                          setFocusTurnIndex(turnIndex)
                        }
                      }}
                      focusTurnId={focusTurnId}
                      focusTurnKey={focusTurnKey}
                      focusTurnIndex={focusTurnIndex}
                      onReply={(prompt) =>
                        submit({
                          prompt,
                          requestId: crypto.randomUUID(),
                          model: currentModel,
                          group: currentGroup,
                          effort: currentEffort,
                          mode,
                          ...(running ? { busyAction: 'queue' } : {}),
                        })
                      }
                      replyDisabled={
                        creationBlocked ||
                        workspace.archived ||
                        workspace.conversationArchived ||
                        !ready ||
                        !modelSupported ||
                        catalog.isLoading
                      }
                      running={taskRunning}
                      approvals={detail.data?.pendingApprovals ?? []}
                      onApprove={approve}
                      actionsDisabled={
                        mutationBlocked ||
                        workspace.archived ||
                        workspace.conversationArchived ||
                        !ready ||
                        !modelSupported ||
                        catalog.isLoading
                      }
                      onDelete={deleteMessage}
                      onRetry={retryMessage}
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
                    {workspace.conversationArchived && (
                      <p className='text-muted-foreground px-5 py-2 text-xs'>
                        {t('Restore this conversation to continue.')}
                      </p>
                    )}
                    {attachments.error && (
                      <p role='alert' className='text-destructive px-5 text-xs'>
                        {attachments.error}
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
                defaultSize={wide ? '45%' : '100%'}
                minSize={wide ? '30%' : '0%'}
                className='flex min-h-0 min-w-0 flex-col'
              >
                <WorkspaceInspector
                  key={selectionKey}
                  id={workspace.id}
                  actor={props.actor}
                  running={mutationBlocked}
                  readOnly={
                    !!workspace.archived || !!workspace.conversationArchived
                  }
                  onBusy={setInspectorBusy}
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
                      requestAnimationFrame(() =>
                        inspectorTrigger.current?.focus()
                      )
                    }
                  }}
                  onDirty={setDirty}
                />
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
        )}
      </div>
      <ChatGPTSearch
        open={searchOpen}
        initialQuery={searchQuery}
        onOpenChange={setSearchOpen}
        workspaces={workspaces}
        conversationsByWorkspace={conversationsByWorkspace}
        onSelect={selectWorkspace}
        onQueryChange={setSearchQuery}
        remoteResults={
          searchQuery.trim() === debouncedSearch
            ? searchResults.data?.results
            : []
        }
        loading={
          searchQuery.trim()
            ? searchQuery.trim() !== debouncedSearch || searchResults.isFetching
            : loadingWorkspaceIds.length > 0
        }
        hasMore={searchResults.data?.hasMore}
        error={
          searchResults.isError ? codexError(searchResults.error) : undefined
        }
        onRetry={() => void searchResults.refetch()}
      />
      <Dialog open={pullRequestsOpen} onOpenChange={setPullRequestsOpen}>
        <DialogContent className='codex-zcode codex-chatgpt codex-web max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(1120px,calc(100vw-2rem))]'>
          <DialogHeader>
            <DialogTitle>{t('Pull requests')}</DialogTitle>
            <DialogDescription>
              {t('Review repository changes and continue the work with Codex.')}
            </DialogDescription>
          </DialogHeader>
          <PullRequestPanel
            actor={props.actor}
            model={currentModel}
            group={currentGroup}
            effort={currentEffort}
            onManageConnection={() => {
              setPullRequestsOpen(false)
              setConnectionTab('github')
              setConnectionsOpen(true)
            }}
            onSelect={(id, conversationId) => {
              if (selectWorkspace(id, conversationId)) {
                setPullRequestsOpen(false)
              }
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={environmentsOpen} onOpenChange={setEnvironmentsOpen}>
        <DialogContent className='codex-zcode codex-chatgpt codex-web max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(1120px,calc(100vw-2rem))]'>
          <DialogHeader>
            <DialogTitle>{environmentTitle}</DialogTitle>
            <DialogDescription>
              {t('Choose a project and manage its development environment.')}
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              variant={environmentView === 'cloud' ? 'secondary' : 'ghost'}
              onClick={() => setEnvironmentView('cloud')}
            >
              {t('Cloud environments')}
            </Button>
            <Button
              type='button'
              variant={environmentView === 'docker' ? 'secondary' : 'ghost'}
              onClick={() => setEnvironmentView('docker')}
            >
              {t('Docker environment')}
            </Button>
            {allowHost && (
              <Button
                type='button'
                variant={environmentView === 'host' ? 'secondary' : 'ghost'}
                onClick={() => setEnvironmentView('host')}
              >
                {t('Host')}
              </Button>
            )}
          </div>
          {environmentView === 'host' && allowHost && (
            <div className='space-y-3 py-2'>
              <p className='text-muted-foreground text-sm'>
                {t('Run directly on the server (administrators only)')}
              </p>
              <Button
                type='button'
                onClick={() => {
                  setEnvironmentsOpen(false)
                  setCreateSource('host')
                  setCreateOpen(true)
                }}
              >
                {t('Create host project')}
              </Button>
              <div className='space-y-1'>
                {workspaces
                  .filter((entry) => entry.host)
                  .map((entry) => (
                    <Button
                      key={entry.id}
                      variant='ghost'
                      type='button'
                      onClick={() => {
                        setEnvironmentsOpen(false)
                        selectWorkspace(entry.id)
                      }}
                    >
                      {entry.name} · {entry.host?.path}
                    </Button>
                  ))}
              </div>
            </div>
          )}
          {environmentView === 'cloud' && (
            <CloudEnvironmentsPanel
              actor={props.actor}
              initialCreate={createCloudEnvironment}
              onStartTask={startCloudTask}
              onManageDocker={() => setEnvironmentView('docker')}
            />
          )}
          {environmentView === 'docker' && (
            <>
              <EnvironmentPanel
                environment={environment}
                loading={environmentQuery.isLoading}
                taskRunning={ownerEnvironmentBusy}
                unavailable={environmentUnavailable}
                pending={
                  environmentChange.isPending
                    ? environmentChange.variables
                    : null
                }
                error={environmentError}
                onStart={() => environmentChange.mutate('start')}
                onStop={() => environmentChange.mutate('stop')}
                onRetry={() => {
                  environmentChange.reset()
                  void environmentQuery.refetch()
                }}
                onSelect={(id, conversationId) => {
                  setEnvironmentsOpen(false)
                  selectWorkspace(id, conversationId)
                }}
              />
              <EnvironmentPorts
                actor={props.actor}
                running={environment?.status === 'running'}
              />
              <div className='flex items-center justify-between gap-2 pt-2'>
                <h3 className='font-medium'>{t('Projects')}</h3>
                <Button
                  type='button'
                  size='sm'
                  onClick={() => {
                    setEnvironmentsOpen(false)
                    setCreateSource('git')
                    setCreateOpen(true)
                  }}
                  disabled={!ready || creationBlocked}
                >
                  <FolderPlus className='size-4' />
                  {t('Create project')}
                </Button>
              </div>
              <div className='divide-y'>
                {workspaces.map((entry) => (
                  <div
                    key={entry.id}
                    className='flex min-w-0 items-center gap-2 py-3'
                  >
                    <FileCode2 className='text-muted-foreground size-4 shrink-0' />
                    <button
                      type='button'
                      className='min-w-0 flex-1 text-left'
                      onClick={() => {
                        setEnvironmentsOpen(false)
                        selectWorkspace(entry.id)
                      }}
                    >
                      <span className='block truncate font-medium'>
                        {entry.name}
                      </span>
                      <span className='text-muted-foreground text-xs'>
                        {entry.remote
                          ? entry.remote.host
                          : t('Local environment')}
                        {entry.archived ? ` · ${t('Archived')}` : ''}
                      </span>
                    </button>
                    <WorkspaceActions
                      workspace={entry}
                      disabled={mutationBlocked || change.isPending}
                      onRename={() => {
                        change.reset()
                        setEnvironmentsOpen(false)
                        setProjectTarget(entry)
                        setName(entry.name)
                        setConfirm('rename')
                      }}
                      onDelete={() => {
                        change.reset()
                        setEnvironmentsOpen(false)
                        setProjectTarget(entry)
                        setConfirm('delete')
                      }}
                      onArchive={() =>
                        change.mutate({
                          type: 'archive',
                          workspaceId: entry.id,
                        })
                      }
                      onExport={() =>
                        change.mutate({ type: 'export', workspaceId: entry.id })
                      }
                      onImport={() => {
                        uploadTarget.current = entry.id
                        upload.current?.click()
                      }}
                    />
                  </div>
                ))}
              </div>
              <Button
                type='button'
                variant='outline'
                onClick={() => {
                  setEnvironmentsOpen(false)
                  setConnectionsOpen(true)
                }}
              >
                {t('Manage connections')}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ChatgptSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        cloud={
          <CloudEnvironmentsPanel
            actor={props.actor}
            onStartTask={startCloudTask}
            onManageDocker={() => {
              setSettingsOpen(false)
              setEnvironmentView('docker')
              setEnvironmentsOpen(true)
            }}
          />
        }
        onManageEnvironments={() => manageCloudEnvironments()}
        environment={
          <div className='space-y-4'>
            <EnvironmentPanel
              environment={environment}
              loading={environmentQuery.isLoading}
              taskRunning={ownerEnvironmentBusy}
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
              onSelect={(id, conversationId) => {
                setSettingsOpen(false)
                selectWorkspace(id, conversationId)
              }}
            />
            <EnvironmentPorts
              actor={props.actor}
              running={environment?.status === 'running'}
            />
          </div>
        }
        connections={
          <div className='space-y-4'>
            <p className='text-muted-foreground text-sm'>
              {t('Connect your development server and GitHub account.')}
            </p>
            <Button
              onClick={() => {
                setSettingsOpen(false)
                setConnectionsOpen(true)
              }}
            >
              {t('Manage connections')}
            </Button>
          </div>
        }
      />
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
            file.size > (status.data?.limits.uploadBytes ?? 25 * 1024 * 1024)
          ) {
            toast.error(t('The ZIP exceeds the project upload limit.'))
            return
          }
          change.mutate({
            type: 'import',
            file,
            workspaceId: uploadTarget.current,
          })
        }}
      />
      <input
        ref={fileUploadInput}
        type='file'
        multiple
        className='hidden'
        aria-label={t('Upload project files')}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void attachFiles(files)
        }}
      />
      <CreateWorkspaceDialog
        open={createOpen}
        initialSource={createSource}
        allowHost={allowHost}
        connections={ssh.data?.connections ?? []}
        actor={props.actor}
        onManageConnections={() => {
          setCreateOpen(false)
          setConnectionTab('ssh')
          setConnectionsOpen(true)
        }}
        onClose={() => setCreateOpen(false)}
        onCreate={create}
        disabled={creationBlocked}
      />
      <Dialog open={connectionsOpen} onOpenChange={setConnectionsOpen}>
        <DialogContent className='codex-zcode codex-chatgpt max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{t('Connections')}</DialogTitle>
            <DialogDescription>
              {t('Connect your development server and GitHub account.')}
            </DialogDescription>
          </DialogHeader>
          <div
            role='tablist'
            aria-label={t('Connection type')}
            className='bg-surface flex gap-1 rounded-lg p-1'
          >
            {(['ssh', 'github'] as const).map((tab) => (
              <Button
                key={tab}
                type='button'
                role='tab'
                id={`codex-connection-tab-${tab}`}
                tabIndex={connectionTab === tab ? 0 : -1}
                onKeyDown={(event) => {
                  if (
                    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                      event.key
                    )
                  ) {
                    return
                  }
                  event.preventDefault()
                  let next: 'ssh' | 'github' =
                    connectionTab === 'ssh' ? 'github' : 'ssh'
                  if (event.key === 'Home') next = 'ssh'
                  if (event.key === 'End') next = 'github'
                  setConnectionTab(next)
                  document
                    .querySelector<HTMLElement>(`#codex-connection-tab-${next}`)
                    ?.focus()
                }}
                aria-selected={connectionTab === tab}
                aria-controls={`codex-connection-${tab}`}
                variant={connectionTab === tab ? 'secondary' : 'ghost'}
                className='flex-1'
                onClick={() => setConnectionTab(tab)}
              >
                {tab === 'ssh' ? t('Remote servers') : 'GitHub'}
              </Button>
            ))}
          </div>
          <div
            role='tabpanel'
            id={`codex-connection-${connectionTab}`}
            aria-labelledby={`codex-connection-tab-${connectionTab}`}
          >
            {connectionTab === 'github' ? (
              <>
                {githubCallbackState === 'pending' && (
                  <p role='status' className='mb-3 text-sm'>
                    {t('Completing GitHub authorization…')}
                  </p>
                )}
                {githubCallbackState === 'complete' && (
                  <p role='status' className='mb-3 text-sm'>
                    {t('GitHub authorization completed.')}
                  </p>
                )}
                {githubCallbackState === 'error' && (
                  <p role='alert' className='text-destructive mb-3 text-sm'>
                    {t(githubCallbackError)}
                  </p>
                )}
                <GitHubConnection actor={props.actor} />
              </>
            ) : (
              <>
                {remote && (
                  <div className='bg-surface mb-4 rounded-lg p-3 text-xs'>
                    <p className='font-medium break-all'>
                      {remote.username}@{remote.host}:{remote.path}
                    </p>
                    <p className='text-muted-foreground mt-1'>
                      {t(
                        'Commands and file changes run on this remote server.'
                      )}
                    </p>
                    <Button
                      variant='secondary'
                      size='sm'
                      className='mt-2'
                      disabled={remoteTest.isPending}
                      onClick={() => remoteTest.mutate(remote.connectionId)}
                    >
                      {remoteTest.isPending
                        ? t('Connecting…')
                        : t('Test connection')}
                    </Button>
                    {remoteTest.isSuccess && (
                      <p role='status' className='mt-2'>
                        {t('SSH connection is ready.')}
                      </p>
                    )}
                    {remoteTest.isError && (
                      <p role='alert' className='text-destructive mt-2'>
                        {t(codexError(remoteTest.error))}
                      </p>
                    )}
                  </div>
                )}
                <SshConnections
                  active={connectionsOpen && connectionTab === 'ssh'}
                  connections={ssh.data?.connections ?? []}
                  loading={ssh.isLoading}
                  error={ssh.isError ? codexError(ssh.error) : undefined}
                  onRefresh={() => void ssh.refetch()}
                  onProbe={codexApi.sshProbe}
                  onCreate={async (input) => {
                    await codexApi.sshCreate(input)
                    await ssh.refetch()
                  }}
                  onRemove={async (id) => {
                    await codexApi.sshRemove(id)
                    await ssh.refetch()
                  }}
                  onTest={codexApi.sshTest}
                />
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          if (!bulkBusy) setBulkOpen(open)
        }}
      >
        <DialogContent
          showCloseButton={!bulkBusy}
          className='codex-zcode codex-chatgpt chatgpt-dialog flex max-h-[90dvh] min-h-[min(640px,85dvh)] w-[calc(100%-1.5rem)] max-w-2xl flex-col overflow-hidden sm:max-w-2xl'
        >
          <DialogHeader>
            <DialogTitle>{t('Manage projects and conversations')}</DialogTitle>
            <DialogDescription>
              {t('Select items to archive, restore, or delete in bulk.')}
            </DialogDescription>
          </DialogHeader>
          <BulkManagement
            actor={props.actor}
            workspaces={workspaces}
            blocked={mutationBlocked}
            beforeChange={canDiscard}
            onBusyChange={setBulkBusy}
            isCurrentActor={currentActor}
            onComplete={async (result) => {
              if (!currentActor()) return
              for (const [key, target] of preparedHomeProjects.current) {
                if (result.deletedProjects.includes(target.workspaceId)) {
                  preparedHomeProjects.current.delete(key)
                }
              }
              if (
                homeWorkspaceId &&
                result.deletedProjects.includes(homeWorkspaceId)
              ) {
                chooseHomeWorkspace(undefined)
              }
              if (
                props.workspaceId &&
                result.deletedProjects.includes(props.workspaceId)
              ) {
                props.onSelect(undefined)
              } else if (
                props.workspaceId &&
                result.deletedConversations.some(
                  (entry) =>
                    entry.workspaceId === props.workspaceId &&
                    entry.conversationId ===
                      (workspace?.conversationId || props.conversationId)
                )
              ) {
                const replacement = [...result.deletedConversations]
                  .reverse()
                  .find((entry) => entry.workspaceId === props.workspaceId)
                if (replacement) {
                  props.onSelect(
                    replacement.workspaceId,
                    replacement.replacementId
                  )
                }
              }
              await client.invalidateQueries({
                queryKey: ['codex', props.actor],
              })
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={conversationDialog !== null}
        onOpenChange={(open) => {
          if (!open && !conversationAction.isPending) {
            setConversationDialog(null)
          }
        }}
      >
        <DialogContent className='codex-zcode codex-chatgpt chatgpt-dialog'>
          <DialogHeader>
            <DialogTitle>
              {conversationDialog?.type === 'delete'
                ? t('Delete conversation?')
                : t('Rename conversation')}
            </DialogTitle>
            <DialogDescription>
              {conversationDialog?.type === 'delete'
                ? t(
                    'This deletes this conversation and its history. Project files and other conversations are kept.'
                  )
                : t('Choose a name that helps you find this conversation.')}
            </DialogDescription>
          </DialogHeader>
          {conversationDialog?.type === 'delete' ? (
            <p className='text-sm font-medium break-words'>
              {conversationDialog.conversation.name}
            </p>
          ) : (
            <Input
              aria-label={t('Conversation name')}
              autoFocus
              value={conversationName}
              maxLength={120}
              onChange={(event) => setConversationName(event.target.value)}
            />
          )}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={conversationAction.isPending}
              onClick={() => setConversationDialog(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant={
                conversationDialog?.type === 'delete'
                  ? 'destructive'
                  : 'default'
              }
              disabled={
                conversationAction.isPending ||
                (conversationDialog?.type === 'delete' &&
                  isCodexBusy(conversationDialog.conversation.status)) ||
                (conversationDialog?.type === 'rename' &&
                  !conversationName.trim())
              }
              onClick={() => {
                if (!conversationDialog) return
                conversationAction.mutate({
                  type: conversationDialog.type,
                  workspaceId: conversationDialog.workspaceId,
                  conversationId: conversationDialog.conversation.id,
                  name: conversationName.trim(),
                })
              }}
            >
              {conversationDialog?.type === 'delete'
                ? t('Delete conversation')
                : t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !change.isPending) {
            setConfirm(null)
            setProjectTarget(null)
            change.reset()
          }
        }}
      >
        <DialogContent className='codex-zcode codex-chatgpt chatgpt-dialog'>
          <DialogHeader>
            <DialogTitle className='font-sans'>
              {confirm === 'delete'
                ? t('Delete project?')
                : t('Rename project')}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'delete'
                ? t(
                    projectTarget?.remote
                      ? 'This removes the project and all its conversations from Codex. Files on the remote server are kept.'
                      : 'This permanently deletes this project, its files, and all its conversations. Your personal environment and other projects are kept. Export anything you want to keep first.'
                  )
                : t('Choose a name that helps you find this project.')}
            </DialogDescription>
          </DialogHeader>
          {confirm !== 'delete' && (
            <Input
              aria-label={t('Project name')}
              autoFocus
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          )}
          {change.isError && (
            <div
              role='alert'
              className='bg-destructive/5 text-destructive rounded-xl px-3 py-2.5 text-sm'
            >
              {t(codexError(change.error))}
            </div>
          )}
          {confirm === 'delete' && setupWorkspaceInUse && (
            <Button
              type='button'
              variant='outline'
              onClick={() => {
                setConfirm(null)
                setProjectTarget(null)
                change.reset()
                manageCloudEnvironments()
              }}
            >
              {t('Manage environments')}
            </Button>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={change.isPending}
              onClick={() => {
                setConfirm(null)
                setProjectTarget(null)
                change.reset()
              }}
            >
              {t('Cancel')}
            </Button>
            <Button
              type='button'
              variant={confirm === 'delete' ? 'destructive' : 'default'}
              disabled={
                mutationBlocked ||
                change.isPending ||
                (confirm !== 'delete' && !name.trim())
              }
              onClick={() => {
                if (confirm) {
                  change.mutate({
                    type: confirm,
                    workspaceId: projectTarget?.id,
                  })
                }
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
