import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../server.mjs';
import { DockerRuntime } from '../docker-runtime.mjs';

const env = { CODEX_RUNNER_KEY: 'resource-test-key-with-32-characters' };

test('MB runner configuration replaces percentage memory while retaining percentage CPU', async () => {
  const config = await loadConfig({ ...env, CODEX_WORKER_MEMORY_MB: '1536', CODEX_WORKER_CPU_PERCENT: '20', CODEX_WORKER_MEMORY_PERCENT: '99' });
  assert.equal(config.memoryMB, 1536);
  assert.equal(config.cpuPercent, 20);
  assert.equal('memoryPercent' in config, false);
});

test('memory budgets use exact MB on hosts with different RAM capacities', () => {
  for (const hostMemoryBytes of [8 * 1024 ** 3, 128 * 1024 ** 3]) {
    const runtime = new DockerRuntime({ dataDir: '/tmp/codex-resource-test', memoryMB: 1536, hostMemoryBytes });
    assert.equal(runtime.memoryBytes, 1536 * 1024 ** 2);
    runtime.userPolicies = new Map([[25, { memoryMB: 3072 }]]);
    assert.equal(runtime.resources(25).memoryBytes, 3072 * 1024 ** 2);
  }
});

test('missing memory configuration uses a fixed MB default', async () => {
  const config = await loadConfig(env);
  assert.equal(config.memoryMB, 2048);
  assert.equal(new DockerRuntime({ dataDir: '/tmp/codex-resource-test' }).memoryBytes, 2048 * 1024 ** 2);
});

test('invalid MB values fail before a runner or container starts', async () => {
  for (const value of ['0', '-1', '255', '256.5', '1048577', 'NaN', 'Infinity']) {
    await assert.rejects(loadConfig({ ...env, CODEX_WORKER_MEMORY_MB: value }), /memoryMB/);
    assert.throws(() => new DockerRuntime({ dataDir: '/tmp/codex-resource-test', memoryMB: Number(value) }), /memory/i);
  }
});
