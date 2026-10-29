#!/usr/bin/env python3
"""Offline bootstrap/recovery checks; temporary synthetic files only, no Docker/network."""
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import runpy
import stat
import subprocess
import sys
import tempfile
from unittest.mock import patch

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='tele-proxy-ops-check-') as directory:
    target = Path(directory)
    shutil.copyfile(root / 'bootstrap.py', target / 'bootstrap.py')
    command = [sys.executable, str(target / 'bootstrap.py')]
    invalid = subprocess.run(command + ['--image', 'mutable:latest'], capture_output=True)
    assert invalid.returncode != 0 and not (target / '.env').exists()
    valid = subprocess.run(command + ['--image', 'local/tele-proxy@sha256:' + 'a' * 64], capture_output=True)
    assert valid.returncode == 0, valid.stderr.decode()
    env = dict(line.split('=', 1) for line in (target / '.env').read_text().splitlines())
    assert len(env['LF_ENCRYPTION_KEY']) == 64
    assert env['LANGFUSE_OTLP_AUTH'] == 'Basic ' + base64.b64encode((env['LF_PUBLIC_KEY'] + ':' + env['LF_SECRET_KEY']).encode()).decode()
    secret_names = [name for name in env if name.endswith(('PASSWORD', 'SECRET', 'TOKEN', 'SALT', 'KEY')) and name not in ('LF_PUBLIC_KEY',)]
    assert len({env[name] for name in secret_names}) == len(secret_names)
    assert stat.S_IMODE((target / '.env').stat().st_mode) == 0o600
    assert stat.S_IMODE((target / 'secrets').stat().st_mode) == 0o700
    assert stat.S_IMODE((target / 'state/logs').stat().st_mode) == 0o755
    assert (target / 'secrets/metrics-token').read_text() == env['METRICS_TOKEN']
    assert not any(value.encode() in valid.stdout for key, value in env.items() if key.endswith(('PASSWORD', 'SECRET', 'TOKEN')))
    before = (target / '.env').read_bytes()
    rerun = subprocess.run(command + ['--image', 'local/tele-proxy@sha256:' + 'b' * 64], capture_output=True)
    assert rerun.returncode != 0 and (target / '.env').read_bytes() == before

    archives = []
    for service, path in [('prometheus', '/prometheus'), ('grafana', '/var/lib/grafana')]:
        archive = target / (service + '.tar')
        archive.write_bytes(b'synthetic archive; Docker copy is mocked')
        archives.append({'service': service, 'path': path, 'file': archive.name,
                         'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})
    manifest = {'project': 'synthetic-source', 'files': archives}
    override = target / 'private-restore.yaml'
    override.write_text('networks: {default: {name: synthetic-restore}}\n')
    commands, copies = [], []
    running = False
    def fake_output(command, **kwargs):
        commands.append(command)
        if command[1] == 'inspect':
            return 'true' if running else 'false'
        if command[-3:] == ['ps', '-a', '-q']:
            return 'restore-container'
        return 'restore-' + command[-1]
    def restore():
        (target / 'manifest.json').write_text(json.dumps(manifest))
        commands.clear()
        copies.clear()
        argv = ['backup.py', 'restore', str(target), '--project', 'synthetic-restore',
                '--restore-isolated', '--env-file', str(target / '.env'),
                '--compose-override', str(override)]
        with patch.object(sys, 'argv', argv), patch.object(subprocess, 'check_output', fake_output), \
                patch.object(subprocess, 'run', side_effect=lambda command, **kwargs: copies.append(command)), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                runpy.run_path(str(root / 'backup.py'), run_name='__main__')
                return 0
            except SystemExit as error:
                return error.code
    assert restore() == 0 and len(copies) == 2
    assert all(command[2:4] == ['-a', '-'] for command in copies)
    compose = commands[0]
    assert compose[compose.index('--env-file') + 1] == str(target / '.env')
    assert [compose[index + 1] for index, value in enumerate(compose) if value == '-f'] == [
        str(root / 'compose.yaml'), str(root / 'langfuse/compose.yaml'), str(override)]
    original_hash = archives[1]['sha256']
    archives[1]['sha256'] = '0' * 64
    assert restore() == 2 and not copies, 'later checksum failure must precede all writes'
    archives[1]['sha256'] = original_hash
    manifest['project'] = 'synthetic-restore'
    assert restore() == 2 and not copies, 'source project cannot be a restore target'
    manifest['project'] = 'synthetic-source'
    archives.append(dict(archives[0]))
    assert restore() == 2 and not copies, 'duplicate destination must fail before writes'
    archives.pop()
    running = True
    assert restore() == 2 and not copies, 'running targets must not be modified'
print('Bootstrap permissions/secrets and mocked offline restore preflight/override checks passed; no backend restore exercised.')
