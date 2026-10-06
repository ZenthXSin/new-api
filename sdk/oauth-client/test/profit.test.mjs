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
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import {
  PROFIT_LIMITS,
  SIMULATION_LIMITS,
  calculateProfit,
  profitToCsv,
  simulateProfit,
  simulationToCsv,
  validateProfitInput,
  validateSimulationInput,
} from '../profit.mjs';

const frontendSource = await readFile(
  new URL('../../../web/src/features/finance/lib/profit-simulation.ts', import.meta.url),
  'utf8',
);
const frontend = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(frontendSource, { mode: 'transform' })).toString('base64')}`
);

const input = {
  startDate: '2026-10-02',
  days: 3,
  baseDailyRevenue: 100,
  marginMin: -20,
  marginMax: 60,
  revenueVolatility: 25,
  mode: 'random',
  seed: 42,
};

test('external names preserve the existing financial-page contract', () => {
  assert.equal(calculateProfit, simulateProfit);
  assert.equal(validateProfitInput, validateSimulationInput);
  assert.equal(profitToCsv, simulationToCsv);
  assert.equal(PROFIT_LIMITS, SIMULATION_LIMITS);
  assert.deepEqual(PROFIT_LIMITS, frontend.SIMULATION_LIMITS);
});

test('the published seed 42 random example remains reproducible to the cent', () => {
  const result = calculateProfit(input);
  assert.deepEqual(result, {
    success: true,
    data: {
      days: [
        { date: '2026-10-02', revenue: 117.62, cost: 98.96, profit: 18.66, margin: 15.8632, cumulativeProfit: 18.66 },
        { date: '2026-10-03', revenue: 83.74, cost: 55.62, profit: 28.12, margin: 33.5787, cumulativeProfit: 46.78 },
        { date: '2026-10-04', revenue: 88.66, cost: 69.04, profit: 19.62, margin: 22.1274, cumulativeProfit: 66.4 },
      ],
      summary: {
        totalRevenue: 290.02,
        totalCost: 223.62,
        totalProfit: 66.4,
        averageDailyRevenue: 96.67,
        averageDailyProfit: 22.13,
        averageMargin: 22.89497276049928,
        minDailyProfit: 18.66,
        maxDailyProfit: 28.12,
        profitableDays: 3,
        lossDays: 0,
      },
    },
  });
});

test('all modes match the actual frontend and replay independently of other runs', () => {
  for (const mode of ['stable', 'random', 'cycle']) {
    for (const seed of [0, 42, PROFIT_LIMITS.maxSeed]) {
      const scenario = { ...input, mode, seed, days: 30 };
      const actual = calculateProfit(scenario);
      assert.deepEqual(actual, frontend.simulateProfit(scenario));
      calculateProfit({ ...scenario, seed: seed === 0 ? 1 : 0 });
      assert.deepEqual(calculateProfit(scenario), actual);
      assert.equal(actual.success, true);
      for (const day of actual.data.days) {
        assert.ok(day.margin >= input.marginMin && day.margin <= input.marginMax);
        assert.ok(day.revenue >= 75 && day.revenue <= 125);
        assert.equal(Math.round(day.revenue * 100) - Math.round(day.cost * 100), Math.round(day.profit * 100));
      }
      assert.equal(actual.data.days.at(-1).cumulativeProfit, actual.data.summary.totalProfit);
      if (mode === 'cycle') assert.equal(actual.data.days[0].margin, actual.data.days[28].margin);
    }
  }
});

test('calendar dates match the frontend across leap days, centuries and DST dates', () => {
  for (const [startDate, dates] of [
    ['2024-02-28', ['2024-02-28', '2024-02-29', '2024-03-01']],
    ['0099-12-31', ['0099-12-31', '0100-01-01', '0100-01-02']],
    ['2026-03-07', ['2026-03-07', '2026-03-08', '2026-03-09']],
  ]) {
    const scenario = { ...input, startDate };
    const actual = calculateProfit(scenario);
    assert.deepEqual(actual, frontend.simulateProfit(scenario));
    assert.equal(actual.success, true);
    assert.deepEqual(actual.data.days.map((day) => day.date), dates);
  }
});

test('invalid inputs return the same field errors as the frontend without output rows', () => {
  for (const patch of [
    { startDate: '' }, { startDate: '0000-01-01' }, { startDate: '2025-02-29' },
    { startDate: '9999-12-31', days: 2 },
    { days: 0 }, { days: 3651 }, { days: 1.5 }, { days: NaN },
    { baseDailyRevenue: -1 }, { baseDailyRevenue: Infinity }, { baseDailyRevenue: 1_000_000_001 },
    { marginMin: -101 }, { marginMax: 101 }, { marginMax: NaN }, { marginMin: 50, marginMax: 20 },
    { revenueVolatility: -1 }, { revenueVolatility: 101 }, { revenueVolatility: Infinity },
    { seed: -1 }, { seed: 0.5 }, { seed: 4_294_967_296 }, { mode: 'unknown' },
  ]) {
    const scenario = { ...input, ...patch };
    const expected = frontend.simulateProfit(scenario);
    const actual = calculateProfit(scenario);
    assert.equal(actual.success, false);
    assert.equal('data' in actual, false);
    assert.deepEqual(actual, expected);
    assert.deepEqual(validateProfitInput(scenario), frontend.validateSimulationInput(scenario));
  }
});

test('zero revenue, half cents and negative profits match financial-page rounding', () => {
  for (const [baseDailyRevenue, margin, expected] of [
    [0, -100, { revenue: 0, cost: 0, profit: 0 }],
    [1.005, 20, { revenue: 1.01, cost: 0.81, profit: 0.2 }],
    [0.01, -50, { revenue: 0.01, cost: 0.02, profit: -0.01 }],
    [100, 100, { revenue: 100, cost: 0, profit: 100 }],
  ]) {
    const scenario = { ...input, baseDailyRevenue, marginMin: margin, marginMax: margin, revenueVolatility: 0, days: 1 };
    const actual = calculateProfit(scenario);
    assert.deepEqual(actual, frontend.simulateProfit(scenario));
    assert.equal(actual.success, true);
    for (const [field, amount] of Object.entries(expected)) assert.equal(actual.data.days[0][field], amount);
    if (baseDailyRevenue === 0) assert.equal(actual.data.summary.averageMargin, 0);
  }
});

test('the full supported duration and amount remain within integer-cent precision', () => {
  const scenario = {
    ...input,
    days: PROFIT_LIMITS.maxDays,
    baseDailyRevenue: PROFIT_LIMITS.maxRevenue,
    seed: PROFIT_LIMITS.maxSeed,
    marginMin: -100,
    marginMax: -100,
    revenueVolatility: PROFIT_LIMITS.maxRevenueVolatility,
  };
  const actual = calculateProfit(scenario);
  assert.deepEqual(actual, frontend.simulateProfit(scenario));
  assert.equal(actual.success, true);
  assert.equal(actual.data.days.length, PROFIT_LIMITS.maxDays);
  assert.ok(Number.isSafeInteger(Math.round(actual.data.summary.totalCost * 100)));
  assert.equal(actual.data.summary.totalProfit, -actual.data.summary.totalRevenue);
});

test('CSV bytes match the financial page and spreadsheet formulas stay neutralized', () => {
  const scenario = { ...input, days: 1, marginMin: 20, marginMax: 20, revenueVolatility: 0 };
  const result = calculateProfit(scenario);
  assert.equal(result.success, true);
  assert.equal(profitToCsv(result.data), '\uFEFFDate,Revenue (USD),Cost (USD),Gross profit (USD),Assumed gross margin (%),Cumulative gross profit (USD)\r\n"2026-10-02",100.00,80.00,20.00,20.0000,20.00\r\n');
  for (const date of ['=HYPERLINK("example")', '+1', '-1', '@SUM(A1)', '\tformula', '\nformula']) {
    const data = { ...result.data, days: [{ ...result.data.days[0], date }] };
    assert.equal(profitToCsv(data), frontend.simulationToCsv(data));
    assert.ok(profitToCsv(data).includes(`"'${date.replaceAll('"', '""')}"`));
  }
});

test('calculation does not mutate caller input', () => {
  const scenario = Object.freeze({ ...input });
  assert.deepEqual(calculateProfit(scenario), frontend.simulateProfit(scenario));
  assert.deepEqual(scenario, input);
});
