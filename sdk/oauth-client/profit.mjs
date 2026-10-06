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
export const SIMULATION_LIMITS = {
    maxDays: 3650,
    maxRevenue: 1_000_000_000,
    maxSeed: 4_294_967_295,
    minMargin: -100,
    maxMargin: 100,
    maxRevenueVolatility: 100
};
const DAY_MS = 86_400_000;
const LAST_DATE_MS = Date.UTC(9999, 11, 31);
function calendarTimestamp(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const year = Number(value.slice(0, 4));
    if (year === 0) return undefined;
    const date = new Date(0);
    date.setUTCFullYear(year, Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        return undefined;
    }
    return date.getTime();
}
export function validateSimulationInput(input) {
    const errors = {};
    const start = calendarTimestamp(input.startDate);
    if (start === undefined) {
        errors.startDate = 'Enter a valid start date (YYYY-MM-DD)';
    }
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > SIMULATION_LIMITS.maxDays) {
        errors.days = 'Enter a whole number of days between 1 and 3650';
    } else if (start !== undefined && start + (input.days - 1) * DAY_MS > LAST_DATE_MS) {
        errors.days = 'The simulation must end on or before December 31, 9999';
    }
    if (!Number.isFinite(input.baseDailyRevenue) || input.baseDailyRevenue < 0 || input.baseDailyRevenue > SIMULATION_LIMITS.maxRevenue) {
        errors.baseDailyRevenue = 'Enter a daily revenue between 0 and 1,000,000,000';
    }
    for (const field of [
        'marginMin',
        'marginMax'
    ]){
        if (!Number.isFinite(input[field]) || input[field] < SIMULATION_LIMITS.minMargin || input[field] > SIMULATION_LIMITS.maxMargin) {
            errors[field] = 'Enter a margin between -100% and 100%';
        }
    }
    if (!errors.marginMin && !errors.marginMax && input.marginMin > input.marginMax) {
        errors.marginMax = 'The maximum margin must be at least the minimum margin';
    }
    if (!Number.isFinite(input.revenueVolatility) || input.revenueVolatility < 0 || input.revenueVolatility > SIMULATION_LIMITS.maxRevenueVolatility) {
        errors.revenueVolatility = 'Enter a revenue volatility between 0% and 100%';
    }
    if (![
        'stable',
        'random',
        'cycle'
    ].includes(input.mode)) {
        errors.mode = 'Select a valid simulation mode';
    }
    if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > SIMULATION_LIMITS.maxSeed) {
        errors.seed = 'Enter a whole number seed between 0 and 4,294,967,295';
    }
    return errors;
}
function seededRandom(seed) {
    let state = seed >>> 0;
    return ()=>{
        state = state + 0x6d2b79f5 >>> 0;
        let value = Math.imul(state ^ state >>> 15, state | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
    };
}
function roundCents(value) {
    const magnitude = Math.abs(value);
    const tolerance = Number.EPSILON * Math.max(1, magnitude);
    const result = Math.sign(value) * Math.round(magnitude + tolerance);
    return result === 0 ? 0 : result;
}
export function simulateProfit(input) {
    const errors = validateSimulationInput(input);
    if (Object.keys(errors).length > 0) return {
        success: false,
        errors
    };
    const random = seededRandom(input.seed);
    const start = calendarTimestamp(input.startDate);
    if (start === undefined) {
        return {
            success: false,
            errors: {
                startDate: 'Enter a valid start date (YYYY-MM-DD)'
            }
        };
    }
    const midpoint = (input.marginMin + input.marginMax) / 2;
    const span = input.marginMax - input.marginMin;
    const phase = random() * Math.PI * 2;
    const days = [];
    let previousMargin = midpoint;
    let totalRevenue = 0;
    let totalCost = 0;
    let totalProfit = 0;
    let minProfit = Infinity;
    let maxProfit = -Infinity;
    let profitableDays = 0;
    let lossDays = 0;
    for(let index = 0; index < input.days; index++){
        let margin = midpoint;
        if (input.mode === 'random') {
            margin = input.marginMin + random() * span;
        } else if (input.mode === 'cycle') {
            margin = midpoint + span / 2 * Math.sin(index / 28 * Math.PI * 2 + phase);
        } else {
            margin = previousMargin + (midpoint - previousMargin) * 0.25 + (random() - 0.5) * span * 0.2;
        }
        margin = Math.max(input.marginMin, Math.min(input.marginMax, Math.round(margin * 10_000) / 10_000));
        previousMargin = margin;
        const revenueFactor = 1 + (random() * 2 - 1) * input.revenueVolatility / 100;
        const revenue = roundCents(input.baseDailyRevenue * revenueFactor * 100);
        const profit = roundCents(revenue * margin / 100);
        const cost = revenue - profit;
        totalRevenue += revenue;
        totalCost += cost;
        totalProfit += profit;
        minProfit = Math.min(minProfit, profit);
        maxProfit = Math.max(maxProfit, profit);
        if (profit > 0) profitableDays++;
        if (profit < 0) lossDays++;
        days.push({
            date: new Date(start + index * DAY_MS).toISOString().slice(0, 10),
            revenue: revenue / 100,
            cost: cost / 100,
            profit: profit / 100,
            margin,
            cumulativeProfit: totalProfit / 100
        });
    }
    return {
        success: true,
        data: {
            days,
            summary: {
                totalRevenue: totalRevenue / 100,
                totalCost: totalCost / 100,
                totalProfit: totalProfit / 100,
                averageDailyRevenue: roundCents(totalRevenue / input.days) / 100,
                averageDailyProfit: roundCents(totalProfit / input.days) / 100,
                averageMargin: totalRevenue === 0 ? 0 : totalProfit / totalRevenue * 100,
                minDailyProfit: minProfit / 100,
                maxDailyProfit: maxProfit / 100,
                profitableDays,
                lossDays
            }
        }
    };
}
export function simulationToCsv(data) {
    const rows = [
        'Date,Revenue (USD),Cost (USD),Gross profit (USD),Assumed gross margin (%),Cumulative gross profit (USD)'
    ];
    for (const day of data.days){
        let date = day.date;
        if (/^[\s]*[=+\-@]/.test(date) || /^[\t\r\n]/.test(date)) date = `'${date}`;
        const amounts = [
            day.revenue,
            day.cost,
            day.profit,
            day.margin,
            day.cumulativeProfit
        ];
        const cells = amounts.map((value, index)=>Number.isFinite(value) ? value.toFixed(index === 3 ? 4 : 2) : '');
        rows.push([
            `"${date.replaceAll('"', '""')}"`,
            ...cells
        ].join(','));
    }
    return `\uFEFF${rows.join('\r\n')}\r\n`;
}

// Generated from web/src/features/finance/lib/profit-simulation.ts.
// Source SHA-256: 1f9b738e4424ed3de8c549f23761f83941ef6839964c192420b6abcfc9a04f22
// Update with: node sdk/oauth-client/scripts/update-profit.mjs
// These aliases describe the same financial-page calculation contract.
export {
  SIMULATION_LIMITS as PROFIT_LIMITS,
  validateSimulationInput as validateProfitInput,
  simulateProfit as calculateProfit,
  simulationToCsv as profitToCsv,
};
