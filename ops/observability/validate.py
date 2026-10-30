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
# Authenticated runtime proof when the isolated stack is up: both provisioned
# datasources must answer a real query, one of them returning points/lines.
grafana_enabled = False
if shutil.which('docker'):
    try:
        grafana_enabled = subprocess.run(['docker', 'compose', '--env-file', str(ROOT / '.env'), '-f', str(ROOT / 'compose.yaml'), '--profile', 'monitoring', 'ps', '--status', 'running', '--services'], cwd=ROOT, capture_output=True, text=True, timeout=60).stdout.find('grafana') != -1
    except Exception:
        grafana_enabled = False
if grafana_enabled and (ROOT / 'secrets' / 'grafana-password').exists():
    import base64
    import urllib.request
    password = (ROOT / 'secrets' / 'grafana-password').read_text().strip()
    auth = 'Basic ' + base64.b64encode(f'teleproxy-admin:{password}'.encode()).decode()
    def grafana(path, payload=None):
        request = urllib.request.Request('http://127.0.0.1:20301' + path, data=None if payload is None else json.dumps(payload).encode(), headers={'Authorization': auth, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    try:
        sources = {source['uid']: source['type'] for source in grafana('/api/datasources')}
        dashboards = grafana('/api/search?type=dash-db')
        rendered = {}
        for uid, query in (('prometheus', 'nine_router_inflight_requests'), ('loki', '{service="tele-proxy"}')):
            if uid not in sources:
                rendered[uid] = None
                continue
            body = grafana('/api/ds/query', {'queries': [{'refId': 'A', 'datasource': {'type': sources[uid], 'uid': uid}, 'expr': query, 'range': True, 'instant': False, 'intervalMs': 15000, 'maxDataPoints': 100}], 'from': 'now-1h', 'to': 'now'})
            frame = body['results']['A']
            values = frame.get('frames', [{}])[0].get('data', {}).get('values', []) if frame.get('frames') else []
            rendered[uid] = len(values[0]) if values else 0
        summary = f'datasources={len(sources)} dashboards={len(dashboards)} points=' + ','.join(f'{k}:{v}' for k, v in rendered.items())
        if len(sources) >= 2 and len(dashboards) >= 4 and all(isinstance(v, int) and v > 0 for v in rendered.values()):
            record('grafana-runtime-datasources-and-panels', 'pass', summary)
        else:
            record('grafana-runtime-datasources-and-panels', 'unavailable', 'stack up but no rendered series: ' + summary)
    except Exception as error:
        record('grafana-runtime-datasources-and-panels', 'unavailable', 'grafana reachable? ' + type(error).__name__)
else:
    record('grafana-runtime-datasources-and-panels', 'unavailable', 'requires started isolated Grafana, authenticated API and real metric series; JSON syntax is not rendering proof')
record('langfuse-generation-mapping', 'unavailable', 'requires separately authorized capacity/retention license decision and healthy backend stack')
print(json.dumps(results, indent=2))
sys.exit(1 if any(x['status'] == 'fail' for x in results) else 2 if any(x['status'] == 'unavailable' for x in results) else 0)
