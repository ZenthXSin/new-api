import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const i18n = (await import('i18next')).default
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { api } = await import('@/lib/api')
const { useAuthStore } = await import('@/stores/auth-store')
const { AuthorizeScreen } = await import('../authorize-screen')

await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'Authorization failed': 'Authorization failed',
        'Sign in to continue': 'Sign in to continue',
        'Authorize application': 'Authorize application',
        '"{{name}}" wants to access your account':
          '{{name}} wants to access your account',
        'This application will be able to:':
          'This application will be able to:',
        'Signed in as': 'Signed in as',
        'Confirm your identity': 'Confirm your identity',
        'View your username, display name and groups':
          'View your username, display name and groups',
        'View your email address': 'View your email address',
        Approve: 'Approve',
        Deny: 'Deny',
      },
    },
  },
})

type ApiMethod = (url: string, data?: unknown) => Promise<{ data: unknown }>
type MockableApi = {
  get: ApiMethod
  post: ApiMethod
}

const apiClient = api as unknown as MockableApi
const originalGet = apiClient.get
const originalPost = apiClient.post

function mockAuthUser(user: { username: string } | null) {
  vi.spyOn(useAuthStore.getState(), 'auth', 'get').mockReturnValue({
    user,
  } as never)
}

const baseParams = {
  client_id: 'test-rp-client',
  redirect_uri: 'https://rp.example.com/cb',
  scope: 'openid profile email',
  state: 'st4te',
  nonce: 'n0nce',
}

describe('AuthorizeScreen', () => {
  const replaceMock = vi.fn()
  const originalLocation = window.location

  beforeEach(() => {
    replaceMock.mockClear()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, replace: replaceMock },
    })
  })

  afterEach(() => {
    apiClient.get = originalGet
    apiClient.post = originalPost
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
    vi.restoreAllMocks()
  })

  test('renders the error card when the request carries an OAuth error', () => {
    mockAuthUser({ username: 'alice' })
    render(
      <I18nextProvider i18n={i18n}>
        <AuthorizeScreen {...baseParams} error='invalid_request' error_description='bad scope' />
      </I18nextProvider>
    )
    expect(screen.getByText('Authorization failed')).toBeDefined()
    expect(screen.getByText('bad scope')).toBeDefined()
  })

  test('asks unauthenticated visitors to sign in without calling the API', () => {
    mockAuthUser(null)
    const getSpy = vi.fn()
    apiClient.get = getSpy
    render(
      <I18nextProvider i18n={i18n}>
        <AuthorizeScreen {...baseParams} />
      </I18nextProvider>
    )
    expect(screen.getByText('Sign in to continue')).toBeDefined()
    expect(getSpy).not.toHaveBeenCalled()
  })

  test('submits approval and redirects back with the issued code', async () => {
    mockAuthUser({ username: 'alice' })
    apiClient.get = vi.fn().mockResolvedValue({
      data: {
        success: true,
        require_consent: true,
        client: { name: 'Test RP', description: 'A nice app' },
        scopes: ['openid', 'profile', 'email'],
      },
    })
    const postSpy = vi.fn().mockResolvedValue({
      data: {
        success: true,
        redirect: 'https://rp.example.com/cb?code=abc&state=st4te',
      },
    })
    apiClient.post = postSpy

    render(
      <I18nextProvider i18n={i18n}>
        <AuthorizeScreen {...baseParams} />
      </I18nextProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('Authorize application')).toBeDefined()
    })
    expect(screen.getByText(/Test RP/)).toBeDefined()

    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        'https://rp.example.com/cb?code=abc&state=st4te'
      )
    })
    expect(postSpy).toHaveBeenCalledTimes(1)
    const [url, payload] = postSpy.mock.calls[0] as [string, unknown]
    expect(url).toBe('/api/oauth2/consent')
    expect(payload).toMatchObject({
      client_id: 'test-rp-client',
      approve: true,
      state: 'st4te',
    })
  })

  test('denying the request posts approve=false', async () => {
    mockAuthUser({ username: 'alice' })
    apiClient.get = vi.fn().mockResolvedValue({
      data: {
        success: true,
        require_consent: true,
        client: { name: 'Test RP', description: '' },
        scopes: ['openid'],
      },
    })
    const postSpy = vi.fn().mockResolvedValue({
      data: {
        success: true,
        redirect: 'https://rp.example.com/cb?error=access_denied&state=st4te',
      },
    })
    apiClient.post = postSpy

    render(
      <I18nextProvider i18n={i18n}>
        <AuthorizeScreen {...baseParams} />
      </I18nextProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('Authorize application')).toBeDefined()
    })
    fireEvent.click(screen.getByText('Deny'))

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        'https://rp.example.com/cb?error=access_denied&state=st4te'
      )
    })
    expect(postSpy.mock.calls[0][1]).toMatchObject({ approve: false })
  })

  test('navigates immediately when consent was already remembered', async () => {
    mockAuthUser({ username: 'alice' })
    apiClient.get = vi.fn().mockResolvedValue({
      data: {
        success: true,
        require_consent: false,
        redirect: 'https://rp.example.com/cb?code=xyz',
      },
    })

    render(
      <I18nextProvider i18n={i18n}>
        <AuthorizeScreen {...baseParams} />
      </I18nextProvider>
    )

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        'https://rp.example.com/cb?code=xyz'
      )
    })
  })
})
