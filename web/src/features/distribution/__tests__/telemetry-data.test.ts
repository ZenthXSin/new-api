/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import { expect, test } from 'vitest'

import type { CustomEventBucket, EventTrend, UsageBucket } from '../api'
import {
  formatOnlineDuration,
  rankEventRows,
  rankUsageRows,
  summarizeEvents,
  summarizeUsage,
} from '../telemetry-data'

test('aggregates usage dimensions into a complete hourly trend', () => {
  const rows: UsageBucket[] = [
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '1.0.0',
      platform: 'linux',
      architecture: 'amd64',
      start_count: 2,
      online_seconds: 120,
      active_users: 2,
    },
    {
      app_id: 1,
      bucket_ts: 3600,
      version: '1.1.0',
      platform: 'windows',
      architecture: 'amd64',
      start_count: 3,
      online_seconds: 180,
      active_users: 3,
    },
    {
      app_id: 1,
      bucket_ts: 10800,
      version: '1.1.0',
      platform: 'windows',
      architecture: 'amd64',
      start_count: 1,
      online_seconds: 60,
      active_users: 1,
    },
  ]

  const result = summarizeUsage(rows, 3, 10800)

  expect(result.starts).toBe(6)
  expect(result.online_seconds).toBe(360)
  expect(result.active_users).toBe(6)
  expect(result.trend).toEqual([
    { bucket_ts: 3600, starts: 5, online_seconds: 300, active_users: 5 },
    { bucket_ts: 7200, starts: 0, online_seconds: 0, active_users: 0 },
    { bucket_ts: 10800, starts: 1, online_seconds: 60, active_users: 1 },
  ])
  expect(result.versions?.[0].version).toBe('1.1.0')
})

test('keeps event counts and unique IP trend values separate', () => {
  const rows: CustomEventBucket[] = [
    {
      app_id: 1,
      bucket_ts: 3600,
      name: 'opened',
      dimensions: '{"screen":"home"}',
      count: 4,
      unique_users: 1,
    },
    {
      app_id: 1,
      bucket_ts: 3600,
      name: 'opened',
      dimensions: '{"screen":"settings"}',
      count: 3,
      unique_users: 1,
    },
  ]
  const trend: EventTrend[] = [
    {
      bucket_ts: 3600,
      name: 'opened',
      count: 7,
      unique_users: 1,
    },
  ]

  const result = summarizeEvents(
    rows,
    [{ name: 'opened', unique_users: 1 }],
    trend,
    2,
    7200
  )

  expect(result.events).toEqual([{ name: 'opened', count: 7, unique_users: 1 }])
  expect(result.trend).toEqual([
    { bucket_ts: 3600, name: 'opened', count: 7, unique_users: 1 },
    { bucket_ts: 7200, name: 'opened', count: 0, unique_users: 0 },
  ])
})

test('formats online seconds as a compact Chinese duration', () => {
  expect(formatOnlineDuration(0)).toBe('0秒')
  expect(formatOnlineDuration(1)).toBe('1秒')
  expect(formatOnlineDuration(65)).toBe('1分5秒')
  expect(formatOnlineDuration(3661)).toBe('1小时1分')
})

test('ranks usage and event rows by the selected metric', () => {
  const usageRows = [
    { name: 'starts-first', starts: 20, online_seconds: 30, active_users: 5 },
    { name: 'users-first', starts: 2, online_seconds: 300, active_users: 30 },
  ]
  expect(rankUsageRows(usageRows, 'starts').map((row) => row.name)).toEqual([
    'starts-first',
    'users-first',
  ])
  expect(
    rankUsageRows(usageRows, 'active_users').map((row) => row.name)
  ).toEqual(['users-first', 'starts-first'])

  const eventRows = [
    { name: 'count-first', count: 40, unique_users: 3 },
    { name: 'ip-first', count: 4, unique_users: 30 },
  ]
  expect(rankEventRows(eventRows, 'count').map((row) => row.name)).toEqual([
    'count-first',
    'ip-first',
  ])
  expect(
    rankEventRows(eventRows, 'unique_users').map((row) => row.name)
  ).toEqual(['ip-first', 'count-first'])
})
