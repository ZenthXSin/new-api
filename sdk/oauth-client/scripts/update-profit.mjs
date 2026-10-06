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
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const sourceUrl = new URL('../../../web/src/features/finance/lib/profit-simulation.ts', import.meta.url);
const outputUrl = new URL('../profit.mjs', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const license = source.match(/^\/\*[\s\S]*?\*\//)?.[0];
if (!license) throw new Error('The frontend source must retain its license header.');
const fingerprint = createHash('sha256').update(source).digest('hex');
const javascript = stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false });
const generated = `${license}
${javascript.trimEnd()}

// Generated from web/src/features/finance/lib/profit-simulation.ts.
// Source SHA-256: ${fingerprint}
// Update with: node sdk/oauth-client/scripts/update-profit.mjs
// These aliases describe the same financial-page calculation contract.
export {
  SIMULATION_LIMITS as PROFIT_LIMITS,
  validateSimulationInput as validateProfitInput,
  simulateProfit as calculateProfit,
  simulationToCsv as profitToCsv,
};
`;

if (process.argv.includes('--check')) {
  const actual = await readFile(outputUrl, 'utf8');
  if (actual !== generated) {
    throw new Error('The external profit calculator differs from its frontend source. Run node sdk/oauth-client/scripts/update-profit.mjs.');
  }
  process.stdout.write('The external profit calculator matches its frontend source.\n');
} else {
  await writeFile(outputUrl, generated);
  process.stdout.write('Updated sdk/oauth-client/profit.mjs from the frontend source.\n');
}
