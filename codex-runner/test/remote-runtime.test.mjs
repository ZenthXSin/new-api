import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RemoteRuntime } from '../remote-runtime.mjs';
import { runCommand } from '../workspace-files.mjs';
import { spawn } from 'node:child_process';

async function fixture(t, homeProject) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-runtime-test-'));
  const home = path.join(directory, 'home');
  await fs.mkdir(home, { mode: 0o700 });
  const root = homeProject ? home : path.join(home, 'project');
  if (!homeProject) await fs.mkdir(root);
  const control = homeProject ? path.join('/var/tmp', `new-api-codex-${process.getuid()}-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`) : path.join(home, '.local/share/new-api-codex');
  t.after(async () => { if (homeProject) await fs.rm(control, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); });
  const id = randomUUID();
  const connections = {
    spawn: async (ownerId, connectionId, argv) => {
      assert.equal(ownerId, 1); assert.equal(connectionId, 'fixture-ssh');
      return spawn(argv[0], argv.slice(1), { env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    },
    get: async (ownerId, connectionId) => { assert.equal(ownerId, 1); assert.equal(connectionId, 'fixture-ssh'); },
    exec: async (ownerId, connectionId, argv, options) => {
      assert.equal(ownerId, 1); assert.equal(connectionId, 'fixture-ssh');
      // Replace only the SSH transport. The installer, checked bundle and helper
      // are the real production code, running against isolated account files.
      if (argv[3].includes('platform.system()')) return { code: 0, stdout: JSON.stringify({ home, platform: 'Linux', architecture: 'aarch64', python: [3, 11], git: true, codex: '/fixture/codex' }) };
      return runCommand(argv[0], argv.slice(1), { ...options, env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } });
    },
  };
  const runtime = new RemoteRuntime({ dataDir: directory, connections });
  runtime.registerWorkspace(id, 1, { connectionId: 'fixture-ssh', path: root });
  return { runtime, root, home, control, id };
}

test('home-directory projects install their checked runtime outside project files and keep ordinary home files editable', async (t) => {
  const f = await fixture(t, true);
  await fs.writeFile(path.join(f.home, 'server.txt'), 'keep\n');
  await f.runtime.create(f.id);
  const prepared = f.runtime.prepared.get(f.id);
  assert(prepared.helper.startsWith(f.control + '/bundles/'));
  assert(!prepared.helper.startsWith(f.home + '/'));
  assert.equal((await fs.stat(f.control)).mode & 0o777, 0o700);
  assert.deepEqual((await f.runtime.list(f.id)).entries.map(entry => entry.name), ['server.txt']);
  const file = await f.runtime.read(f.id, 'server.txt');
  await f.runtime.write(f.id, 'server.txt', 'updated\n', file.hash);
  assert.equal(await fs.readFile(path.join(f.home, 'server.txt'), 'utf8'), 'updated\n');
});

test('ordinary remote projects preserve the previous private runtime location and do not add files to the project', async (t) => {
  const f = await fixture(t, false);
  await f.runtime.create(f.id);
  assert(f.runtime.prepared.get(f.id).helper.startsWith(f.control + '/bundles/'));
  assert.deepEqual((await f.runtime.list(f.id)).entries, []);
});

test('remote downloads preserve binary bytes and keep private runtime files inaccessible', async t => {
  const f = await fixture(t, true);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 0xff);
  bytes[0] = 0x50; bytes[1] = 0x4b; bytes[2] = 0;
  await fs.writeFile(path.join(f.root, '构建.ipa'), bytes);
  const download = await f.runtime.download(f.id, '构建.ipa');
  const chunks = []; for await (const chunk of download.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await assert.rejects(f.runtime.download(f.id, '../outside'));
  await assert.rejects(f.runtime.download(f.id, '.local/share/new-api-codex/auth.json'), { code: 'protected_path' });
});
