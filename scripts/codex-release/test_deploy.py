#!/usr/bin/env python3
"""Exercise release transactions only against a temporary filesystem and fake services."""
import contextlib
import io
import json
import os
import runpy
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import deploy


class DeploymentConfigurationTests(unittest.TestCase):
    def test_public_defaults_do_not_depend_on_a_private_installation(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = runpy.run_path(str(Path(deploy.__file__)))
        self.assertEqual(settings['COMPOSE'], Path('/etc/new-api/compose.private.json'))
        self.assertEqual(settings['PROJECT'], 'new-api')

    def test_explicit_installation_settings_override_each_public_default(self):
        environment = {
            'CODEX_RELEASE_COMPOSE': '/srv/example/compose.private.json',
            'CODEX_RELEASE_PROJECT': 'example-installation',
            'CODEX_RELEASE_RUNNER': '/srv/example/runner',
            'CODEX_RELEASE_DATA': '/srv/example/data',
            'CODEX_RELEASE_KEY': '/srv/example/runner.key',
            'CODEX_RELEASE_RUNNER_URL': 'http://127.0.0.1:17310',
            'CODEX_RELEASE_SERVICE': 'example-codex.service',
            'CODEX_RELEASE_DROPIN': '/srv/example/release.conf',
        }
        with patch.dict(os.environ, environment, clear=True):
            settings = runpy.run_path(str(Path(deploy.__file__)))
        for name in ['COMPOSE', 'RUNNER', 'DATA', 'KEY', 'DROPIN']:
            self.assertEqual(settings[name], Path(environment['CODEX_RELEASE_' + name]))
        for name in ['PROJECT', 'RUNNER_URL', 'SERVICE']:
            self.assertEqual(settings[name], environment['CODEX_RELEASE_' + name])


class DeploymentTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        self.runner = self.root / 'runner'
        self.runner.mkdir()
        (self.runner / 'server.mjs').write_text('old code')
        (self.runner / 'obsolete.mjs').write_text('obsolete code')
        (self.runner / 'bin').mkdir()
        (self.runner / 'bin/node').write_text('runtime')
        self.compose = self.root / 'compose.private.json'
        self.original = {'services': {'new-api': {'image': 'old', 'environment': {'SECRET': 'keep-secret'}, 'volumes': ['keep-data:/data']}, 'database': {'container_name': 'database', 'image': 'database'}}}
        self.compose.write_text(json.dumps(self.original))
        self.dropin = self.root / 'service.d/release.conf'
        self.dropin.parent.mkdir()
        self.dropin.write_text('prior dropin')
        new = self.root / 'server.mjs'
        new.write_text('new code')
        with tarfile.open(self.bundle / 'runner.tar.gz', 'w:gz') as archive:
            archive.add(new, arcname='server.mjs')
        self.manifest = {'release': 'test', 'api_image': 'new', 'api_image_id': 'new-id', 'worker_image_id': 'worker-id', 'runner_archive': 'runner.tar.gz'}
        self.commands = []
        self.image = 'old-id'
        self.patches = [patch.object(deploy, 'COMPOSE', self.compose), patch.object(deploy, 'RUNNER', self.runner), patch.object(deploy, 'DROPIN', self.dropin), patch.object(deploy, 'load_release', return_value=self.manifest), patch.object(deploy, 'preflight', return_value={'production_image': 'old-id'}), patch.object(deploy, 'assert_idle'), patch.object(deploy, 'other_containers', return_value={'database': 'unchanged'}), patch.object(deploy, 'wait_health'), patch.object(deploy, 'run', side_effect=self.command), patch.object(deploy, 'compose_up', side_effect=self.up), patch.object(deploy, 'inspect', side_effect=lambda name: {'Image': self.image})]
        self.mocks = [p.start() for p in self.patches]
        for p in self.patches:
            self.addCleanup(p.stop)

    def command(self, args):
        self.commands.append(args)
        return ''

    def up(self):
        self.commands.append(['compose', 'up', 'new-api'])
        self.image = 'new-id' if json.loads(self.compose.read_text())['services']['new-api']['image'] == 'new' else 'old-id'

    def apply(self):
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.apply(self.bundle)

    def test_reasoning_and_parallel_capacity_are_applied_and_rolled_back_with_the_release(self):
        self.manifest['runner_environment'] = {'CODEX_EFFORTS': 'low,medium,high,xhigh,max,ultra', 'CODEX_MAX_ACTIVE': '8', 'CODEX_MAX_ACTIVE_TASKS': '16', 'CODEX_WORKER_MEMORY_MB': '799'}
        self.apply()
        environment = (self.bundle / 'transaction/worker.env').read_text()
        self.assertIn('CODEX_MAX_ACTIVE=8\n', environment)
        self.assertIn('CODEX_MAX_ACTIVE_TASKS=16\n', environment)
        self.assertIn('CODEX_WORKER_MEMORY_MB=799\n', environment)
        self.assertIn('CODEX_EFFORTS=low,medium,high,xhigh,max,ultra\n', environment)
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.rollback(self.bundle)
        self.assertEqual(self.dropin.read_text(), 'prior dropin')

    def test_apply_updates_paired_release_preserving_database_and_runtime(self):
        self.apply()
        expected = json.loads(json.dumps(self.original))
        expected['services']['new-api']['image'] = 'new'
        self.assertEqual(json.loads(self.compose.read_text()), expected)
        self.assertEqual((self.runner / 'server.mjs').read_text(), 'new code')
        self.assertEqual((self.runner / 'bin/node').read_text(), 'runtime')
        self.assertFalse((self.runner / 'obsolete.mjs').exists())
        self.assertEqual((self.root / 'new-api-codex.before-test/server.mjs').read_text(), 'old code')
        self.assertEqual((self.bundle / 'transaction/worker.env').read_text(), 'CODEX_WORKER_IMAGE=worker-id\n')
        self.assertIn('EnvironmentFile=', self.dropin.read_text())

    def test_health_failure_restores_old_api_runner_and_dropin(self):
        deploy.wait_health.side_effect = [RuntimeError('candidate unavailable'), None]
        with self.assertRaisesRegex(RuntimeError, 'candidate unavailable'):
            self.apply()
        self.assertEqual(json.loads(self.compose.read_text()), self.original)
        self.assertEqual((self.runner / 'server.mjs').read_text(), 'old code')
        self.assertEqual(self.dropin.read_text(), 'prior dropin')
        self.assertEqual(self.image, 'old-id')
        self.assertEqual(json.loads((self.bundle / 'transaction/record.private.json').read_text())['state'], 'rolled_back_after_failure')

    def test_activity_arriving_after_ingress_stop_aborts_without_touching_runner(self):
        deploy.assert_idle.side_effect = RuntimeError('queued task')
        with self.assertRaisesRegex(RuntimeError, 'queued task'):
            self.apply()
        self.assertIn(['docker', 'start', 'new-api'], self.commands)
        self.assertNotIn(['systemctl', 'stop', deploy.SERVICE], self.commands)
        self.assertEqual((self.runner / 'server.mjs').read_text(), 'old code')
        self.assertEqual(json.loads(self.compose.read_text()), self.original)

    def test_explicit_rollback_restores_only_this_release(self):
        self.apply()
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.rollback(self.bundle)
        self.assertEqual((self.runner / 'server.mjs').read_text(), 'old code')
        self.assertEqual(json.loads(self.compose.read_text()), self.original)
        self.assertEqual(self.dropin.read_text(), 'prior dropin')

    def test_rollback_refuses_external_compose_change_before_stopping_services(self):
        self.apply()
        self.compose.write_text(self.compose.read_text() + '\n')
        before = len(self.commands)
        with self.assertRaisesRegex(RuntimeError, 'Production changed'):
            deploy.rollback(self.bundle)
        self.assertEqual(len(self.commands), before)


class IdleChecksTests(unittest.TestCase):
    def test_all_conversations_including_nonselected_are_checked(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            (data / 'state').mkdir()
            (data / 'state/one.json').write_text(json.dumps({'workspace': {'ownerId': 1}}))
            calls = []
            def request(url, owner):
                calls.append(url)
                if url.endswith('/workspaces'):
                    return {'workspaces': [{'id': 'workspace', 'status': 'idle'}]}
                if '?conversation=' not in url:
                    return {'conversations': [{'id': 'selected'}, {'id': 'background'}]}
                return {'workspace': {'status': 'idle'}, 'queuedTurns': [] if url.endswith('selected') else [{'status': 'paused'}]}
            with patch.object(deploy, 'DATA', data), patch.object(deploy, 'get_json', side_effect=request):
                with self.assertRaisesRegex(RuntimeError, 'queued turn'):
                    deploy.assert_idle()
            self.assertEqual(len(calls), 4)


class WorkerCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.compose = Path(self.temp.name) / 'compose.json'
        self.compose.write_text(json.dumps({'services': {'new-api': {'image': 'live-api'}}}))
        self.rootfs = {'Type': 'layers', 'Layers': ['sha256:base', 'sha256:runtime']}
        self.worker = {'Image': 'live-worker', 'HostConfig': {'ReadonlyRootfs': True}, 'Mounts': [{'Source': str(deploy.DATA / 'users/1/projects')}, {'Source': str(deploy.DATA / 'users/1/home')}]}
        self.images = {
            'new-api': {'Image': 'api-id', 'Config': {'Image': 'live-api', 'Labels': {'com.docker.compose.project': deploy.PROJECT, 'com.docker.compose.project.config_files': str(self.compose)}}},
            'candidate-worker': {'RootFS': self.rootfs},
            'live-worker': {'RootFS': self.rootfs},
            'new-api-codex-user-1': self.worker,
        }
        self.commands = []
        for mock in [
            patch.object(deploy, 'COMPOSE', self.compose),
            patch.object(deploy, 'load_release', return_value={'release': 'fixture', 'api_image_id': 'candidate-api', 'worker_image_id': 'candidate-worker'}),
            patch.object(deploy, 'inspect', side_effect=lambda name: self.images[name]),
            patch.object(deploy, 'run', side_effect=self.command),
            patch.object(deploy, 'assert_idle', return_value={'active_tasks': 0}),
            patch.object(deploy, 'get_json', return_value={}),
        ]:
            mock.start()
            self.addCleanup(mock.stop)

    def command(self, args):
        self.commands.append(args)
        return 'active' if args[0] == 'systemctl' else 'new-api-codex-user-1'

    def test_identical_worker_filesystems_preserve_personal_environments(self):
        report = deploy.preflight(Path(self.temp.name))
        self.assertEqual(report['compatible_workers'], 1)
        self.assertFalse(any(action in args for args in self.commands for action in ['stop', 'rm', 'up']))

    def test_different_worker_helper_layer_requires_separate_migration(self):
        self.images['live-worker'] = {'RootFS': {'Type': 'layers', 'Layers': ['sha256:base', 'sha256:old-runtime']}}
        with self.assertRaisesRegex(RuntimeError, 'migrate it separately'):
            deploy.preflight(Path(self.temp.name))

    def test_mutable_worker_filesystem_cannot_be_reused(self):
        self.worker['HostConfig']['ReadonlyRootfs'] = False
        with self.assertRaisesRegex(RuntimeError, 'migrate it separately'):
            deploy.preflight(Path(self.temp.name))


class ReleaseConfigurationTests(unittest.TestCase):
    def validate(self, environment):
        with tempfile.TemporaryDirectory() as root:
            bundle = Path(root)
            (bundle / 'source-sha256.json').write_text('{}\n')
            (bundle / 'runner.tar.gz').write_bytes(b'fixture artifact')
            manifest = {'runner_environment': environment, 'runner_archive': 'runner.tar.gz',
                        'source_manifest_sha256': deploy.digest(bundle / 'source-sha256.json'),
                        'runner_sha256': deploy.digest(bundle / 'runner.tar.gz'),
                        'api_image': 'fixture-api', 'api_image_id': 'fixture-api-id',
                        'worker_image': 'fixture-worker', 'worker_image_id': 'fixture-worker-id'}
            (bundle / 'release.json').write_text(json.dumps(manifest))
            with patch.object(deploy, 'inspect', side_effect=lambda name: {'Id': name + '-id'}):
                return deploy.load_release(bundle)

    def test_fixed_memory_mb_can_be_validated_before_a_release_is_applied(self):
        for value in ['256', '799', '1048576']:
            with self.subTest(value=value):
                manifest = self.validate({'CODEX_WORKER_MEMORY_MB': value})
                self.assertEqual(manifest['runner_environment']['CODEX_WORKER_MEMORY_MB'], value)

    def test_task_capacity_is_validated_independently_of_environment_capacity(self):
        for value in ['1', '8', '64']:
            with self.subTest(value=value):
                manifest = self.validate({'CODEX_MAX_ACTIVE_TASKS': value})
                self.assertEqual(manifest['runner_environment']['CODEX_MAX_ACTIVE_TASKS'], value)
        for value in ['0', '65', '2.5', 'NaN', '', 8, '8\nCODEX_MAX_ACTIVE=99']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'Unsupported runner environment override'):
                self.validate({'CODEX_MAX_ACTIVE_TASKS': value})

    def test_invalid_memory_and_percentage_overrides_are_rejected_before_deployment(self):
        for value in ['0', '255', '1048577', '256.5', 'NaN', '', 799, '799\nCODEX_MAX_ACTIVE=99']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'Unsupported runner environment override'):
                self.validate({'CODEX_WORKER_MEMORY_MB': value})
        with self.assertRaisesRegex(RuntimeError, 'Unsupported runner environment override'):
            self.validate({'CODEX_WORKER_MEMORY_PERCENT': '5'})


if __name__ == '__main__':
    unittest.main()
