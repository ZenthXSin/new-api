/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/
import type {
  CustomEventBucket,
  CustomEventsSummary,
  DownloadBucket,
  EventTrend,
  UsageBucket,
  UsageSummary,
} from './api'

export function summarizeUsage(
  rows: UsageBucket[],
  hours = 0,
  referenceTimestamp = Math.floor(Date.now() / 1000)
): UsageSummary {
  const versions = new Map<
    string,
    {
      version: string
      starts: number
      online_seconds: number
      active_users: number
    }
  >()
  const platforms = new Map<
    string,
    {
      platform: string
      starts: number
      online_seconds: number
      active_users: number
    }
  >()
  const trend = new Map<
    number,
    {
      bucket_ts: number
      starts: number
      online_seconds: number
      active_users: number
    }
  >()
  let starts = 0
  let online = 0
  let activeUsers = 0

  for (const row of rows) {
    starts += row.start_count
    online += row.online_seconds
    activeUsers += row.active_users

    const version = versions.get(row.version) ?? {
      version: row.version,
      starts: 0,
      online_seconds: 0,
      active_users: 0,
    }
    version.starts += row.start_count
    version.online_seconds += row.online_seconds
    version.active_users += row.active_users
    versions.set(row.version, version)

    const platform = platforms.get(row.platform) ?? {
      platform: row.platform,
      starts: 0,
      online_seconds: 0,
      active_users: 0,
    }
    platform.starts += row.start_count
    platform.online_seconds += row.online_seconds
    platform.active_users += row.active_users
    platforms.set(row.platform, platform)

    const bucket = trend.get(row.bucket_ts) ?? {
      bucket_ts: row.bucket_ts,
      starts: 0,
      online_seconds: 0,
      active_users: 0,
    }
    bucket.starts += row.start_count
    bucket.online_seconds += row.online_seconds
    bucket.active_users += row.active_users
    trend.set(row.bucket_ts, bucket)
  }

  const trendRows = [...trend.values()].sort(
    (a, b) => a.bucket_ts - b.bucket_ts
  )
  if (hours > 0) {
    const end = Math.floor(referenceTimestamp / 3600) * 3600
    const completeTrend = new Map(trendRows.map((row) => [row.bucket_ts, row]))
    trendRows.length = 0
    for (
      let bucketTs = end - (hours - 1) * 3600;
      bucketTs <= end;
      bucketTs += 3600
    ) {
      trendRows.push(
        completeTrend.get(bucketTs) ?? {
          bucket_ts: bucketTs,
          starts: 0,
          online_seconds: 0,
          active_users: 0,
        }
      )
    }
  }

  return {
    starts,
    online_seconds: online,
    active_users: activeUsers,
    average_session_seconds: starts ? online / starts : 0,
    versions: [...versions.values()].sort((a, b) => b.starts - a.starts),
    platforms: [...platforms.values()].sort((a, b) => b.starts - a.starts),
    trend: trendRows,
  }
}

export type DownloadsSummary = {
  total: number
  series: Array<{
    version: string
    points: Array<{ bucket_ts: number; count: number }>
  }>
}

export function summarizeDownloads(
  rows: DownloadBucket[],
  hours = 0,
  referenceTimestamp = Math.floor(Date.now() / 1000)
): DownloadsSummary {
  const byVersion = new Map<
    string,
    { buckets: Map<number, number>; total: number }
  >()
  let total = 0
  for (const row of rows) {
    total += row.count
    const entry = byVersion.get(row.version) ?? {
      buckets: new Map<number, number>(),
      total: 0,
    }
    entry.total += row.count
    entry.buckets.set(
      row.bucket_ts,
      (entry.buckets.get(row.bucket_ts) ?? 0) + row.count
    )
    byVersion.set(row.version, entry)
  }
  const series = [...byVersion.entries()]
    .map(([version, entry]) => {
      let points = [...entry.buckets.entries()]
        .map(([bucket_ts, count]) => ({ bucket_ts, count }))
        .sort((a, b) => a.bucket_ts - b.bucket_ts)
      if (hours > 0) {
        const end = Math.floor(referenceTimestamp / 3600) * 3600
        const byBucket = new Map(
          points.map((point) => [point.bucket_ts, point])
        )
        points = []
        for (
          let bucketTs = end - (hours - 1) * 3600;
          bucketTs <= end;
          bucketTs += 3600
        ) {
          points.push(
            byBucket.get(bucketTs) ?? { bucket_ts: bucketTs, count: 0 }
          )
        }
      }
      return { version, total: entry.total, points }
    })
    .sort((a, b) => b.total - a.total)
    .map(({ version, points }) => ({ version, points }))
  return { total, series }
}

export function summarizeEvents(
  rows: CustomEventBucket[],
  uniqueUsers: Array<{ name: string; unique_users: number }>,
  trendRows: EventTrend[] = [],
  hours = 0,
  referenceTimestamp = Math.floor(Date.now() / 1000)
): CustomEventsSummary {
  const uniqueUsersByName = new Map(
    uniqueUsers.map((row) => [row.name, row.unique_users])
  )
  const events = new Map<
    string,
    { name: string; count: number; unique_users: number }
  >()
  for (const row of rows) {
    const event = events.get(row.name) ?? {
      name: row.name,
      count: 0,
      unique_users: uniqueUsersByName.get(row.name) ?? 0,
    }
    event.count += row.count
    events.set(row.name, event)
  }
  const trendByKey = new Map(
    trendRows.map((row) => [`${row.bucket_ts}\u0000${row.name}`, row])
  )
  const trendNames = [...new Set(trendRows.map((row) => row.name))]
  let completeTrend = [...trendRows].sort((a, b) =>
    a.bucket_ts === b.bucket_ts
      ? a.name.localeCompare(b.name)
      : a.bucket_ts - b.bucket_ts
  )
  if (hours > 0 && trendNames.length > 0) {
    const end = Math.floor(referenceTimestamp / 3600) * 3600
    completeTrend = []
    for (
      let bucketTs = end - (hours - 1) * 3600;
      bucketTs <= end;
      bucketTs += 3600
    ) {
      for (const name of trendNames) {
        completeTrend.push(
          trendByKey.get(`${bucketTs}\u0000${name}`) ?? {
            bucket_ts: bucketTs,
            name,
            count: 0,
            unique_users: 0,
          }
        )
      }
    }
  }
  return {
    events: [...events.values()].sort((a, b) => b.count - a.count),
    trend: completeTrend,
  }
}

export function formatOnlineDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0秒'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const rest = rounded % 60
  if (hours > 0) return `${hours}小时${minutes}分`
  if (minutes > 0) return `${minutes}分${rest}秒`
  return `${rest}秒`
}

export function formatTelemetryBucket(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return '-'
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`
}

export function rankUsageRows<
  T extends { starts: number; online_seconds: number; active_users: number },
>(rows: T[], metric: 'starts' | 'active_users', limit = 10): T[] {
  return [...rows]
    .sort((left, right) => right[metric] - left[metric])
    .slice(0, limit)
}

export function rankEventRows<
  T extends { count: number; unique_users: number },
>(rows: T[], metric: 'count' | 'unique_users', limit = 10): T[] {
  return [...rows]
    .sort((left, right) => right[metric] - left[metric])
    .slice(0, limit)
}
