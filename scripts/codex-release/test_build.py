#!/usr/bin/env python3
"""Build release metadata with isolated source and fake external build tools."""
import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import build


class PublicReleaseBuildTests(unittest.TestCase):
    def test_default_release_uses_public_images_and_the_bundled_worker_recipe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            (source / 'web/node_modules').mkdir(parents=True)
            (source / 'codex-runner').mkdir()
            (source / 'VERSION').write_text('test-version\n')
            for name in ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md']:
                (source / name).write_text('fixture license\n')
            worker_recipe = 'FROM node:24-bookworm-slim\nCOPY helper.py /opt/helper.py\n'
            (source / 'codex-runner/Dockerfile.workspace').write_text(worker_recipe)
            (source / 'codex-runner/helper.py').write_text('print("fixture")\n')
            output = root / 'release'

            def command(args, **kwargs):
                if args[:2] == ['go', 'build']:
                    Path(args[args.index('-o') + 1]).write_bytes(b'fixture-api')
                return subprocess.CompletedProcess(args, 0)

            argv = ['build.py', '--release', 'test-public', '--source', str(source), '--output', str(output)]
            with patch('sys.argv', argv), patch.object(subprocess, 'run', side_effect=command), patch.object(subprocess, 'check_output', return_value='sha256:fixture\n'), contextlib.redirect_stdout(io.StringIO()):
                build.main()
            api_recipe = (output / 'api/Dockerfile').read_text()
            self.assertTrue(api_recipe.startswith('FROM debian:bookworm-slim'))
            self.assertIn('ca-certificates', api_recipe)
            self.assertEqual((output / 'Dockerfile.worker').read_text(), worker_recipe)


if __name__ == '__main__':
    unittest.main()
