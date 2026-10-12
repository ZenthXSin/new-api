import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { ImageTasksPanel, type ImageTasksPage } from '../image-tasks-panel'
import { UsageLogsProvider, useUsageLogsContext } from '../usage-logs-provider'

const clients: QueryClient[] = []
const animations = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'getAnimations'
)
beforeAll(() =>
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  })
)
afterAll(() => {
  if (animations) {
    Object.defineProperty(Element.prototype, 'getAnimations', animations)
  } else {
    Reflect.deleteProperty(Element.prototype, 'getAnimations')
  }
})
beforeEach(() =>
  useAuthStore.getState().auth.setUser({ id: 7, username: 'fixture', role: 10 })
)
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear())
  useAuthStore.getState().auth.setUser(null)
})
function renderPanel(scopeToggle = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  function ScopeToggle() {
    const { setViewScope } = useUsageLogsContext()
    return (
      <button type='button' onClick={() => setViewScope('self')}>
        Only mine
      </button>
    )
  }
  return render(
    <QueryClientProvider client={client}>
      <UsageLogsProvider>
        {scopeToggle && <ScopeToggle />}
        <ImageTasksPanel />
      </UsageLogsProvider>
    </QueryClientProvider>
  )
}
function page(model = 'gpt-image'): ImageTasksPage {
  return {
    total: 1,
    counts: { connecting_images: 2, generating_images: 3, active_requests: 2 },
    items: [
      {
        id: 'image-task',
        model,
        status: 'completed',
        expected_count: 1,
        completed_count: 1,
        created_at: 1720000000,
        failure: '',
        images: [
          {
            id: 'preview-0',
            url: 'https://images.example/result.png',
            local: false,
            mime: 'image/png',
          },
        ],
      },
    ],
  }
}

describe('Image generation dashboard', () => {
  test('shows live image counts and opens completed previews from the same task', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: page() },
    })
    renderPanel()
    await screen.findByText('gpt-image')
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 connecting · 3 generating'
    )
    const thumbnail = screen.getByRole('img', { name: 'Generated image' })
    expect(thumbnail).toHaveAttribute('referrerpolicy', 'no-referrer')
    await user.click(
      screen.getByRole('button', { name: 'Open generated image' })
    )
    expect(await screen.findByRole('dialog')).toHaveTextContent('image-task')
  })

  test('scope changes remove cached administrator results while self data is pending', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation((_url, config) => {
      if (config?.params?.scope === 'self') return new Promise(() => {})
      return Promise.resolve({
        data: { success: true, data: page('foreign-admin-task') },
      })
    })
    renderPanel(true)
    await screen.findByText('foreign-admin-task')
    await user.click(screen.getByRole('button', { name: 'Only mine' }))
    await waitFor(() =>
      expect(screen.queryByText('foreign-admin-task')).not.toBeInTheDocument()
    )
    expect(screen.getByText('Loading')).toBeVisible()
  })

  test('failed thumbnail downloads remain readable and retryable', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: page() },
    })
    renderPanel()
    fireEvent.error(await screen.findByRole('img', { name: 'Generated image' }))
    await user.click(
      screen.getByRole('button', { name: 'Retry image preview' })
    )
    expect(screen.getByRole('img', { name: 'Generated image' })).toBeVisible()
  })

  test('a user with no recorded requests sees the automatic recording explanation', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        success: true,
        data: {
          total: 0,
          items: [],
          counts: {
            active_requests: 0,
            connecting_images: 0,
            generating_images: 0,
          },
        },
      },
    })
    renderPanel()
    expect(
      await screen.findByText(
        'Image requests through New API appear here automatically.'
      )
    ).toBeVisible()
  })

  test('a rejected task query reports an error without stale counts', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('fixture failure'))
    renderPanel()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load image tasks'
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '0 connecting · 0 generating'
    )
  })
})
