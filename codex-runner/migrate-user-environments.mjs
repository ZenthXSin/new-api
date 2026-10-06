#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { DockerRuntime } from './docker-runtime.mjs';
import { WorkspaceFiles } from './workspace-files.mjs';
import { WORKSPACE_ID, assertOwnerId, legacyWorkspacePaths, workspacePaths } from './user-layout.mjs';

const args = process.argv.slice(2), apply = args.includes('--apply');
const position = args.indexOf('--data-dir');
if (position < 0 || !args[position + 1] || args.some((arg, index) => !['--data-dir', '--apply', '--dry-run'].includes(arg) && index !== position + 1)) {
  process.stderr.write('Usage: node migrate-user-environments.mjs --data-dir /var/lib/new-api-codex [--dry-run|--apply]\nStop the runner and take a full data backup before --apply.\n'); process.exit(2);
}
const dataDir = path.resolve(args[position + 1]), workspaces = [];
for (const name of await fs.readdir(path.join(dataDir, 'state'))) {
  if (!name.endsWith('.json') || !WORKSPACE_ID.test(name.slice(0, -5))) continue;
  const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state', name), 'utf8'));
  if (state.workspace?.id !== name.slice(0, -5)) throw new Error('Invalid workspace state identity');
  assertOwnerId(state.workspace.ownerId);
  workspaces.push({ id: state.workspace.id, ownerId: state.workspace.ownerId });
}
const plan = [];
for (const workspace of workspaces) {
  const old = legacyWorkspacePaths(dataDir, workspace.id), next = workspacePaths(dataDir, workspace.id, workspace.ownerId);
  const source = await fs.lstat(old.root).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (source && (!source.isDirectory() || source.isSymbolicLink())) throw new Error('Unsafe legacy workspace root');
  plan.push({ workspaceId: workspace.id, ownerId: workspace.ownerId, action: source ? 'migrate' : 'already_migrated', oldProjectPath: old.projectPath, projectPath: next.projectPath, oldHomePath: old.homePath, homePath: next.workspaceHomePath, cwd: next.cwd, codexHome: next.codexHome });
}
process.stdout.write(JSON.stringify({ apply, dataDir, layoutVersion: 2, projects: plan }, null, 2) + '\n');
if (apply) {
  const runtime = new DockerRuntime({ dataDir }), files = new WorkspaceFiles({ dataDir, dockerRuntime: runtime });
  await runtime.initialize(workspaces);
  const result = await files.initialize(workspaces);
  process.stdout.write(JSON.stringify({ ...result, nativeHistory: 'SQLite path indexes relocate inside the user container before its first App Server startup; rollout text stays unchanged.' }) + '\n');
}
