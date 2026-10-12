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
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { z } from 'zod'

import { parseRouterSearch, stringifyRouterSearch } from '../router-search'

const authorizationSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  state: z.string(),
  nonce: z.string().optional(),
  resource: z.union([z.string(), z.array(z.string())]).optional(),
})

test.each([
  '123',
  'true',
  'null',
  '"hello"',
  '{"a":1}',
  '[1,2]',
  ' quote " and % + 中文 ',
])(
  'preserves opaque OAuth strings through parsing and serializing: %s',
  (state) => {
    const query = new URLSearchParams({
      client_id: '123',
      redirect_uri: 'https://app.example/callback',
      state,
      nonce: state,
      code: state,
    })
    const parsed = parseRouterSearch(`?${query}`)
    expect(parsed).toMatchObject({
      client_id: '123',
      state,
      nonce: state,
      code: state,
    })
    expect(parseRouterSearch(stringifyRouterSearch(parsed))).toEqual(parsed)
    const serialized = new URLSearchParams(stringifyRouterSearch(parsed))
    expect(serialized.get('state')).toBe(state)
    expect(serialized.get('code')).toBe(state)
  }
)

test('preserves ordinary numeric, boolean, and JSON filter behavior', () => {
  const parsed = parseRouterSearch(
    '?page=2&active=true&filters=%7B%22status%22%3A%5B1%2C2%5D%7D&query=example'
  )
  expect(parsed).toEqual({
    page: 2,
    active: true,
    filters: { status: [1, 2] },
    query: 'example',
  })
  expect(parseRouterSearch(stringifyRouterSearch(parsed))).toEqual(parsed)
})

test('preserves the Codex GitHub callback marker through route validation and URL normalization', async () => {
  const root = createRootRoute()
  const codex = createRoute({
    getParentRoute: () => root,
    path: '/codex',
    validateSearch: z.object({
      github_oauth: z.string().max(1).optional().catch(undefined),
      code: z.string(),
      state: z.string(),
    }),
  })
  const query = new URLSearchParams({
    github_oauth: '1',
    code: 'fixture-code',
    state: 'fixture-state',
  })
  const router = createRouter({
    routeTree: root.addChildren([codex]),
    history: createMemoryHistory({ initialEntries: [`/codex?${query}`] }),
    parseSearch: parseRouterSearch,
    stringifySearch: stringifyRouterSearch,
  })
  await router.load()
  expect(router.state.matches.at(-1)?.search).toMatchObject({
    github_oauth: '1',
    code: 'fixture-code',
    state: 'fixture-state',
  })
  expect(
    new URLSearchParams(router.state.location.searchStr).get('github_oauth')
  ).toBe('1')
})

test('keeps repeated resource values and rejects duplicate opaque single-value parameters', () => {
  const query =
    '?client_id=c&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&state=one&resource=urn%3Anew-api%3Adashboard&resource=urn%3Anew-api%3Arelay'
  const parsed = parseRouterSearch(query)
  expect(authorizationSchema.parse(parsed).resource).toEqual([
    'urn:new-api:dashboard',
    'urn:new-api:relay',
  ])
  expect(
    new URLSearchParams(stringifyRouterSearch(parsed)).getAll('resource')
  ).toEqual(['urn:new-api:dashboard', 'urn:new-api:relay'])
  expect(
    authorizationSchema.safeParse(parseRouterSearch(`${query}&state=two`))
      .success
  ).toBe(false)
})

test('preserves the nested authorization return URL through sign-in', () => {
  const destination =
    '/authorize?client_id=c&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&state=%22hello%22&resource=one&resource=two'
  const parsed = parseRouterSearch(
    `?${new URLSearchParams({ redirect: destination })}`
  )
  expect(parsed.redirect).toBe(destination)
  expect(
    new URLSearchParams(stringifyRouterSearch(parsed)).get('redirect')
  ).toBe(destination)
})

test('preserves numeric and quoted state in a real router load and client-side authorization navigation', async () => {
  const root = createRootRoute()
  const authorize = createRoute({
    getParentRoute: () => root,
    path: '/authorize',
    validateSearch: authorizationSchema,
  })
  const routeTree = root.addChildren([authorize])
  const initial = new URLSearchParams({
    client_id: '123',
    redirect_uri: 'https://app.example/callback',
    state: '123',
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/authorize?${initial}`] }),
    parseSearch: parseRouterSearch,
    stringifySearch: stringifyRouterSearch,
  })
  await router.load()
  expect(router.state.matches.at(-1)?.status).toBe('success')
  expect(router.state.matches.at(-1)?.search).toMatchObject({ state: '123' })
  const next = new URLSearchParams({
    client_id: '123',
    redirect_uri: 'https://app.example/callback',
    state: '"hello"',
  })
  await router.navigate({ href: `/authorize?${next}` })
  expect(router.state.matches.at(-1)?.status).toBe('success')
  expect(router.state.matches.at(-1)?.search).toMatchObject({
    state: '"hello"',
  })
  expect(
    new URLSearchParams(router.state.location.searchStr).get('state')
  ).toBe('"hello"')
})
