import { describe, expect, test } from 'vitest'

import { oauthClientFormSchema } from '../types'

describe('oauth client form schema', () => {
  test('rejects a missing name', () => {
    const result = oauthClientFormSchema.safeParse({
      description: '',
      redirect_uris: ['https://rp.example.com/cb'],
      scopes: ['openid'],
      is_public: false,
      enabled: true,
    })
    expect(result.success).toBe(false)
  })

  test('requires at least one redirect URI', () => {
    const result = oauthClientFormSchema.safeParse({
      name: 'App',
      description: '',
      redirect_uris: [],
      scopes: ['openid'],
      is_public: false,
      enabled: true,
    })
    expect(result.success).toBe(false)
  })

  test('requires at least one scope', () => {
    const result = oauthClientFormSchema.safeParse({
      name: 'App',
      description: '',
      redirect_uris: ['https://rp.example.com/cb'],
      scopes: [],
      is_public: false,
      enabled: true,
    })
    expect(result.success).toBe(false)
  })

  test('accepts a valid confidential client', () => {
    const result = oauthClientFormSchema.safeParse({
      name: 'App',
      description: 'desc',
      redirect_uris: ['https://rp.example.com/cb'],
      scopes: ['openid', 'profile', 'email'],
      is_public: false,
      enabled: true,
    })
    expect(result.success).toBe(true)
  })
})
