#!/usr/bin/env python3
"""Offline assert-based bootstrap checks; temporary files only, no Docker/network."""
import base64
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

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
print('Bootstrap validation, permissions, unique secrets and refusal-to-overwrite checks passed.')
