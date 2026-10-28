#!/usr/bin/env python3
"""Generate isolated canary secrets. Does not start services or contact a provider."""
import argparse
import base64
import os
from pathlib import Path
import re
import secrets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True, help='Locally built tele-proxy repository@sha256:digest')
parser.add_argument('--email', default='admin@canary.invalid', help='Canary-only Langfuse administrator')
args = parser.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}', args.image):
    parser.error('--image must be an immutable repository@sha256:digest')
if not re.fullmatch(r'[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+', args.email):
    parser.error('invalid email')
root = Path(__file__).resolve().parent
if (root / '.env').exists() or (root / 'secrets').exists():
    parser.error('refusing to replace existing secrets; back up and rotate explicitly')
os.umask(0o077)
(root / 'secrets').mkdir(mode=0o700)
(root / 'state').mkdir(mode=0o755, exist_ok=True)
(root / 'state').chmod(0o755)
(root / 'state' / 'logs').mkdir(mode=0o755, exist_ok=True)
(root / 'state' / 'logs').chmod(0o755)
if os.getuid() == 0:
    os.chown(root / 'state' / 'logs', 1000, 1000)
elif os.getuid() != 1000:
    print('Before startup grant container UID1000 write access to state/logs; no host ownership changed.')
values = {key: secrets.token_hex(32) for key in (
    'METRICS_TOKEN', 'GRAFANA_ADMIN_PASSWORD', 'CANARY_JWT_SECRET',
    'CANARY_ADMIN_PASSWORD', 'CANARY_API_KEY_SECRET', 'CANARY_MACHINE_ID_SALT',
    'LF_POSTGRES_PASSWORD', 'LF_CLICKHOUSE_PASSWORD', 'LF_REDIS_PASSWORD',
    'LF_S3_SECRET_KEY', 'LF_SALT', 'LF_ENCRYPTION_KEY', 'LF_NEXTAUTH_SECRET',
    'LF_ADMIN_PASSWORD',
)}
values.update({
    'TELE_PROXY_IMAGE': args.image,
    'LF_S3_ACCESS_KEY': 'tp' + secrets.token_hex(12),
    'LF_PUBLIC_KEY': 'pk-lf-' + secrets.token_hex(16),
    'LF_SECRET_KEY': 'sk-lf-' + secrets.token_hex(32),
    'LF_ADMIN_EMAIL': args.email,
})
values['LANGFUSE_OTLP_AUTH'] = 'Basic ' + base64.b64encode(
    (values['LF_PUBLIC_KEY'] + ':' + values['LF_SECRET_KEY']).encode()
).decode()
with (root / '.env').open('x') as env:
    for key, value in values.items():
        env.write(f'{key}={value}\n')
for filename, key in (('metrics-token', 'METRICS_TOKEN'), ('grafana-password', 'GRAFANA_ADMIN_PASSWORD')):
    path = root / 'secrets' / filename
    with path.open('x') as secret_file:
        secret_file.write(values[key])
    # Docker binds these read-only into non-root containers; parent directory stays 0700.
    path.chmod(0o644)
print('Created private .env and secrets/. No services started; no secret values printed.')
