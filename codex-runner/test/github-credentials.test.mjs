import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitHubCredentials, githubGitEnvironment } from '../github-credentials.mjs';
import { runCommand } from '../workspace-files.mjs';

const token = 'gho_fixture_PRIVATE_1234567890';
const credential = { token, login: 'fixture-admin', generation: 1 };
const headers = (value = credential) => ({ 'x-codex-github-token': value.token, 'x-codex-github-login': value.login, 'x-codex-github-generation': String(value.generation) });

test('trusted GitHub generations reject delayed requests after disconnect and isolate users', () => {
  const credentials = new GitHubCredentials();
  credentials.update(1, credentials.parse(headers()));
  credentials.update(2, { token: token + '_second', login: 'second-admin', generation: 7 });
  assert.equal(credentials.environment(1).GH_TOKEN, token);
  assert.equal(credentials.environment(2).GH_TOKEN, token + '_second');
  credentials.update(1, credentials.parse(headers({ token: '', login: '', generation: 2 })));
  assert.deepEqual(credentials.environment(1), {});
  assert.throws(() => credentials.update(1, credentials.parse(headers())), { code: 'github_credentials_changed' });
  assert.throws(() => credentials.update(1, { ...credential, generation: 2 }), { code: 'github_credentials_changed' });
  assert.throws(() => credentials.update(1, null), { code: 'github_credentials_changed' });
  assert.equal(credentials.environment(2).GH_TOKEN, token + '_second');
  assert.equal(credentials.sanitizeJSON(JSON.stringify({ delayedError: token })), '{"delayedError":"[REDACTED]"}');
  assert.throws(() => credentials.parse(headers({ token, login: 'bad\nlogin', generation: 3 })), { code: 'invalid_github_credentials' });
});

test('streamed credentials are redacted even when a process prints them across chunk boundaries', () => {
  const credentials = new GitHubCredentials();
  credentials.update(1, credential);
  const chunks = ['ordinary text ' + token.slice(0, 5), token.slice(5, 19), token.slice(19) + ' done'];
  const output = chunks.map((chunk) => credentials.sanitizeDelta('project:command:item', chunk)).join('');
  assert.equal(output + credentials.flushDeltaStreams('project').map((event) => event.delta).join(''), 'ordinary text [REDACTED] done');
  assert.equal(credentials.sanitizeDelta('other:item', 'ordinary final text'), 'ordinary final text');
});

test('real git credential protocol sends authorization only to exact HTTPS GitHub and writes no credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-github-helper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...githubGitEnvironment(credential) };
  const github = await runCommand('git', ['credential', 'fill'], { env, input: 'protocol=https\nhost=github.com\n\n' });
  assert.equal(github.code, 0);
  assert.match(github.stdout, /username=x-access-token/);
  assert.ok(github.stdout.includes('password=' + token));
  for (const [protocol, host] of [['http', 'github.com'], ['https', 'github.com.evil.test'], ['https', 'evil.test'], ['https', 'github.com:8443']]) {
    const other = await runCommand('git', ['credential', 'fill'], { env, input: `protocol=${protocol}\nhost=${host}\n\n` });
    assert.notEqual(other.code, 0);
    assert.equal(other.stdout.includes(token), false);
    assert.equal(other.stderr.includes(token), false);
  }
  const saved = await runCommand('git', ['credential', 'approve'], { env, input: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n` });
  assert.equal(saved.code, 0);
  await assert.rejects(readFile(join(directory, '.git-credentials')), { code: 'ENOENT' });
  assert.equal(Object.values(githubGitEnvironment(credential)).filter((value) => value.includes(token)).length, 2);
});
