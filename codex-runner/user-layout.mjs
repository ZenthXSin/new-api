import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function workspaceError(message, code = 'invalid_workspace', statusCode = 400) { return Object.assign(new Error(message), { code, statusCode }); }
export function assertWorkspaceId(id) { if (typeof id !== 'string' || !WORKSPACE_ID.test(id)) throw workspaceError('Invalid workspace identifier'); return id; }
export function assertOwnerId(id) { if (!Number.isSafeInteger(id) || id <= 0) throw workspaceError('Invalid environment owner', 'invalid_owner'); return id; }
export function userPaths(dataDir, ownerId) {
  const root = path.join(path.resolve(dataDir), 'users', String(assertOwnerId(ownerId)));
  return { root, projectsPath: path.join(root, 'projects'), homePath: path.join(root, 'home'), userHomePath: path.join(root, 'home', 'user'), workspaceHomesPath: path.join(root, 'home', 'workspaces') };
}
export function workspacePaths(dataDir, id, ownerId) {
  assertWorkspaceId(id);
  const user = userPaths(dataDir, ownerId);
  const root = path.join(user.projectsPath, id);
  return { ...user, userRoot: user.root, root, projectPath: path.join(root, 'project'), workspaceHomePath: path.join(user.workspaceHomesPath, id), codexHomePath: path.join(user.workspaceHomesPath, id, '.codex'), cwd: `/workspace/projects/${id}/project`, codexHome: `/home/codex/workspaces/${id}/.codex` };
}
export function legacyWorkspacePaths(dataDir, id) { const root = path.join(path.resolve(dataDir), 'workspaces', assertWorkspaceId(id)); return { root, projectPath: path.join(root, 'project'), homePath: path.join(root, 'home') }; }
async function directory(location, { create = false, writable = false, mode = 0o755 } = {}) {
  if (create) await fs.mkdir(location, { mode }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(location).catch(() => { throw workspaceError('Workspace not found', 'workspace_not_found', 404); });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw workspaceError('Unsafe workspace directory', 'unsafe_path');
  if (process.getuid?.() === 0 && !writable && (stat.uid !== 0 || stat.mode & 0o022)) throw workspaceError('Managed directory must be owned by root and not writable by projects', 'unsafe_path');
  return stat;
}
const exists = async (location) => fs.lstat(location).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
async function ownedDirectory(location, mode = 0o755) { await directory(location, { create: true, writable: true, mode }); if (process.getuid?.() === 0) await fs.chown(location, 1000, 1000); }

export class UserWorkspaceLayout {
  constructor(dataDir) { this.dataDir = path.resolve(dataDir); this.owners = new Map(); this.userOperations = new Map(); }
  register(id, ownerId) {
    assertWorkspaceId(id); assertOwnerId(ownerId);
    if (this.owners.has(id) && this.owners.get(id) !== ownerId) throw workspaceError('Workspace owner cannot be changed', 'owner_conflict', 409);
    this.owners.set(id, ownerId);
  }
  unregister(id) { this.owners.delete(assertWorkspaceId(id)); }
  owner(id) { assertWorkspaceId(id); const owner = this.owners.get(id); if (!owner) throw workspaceError('Workspace not found', 'workspace_not_found', 404); return owner; }
  paths(id) { return workspacePaths(this.dataDir, id, this.owner(id)); }
  async userLock(ownerId, action) {
    const prior = this.userOperations.get(ownerId) || Promise.resolve();
    const current = prior.catch(() => {}).then(action); this.userOperations.set(ownerId, current);
    try { return await current; } finally { if (this.userOperations.get(ownerId) === current) this.userOperations.delete(ownerId); }
  }
  async ensureUser(ownerId) {
    return this.userLock(assertOwnerId(ownerId), async () => {
      await directory(this.dataDir);
      const user = userPaths(this.dataDir, ownerId);
      for (const location of [path.join(this.dataDir, 'users'), user.root, user.projectsPath, user.homePath, user.workspaceHomesPath]) await directory(location, { create: true, mode: location === user.root || location === path.join(this.dataDir, 'users') ? 0o700 : 0o755 });
      await ownedDirectory(user.userHomePath);
      return user;
    });
  }
  async create(id, ownerId) {
    this.register(id, ownerId); await this.ensureUser(ownerId);
    const paths = this.paths(id);
    await fs.mkdir(paths.root, { mode: 0o755 });
    await ownedDirectory(paths.projectPath);
    await ownedDirectory(paths.workspaceHomePath);
    await ownedDirectory(paths.codexHomePath, 0o700);
    return { id, ownerId, ...paths };
  }
  async check(id) {
    const paths = this.paths(id);
    for (const folder of [this.dataDir, path.join(this.dataDir, 'users'), paths.userRoot, paths.projectsPath, paths.root, paths.homePath, paths.workspaceHomesPath]) await directory(folder);
    await directory(paths.projectPath, { writable: true });
    await directory(paths.workspaceHomePath, { writable: true });
    return paths;
  }
  async initialize(workspaces) {
    for (const workspace of workspaces) this.register(workspace.id, workspace.ownerId);
    const migrated = [];
    // The runner stops all old/new containers before this call. Each rename is
    // atomic and rerunnable: a partial move never falls back to a second copy.
    for (const workspace of workspaces) {
      const { id, ownerId } = workspace;
      await this.ensureUser(ownerId);
      const old = legacyWorkspacePaths(this.dataDir, id), next = this.paths(id);
      if (await exists(old.root)) {
        await directory(path.dirname(old.root)); await directory(old.root);
        if ((await fs.readdir(old.root)).some((name) => !['project', 'home'].includes(name))) throw workspaceError('Legacy workspace contains unexpected files; migration requires review', 'migration_conflict', 409);
        await directory(next.root, { create: true });
        for (const [source, destination] of [[old.projectPath, next.projectPath], [old.homePath, next.workspaceHomePath]]) {
          const sourceExists = await exists(source), destinationExists = await exists(destination);
          if (sourceExists && destinationExists) throw workspaceError('Both legacy and new workspace data exist; restore or resolve the migration before starting', 'migration_conflict', 409);
          if (!sourceExists && !destinationExists) throw workspaceError('Workspace migration is missing data', 'migration_missing_data', 409);
          if (sourceExists) { await directory(source, { writable: true }); await fs.rename(source, destination); }
        }
        // Leave unknown files untouched; they require operator review.
        const leftovers = await fs.readdir(old.root);
        if (leftovers.length) throw workspaceError('Legacy workspace contains unexpected files; migration requires review', 'migration_conflict', 409);
        await fs.rmdir(old.root);
        migrated.push(id);
      }
      await this.check(id);
    }
    return { migrated, layoutVersion: 2 };
  }
}
