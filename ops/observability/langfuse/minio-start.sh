#!/usr/bin/sh
set -eu

minio --certs-dir /tmp/certs server --address :9000 --console-address :9001 /data &
server_pid=$!
trap 'kill -TERM "$server_pid" 2>/dev/null || :; wait "$server_pid" || :' TERM INT EXIT

attempt=0
until mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && mc ready local >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'MinIO did not become ready within 60 startup attempts' >&2
    exit 1
  fi
  sleep 1
done
mc mb --ignore-existing local/langfuse
mc ilm import local/langfuse < /etc/langfuse/lifecycle.json
touch /tmp/langfuse-bucket-ready
wait "$server_pid"
