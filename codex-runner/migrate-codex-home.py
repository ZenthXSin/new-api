#!/usr/bin/env python3
"""Relocate Codex's path indexes inside its non-root container, never on host."""
import json
import os
import pathlib
import re
import sqlite3
import sys

workspace = sys.argv[1]
if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", workspace):
    raise SystemExit(2)
home = pathlib.Path('/home/codex/workspaces') / workspace / '.codex'
cwd = '/workspace/projects/' + workspace + '/project'
# Only index/path columns are relocated. Prompts, messages and rollout content
# remain byte-for-byte original; thread/resume receives the current project cwd.
changes = 0
for database in home.glob('*.sqlite'):
    if database.is_symlink() or not database.is_file():
        raise ValueError('Codex database path is unsafe')
    connection = sqlite3.connect(database, timeout=10)
    try:
        connection.execute('PRAGMA trusted_schema=OFF')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, column, old, new in (
            ('threads', 'rollout_path', '/home/codex/.codex', str(home)),
            ('threads', 'cwd', '/workspace', cwd),
            ('project_roots', 'path', '/workspace', cwd),
            ('rollout_migration_skipped_rollouts', 'rollout_path', '/home/codex/.codex', str(home)),
        ):
            if table not in tables:
                continue
            columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
            if column not in columns:
                continue
            cursor = connection.execute(f'UPDATE "{table}" SET "{column}" = ? || substr("{column}", ?) WHERE ("{column}" = ? OR substr("{column}", 1, ?) = ?) AND "{column}" != ? AND substr("{column}", 1, ?) != ?', (new, len(old) + 1, old, len(old) + 1, old + '/', new, len(new) + 1, new + '/'))
            changes += cursor.rowcount
        connection.commit()
        connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    finally:
        connection.close()
print(json.dumps({'migratedPaths': changes}))
