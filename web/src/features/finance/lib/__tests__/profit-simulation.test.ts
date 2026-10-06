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
import { describe, expect, test } from 'vitest'

import {
  SIMULATION_LIMITS,
  simulateProfit,
  simulationToCsv,
  validateSimulationInput,
  type SimulationInput,
  type SimulationMode,
} from '../profit-simulation'

const input: SimulationInput = {
  startDate: '2026-10-02',
  days: 3,
  baseDailyRevenue: 100,
  marginMin: 20,
  marginMax: 20,
  revenueVolatility: 0,
  mode: 'stable',
  seed: 42,
}

describe('profit simulation', () => {
  test('a fixed revenue and margin reconcile daily money and cumulative totals', () => {
    const result = simulateProfit(input)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.days).toEqual([
      {
        date: '2026-10-02',
        revenue: 100,
        cost: 80,
        profit: 20,
        margin: 20,
        cumulativeProfit: 20,
      },
      {
        date: '2026-10-03',
        revenue: 100,
        cost: 80,
        profit: 20,
        margin: 20,
        cumulativeProfit: 40,
      },
      {
        date: '2026-10-04',
        revenue: 100,
        cost: 80,
        profit: 20,
        margin: 20,
        cumulativeProfit: 60,
      },
    ])
    expect(result.data.summary).toEqual({
      totalRevenue: 300,
      totalCost: 240,
      totalProfit: 60,
      averageDailyRevenue: 100,
      averageDailyProfit: 20,
      averageMargin: 20,
      minDailyProfit: 20,
      maxDailyProfit: 20,
      profitableDays: 3,
      lossDays: 0,
    })
  })

  test.each<SimulationMode>(['stable', 'random', 'cycle'])(
    '%s reproduces the same seed and respects margin and revenue bounds',
    (mode) => {
      const scenario: SimulationInput = {
        ...input,
        days: 30,
        marginMin: -20,
        marginMax: 60,
        revenueVolatility: 25,
        mode,
        seed: 0,
      }
      const result = simulateProfit(scenario)
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(simulateProfit(scenario)).toEqual(result)
      expect(simulateProfit({ ...scenario, seed: 1 })).not.toEqual(result)
      for (const day of result.data.days) {
        expect(day.revenue).toBeGreaterThanOrEqual(75)
        expect(day.revenue).toBeLessThanOrEqual(125)
        expect(day.margin).toBeGreaterThanOrEqual(-20)
        expect(day.margin).toBeLessThanOrEqual(60)
        expect(Math.round(day.revenue * 100) - Math.round(day.cost * 100)).toBe(
          Math.round(day.profit * 100)
        )
      }
      const summary = result.data.summary
      expect(
        Math.round(summary.totalRevenue * 100) -
          Math.round(summary.totalCost * 100)
      ).toBe(Math.round(summary.totalProfit * 100))
      expect(result.data.days.at(-1)?.cumulativeProfit).toBe(
        summary.totalProfit
      )
      expect(summary.averageMargin).toBeCloseTo(
        (summary.totalProfit / summary.totalRevenue) * 100
      )
    }
  )

  test('cycle mode repeats its assumed margin every 28 days', () => {
    const result = simulateProfit({
      ...input,
      days: 29,
      marginMin: 0,
      marginMax: 50,
      mode: 'cycle',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.days[28].margin).toBe(result.data.days[0].margin)
    expect(result.data.days[7].margin).not.toBe(result.data.days[0].margin)
  })

  test.each([
    { margin: -100, cost: 200, profit: -100 },
    { margin: 0, cost: 100, profit: 0 },
    { margin: 100, cost: 0, profit: 100 },
  ])(
    'margin $margin% permits loss and zero cost without breaking gross profit',
    (scenario) => {
      const result = simulateProfit({
        ...input,
        days: 1,
        marginMin: scenario.margin,
        marginMax: scenario.margin,
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.days[0]).toMatchObject({
        revenue: 100,
        cost: scenario.cost,
        profit: scenario.profit,
      })
      expect(result.data.summary.profitableDays).toBe(
        scenario.profit > 0 ? 1 : 0
      )
      expect(result.data.summary.lossDays).toBe(scenario.profit < 0 ? 1 : 0)
    }
  )

  test('zero revenue and tiny negative profits have finite summaries and symmetric cent rounding', () => {
    const zero = simulateProfit({
      ...input,
      baseDailyRevenue: 0,
      marginMin: -100,
      marginMax: 100,
      revenueVolatility: 100,
    })
    expect(zero.success).toBe(true)
    if (!zero.success) return
    expect(zero.data.summary).toMatchObject({
      totalRevenue: 0,
      totalCost: 0,
      totalProfit: 0,
      averageMargin: 0,
    })
    const cents = simulateProfit({
      ...input,
      days: 1,
      baseDailyRevenue: 0.01,
      marginMin: -50,
      marginMax: -50,
    })
    expect(cents.success).toBe(true)
    if (!cents.success) return
    expect(cents.data.days[0]).toMatchObject({
      revenue: 0.01,
      cost: 0.02,
      profit: -0.01,
    })
  })

  test('a decimal half-cent rounds up despite binary floating point representation', () => {
    const result = simulateProfit({
      ...input,
      days: 1,
      baseDailyRevenue: 1.005,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.days[0]).toMatchObject({
      revenue: 1.01,
      profit: 0.2,
      cost: 0.81,
    })
  })

  test.each([
    {
      startDate: '2024-02-28',
      dates: ['2024-02-28', '2024-02-29', '2024-03-01'],
    },
    {
      startDate: '2026-12-31',
      dates: ['2026-12-31', '2027-01-01', '2027-01-02'],
    },
    {
      startDate: '2026-03-07',
      dates: ['2026-03-07', '2026-03-08', '2026-03-09'],
    },
    {
      startDate: '0099-12-31',
      dates: ['0099-12-31', '0100-01-01', '0100-01-02'],
    },
  ])(
    'calendar dates advance across $startDate without UTC or century offsets',
    (scenario) => {
      const result = simulateProfit({ ...input, startDate: scenario.startDate })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.days.map((day) => day.date)).toEqual(scenario.dates)
    }
  )

  test('invalid dates, ranges and non-finite input return field errors without generating rows', () => {
    for (const patch of [
      { startDate: '' },
      { startDate: '2025-02-29' },
      { startDate: '2026-13-01' },
      { startDate: '0000-01-01' },
      { days: 0 },
      { days: 3651 },
      { days: 1.5 },
      { days: Number.NaN },
      { baseDailyRevenue: -1 },
      { baseDailyRevenue: Infinity },
      { baseDailyRevenue: 1_000_000_001 },
      { marginMin: -101 },
      { marginMax: Number.NaN },
      { marginMax: 101 },
      { marginMin: 50, marginMax: 20 },
      { revenueVolatility: -1 },
      { revenueVolatility: 101 },
      { revenueVolatility: Infinity },
      { seed: -1 },
      { seed: 0.5 },
      { seed: 4_294_967_296 },
      { startDate: '9999-12-31', days: 2 },
    ]) {
      const scenario = { ...input, ...patch }
      expect(
        Object.keys(validateSimulationInput(scenario)).length
      ).toBeGreaterThan(0)
      expect(simulateProfit(scenario)).toMatchObject({ success: false })
    }
    expect(
      validateSimulationInput({ ...input, marginMin: 50, marginMax: 20 })
    ).toHaveProperty('marginMax')
    expect(
      validateSimulationInput({ ...input, mode: 'unknown' as SimulationMode })
    ).toHaveProperty('mode')
  })

  test('the maximum duration, revenue and seed keep all accumulated cents safe', () => {
    const result = simulateProfit({
      ...input,
      days: SIMULATION_LIMITS.maxDays,
      baseDailyRevenue: SIMULATION_LIMITS.maxRevenue,
      seed: SIMULATION_LIMITS.maxSeed,
      revenueVolatility: 100,
      marginMin: -100,
      marginMax: -100,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.days).toHaveLength(SIMULATION_LIMITS.maxDays)
    expect(
      Number.isSafeInteger(Math.round(result.data.summary.totalCost * 100))
    ).toBe(true)
    expect(result.data.summary.totalProfit).toBe(
      -result.data.summary.totalRevenue
    )
  })

  test('CSV exports simulated rows with explicit USD units and neutralizes text formulas', () => {
    const result = simulateProfit({ ...input, days: 1 })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(simulationToCsv(result.data)).toBe(
      '﻿Date,Revenue (USD),Cost (USD),Gross profit (USD),Assumed gross margin (%),Cumulative gross profit (USD)\r\n"2026-10-02",100.00,80.00,20.00,20.0000,20.00\r\n'
    )
    result.data.days[0].date = '=HYPERLINK("example")'
    expect(simulationToCsv(result.data)).toContain(
      '"\'=HYPERLINK(""example"")"'
    )
    expect(
      simulationToCsv({ ...result.data, days: [] }).split('\r\n')
    ).toHaveLength(2)
  })
})
