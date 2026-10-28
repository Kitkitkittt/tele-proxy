#!/usr/bin/env python3
"""Run pinned configuration validators; never deploy or issue inference requests."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
results = []
def record(name, status, detail=''):
    results.append({'check': name, 'status': status, 'detail': detail})
# Syntax and provisioning references are safe offline; not a rendering/runtime claim.
for path in sorted((ROOT / 'grafana/dashboards').glob('*.json')):
    try:
        dashboard = json.loads(path.read_text())
        if not dashboard.get('uid') or not dashboard.get('panels'):
            raise ValueError('missing uid/panels')
        record('json:' + path.name, 'pass')
    except (ValueError, OSError) as error:
        record('json:' + path.name, 'fail', str(error))
if len(list((ROOT / 'grafana/dashboards').glob('*.json'))) != 4:
    record('four-dashboards', 'fail', 'expected exactly four JSON dashboard files')
if not shutil.which('docker'):
    record('docker-validators', 'unavailable', 'docker binary absent')
else:
    daemon = subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], capture_output=True)
    if daemon.returncode:
        record('docker-validators', 'unavailable', 'Docker daemon unavailable or permission denied; no containers started')
    elif not (ROOT / '.env').exists():
        record('docker-validators', 'unavailable', 'run bootstrap first; secrets are never generated implicitly')
    else:
        base = ['docker', 'compose', '--env-file', str(ROOT / '.env'), '-f', str(ROOT / 'compose.yaml')]
        checks = [
            ('compose', base + ['-f', str(ROOT / 'langfuse/compose.yaml'), '--profile', 'canary', '--profile', 'monitoring', '--profile', 'llm-observability', '--profile', 'distributed-traces', 'config', '--quiet']),
            ('prometheus-config', base + ['--profile', 'monitoring', 'run', '--rm', '--no-deps', '--entrypoint', '/bin/promtool', 'prometheus', 'check', 'config', '/etc/prometheus/prometheus.yml']),
            ('prometheus-rules', base + ['--profile', 'monitoring', 'run', '--rm', '--no-deps', '--entrypoint', '/bin/promtool', 'prometheus', 'check', 'rules', '/etc/prometheus/alerts.yml']),
            ('prometheus-rule-fixtures', base + ['--profile', 'monitoring', 'run', '--rm', '--no-deps', '--entrypoint', '/bin/promtool', 'prometheus', 'test', 'rules', '/etc/prometheus/alerts.test.yml']),
            ('alloy', base + ['--profile', 'monitoring', 'run', '--rm', '--no-deps', 'alloy', 'validate', '/etc/alloy/config.alloy']),
            ('loki', base + ['--profile', 'monitoring', 'run', '--rm', '--no-deps', 'loki', '-config.file=/etc/loki/config.yaml', '-verify-config=true']),
        ]
        for name, command in checks:
            try:
                result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=180)
                # Never print captured output: Compose diagnostics may expand secret values.
                record(name, 'pass' if result.returncode == 0 else 'fail', 'exit=' + str(result.returncode))
            except subprocess.TimeoutExpired:
                record(name, 'fail', '180s timeout')
record('grafana-runtime-datasources-and-panels', 'unavailable', 'requires separately started isolated Grafana, authenticated API and real metric series; JSON syntax is not rendering proof')
record('langfuse-generation-mapping', 'unavailable', 'requires separately authorized capacity/retention license decision and healthy backend stack')
print(json.dumps(results, indent=2))
sys.exit(1 if any(x['status'] == 'fail' for x in results) else 2 if any(x['status'] == 'unavailable' for x in results) else 0)
