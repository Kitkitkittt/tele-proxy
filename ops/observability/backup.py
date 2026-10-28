#!/usr/bin/env python3
"""Offline backup/isolated restore of this Compose project's state. Never production."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
STATE = {
    'canary': ['/app/data', '/app/data-home'],
    'prometheus': ['/prometheus'], 'grafana': ['/var/lib/grafana'],
    'loki': ['/loki'], 'alloy': ['/var/lib/alloy'], 'tempo': ['/var/tempo'],
    'postgres': ['/var/lib/postgresql/data'],
    'clickhouse': ['/var/lib/clickhouse'], 'redis': ['/data'], 'minio': ['/data'],
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('operation', choices=['backup', 'restore'])
parser.add_argument('directory', type=Path)
parser.add_argument('--project', default='tele-proxy-observability')
parser.add_argument('--restore-isolated', action='store_true')
args = parser.parse_args()
if args.operation == 'restore' and (not args.restore_isolated or args.project == 'tele-proxy-observability'):
    parser.error('restore requires --restore-isolated and a distinct --project; create empty stopped containers first')
compose = ['docker', 'compose', '--env-file', str(ROOT / '.env'), '-p', args.project,
           '-f', str(ROOT / 'compose.yaml'), '-f', str(ROOT / 'langfuse/compose.yaml'),
           '--profile', 'canary', '--profile', 'monitoring', '--profile', 'llm-observability', '--profile', 'distributed-traces']
def run(command):
    return subprocess.check_output(command, text=True).strip()
# Never stop workloads implicitly. Operator explicitly stops this isolated project first.
ids = run(compose + ['ps', '-a', '-q']).splitlines()
if not ids:
    parser.error('no created project containers found')
for cid in ids:
    if run(['docker', 'inspect', '--format', '{{.State.Running}}', cid]) != 'false':
        parser.error('all project containers must be stopped before consistent backup/restore')
os.umask(0o077)
if args.operation == 'backup':
    args.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest = {'project': args.project, 'files': []}
    for service, paths in STATE.items():
        cid = run(compose + ['ps', '-a', '-q', service])
        if not cid:
            continue
        for index, path in enumerate(paths):
            filename = f'{service}-{index}.tar'
            dest = args.directory / filename
            with dest.open('xb') as out:
                subprocess.run(['docker', 'cp', cid + ':' + path + '/.', '-'], stdout=out, check=True)
            manifest['files'].append({'service': service, 'path': path, 'file': filename,
                                     'sha256': hashlib.file_digest(dest.open('rb'), 'sha256').hexdigest()})
    (args.directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Offline backup complete. Encrypt/archive directory privately with .env separately; restore rehearsal still required.')
else:
    manifest = json.loads((args.directory / 'manifest.json').read_text())
    for item in manifest['files']:
        if item['service'] not in STATE or item['path'] not in STATE[item['service']]:
            parser.error('unrecognized backup service/path')
        src = args.directory / item['file']
        if src.parent.resolve() != args.directory.resolve():
            parser.error('unsafe manifest filename')
        with src.open('rb') as data:
            if hashlib.file_digest(data, 'sha256').hexdigest() != item['sha256']:
                parser.error('checksum mismatch: ' + item['file'])
        cid = run(compose + ['ps', '-a', '-q', item['service']])
        if not cid:
            parser.error('missing restore container: ' + item['service'])
        with src.open('rb') as data:
            subprocess.run(['docker', 'cp', '-a', '-', cid + ':' + item['path']], stdin=data, check=True)
    print('Restored offline into isolated project. Validate integrity and reconciliation before promotion. No services started.')
