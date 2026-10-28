# Local Langfuse v4 observability

This is the complete, optional `llm-observability` Compose profile: `langfuse-web`, `langfuse-worker`, `postgres`, `clickhouse`, `redis`, and `minio`. It has its own project-scoped named volumes and never mounts the Docker socket, gateway state, production databases, or home directories. Only `127.0.0.1:20300` is published. Worker port 3030 and all database/object-store ports remain internal; host port 20303 is unnecessary.

**Deployment gate:** seven-day trace deletion is not enforced by Community Edition. Do not deploy until an operator accepts the retention/capacity limitation or supplies a valid Enterprise license and confirms the supported retention policy. No purge script or unsupported ClickHouse schema modification is provided.

## Version and architecture evidence

Langfuse [v4.0.0 is a published, non-prerelease release](https://api.github.com/repos/langfuse/langfuse/releases/tags/v4.0.0), published 2026-07-29. Both application images are explicitly `4.0.0`, not `3`. The [upstream Compose at this release](https://github.com/langfuse/langfuse/blob/v4.0.0/docker-compose.yml) still points to `:3`; its service/environment structure is useful, but its application tags are not copied here.

Every image is pinned to a registry-reported **multi-platform index digest**. `image-manifests.json` records the registry HTTP URL, index digest, and child digests for `linux/amd64` and `linux/arm64` (Postgres and Redis spell arm64 as `arm64/v8`). No `platform: linux/amd64` forces emulation. Registry responses were read on 2026-10-27 with Registry V2 HTTP and anonymous pull tokens, without Docker access or container deployment.

| Service | Resolved version/source tag | Registry |
| --- | --- | --- |
| langfuse-web | 4.0.0 | [Docker Hub manifest](https://registry-1.docker.io/v2/langfuse/langfuse/manifests/4.0.0) |
| langfuse-worker | 4.0.0 | [Docker Hub manifest](https://registry-1.docker.io/v2/langfuse/langfuse-worker/manifests/4.0.0) |
| postgres | 17.7-alpine | [Docker Hub manifest](https://registry-1.docker.io/v2/library/postgres/manifests/17.7-alpine) |
| clickhouse | 25.12, resolved immutably | [Docker Hub manifest](https://registry-1.docker.io/v2/clickhouse/clickhouse-server/manifests/25.12) |
| redis | 7.4.7-alpine | [Docker Hub manifest](https://registry-1.docker.io/v2/library/redis/manifests/7.4.7-alpine) |
| minio | Chainguard snapshot created 2026-10-26T20:33:29Z | [Chainguard manifest](https://cgr.dev/v2/chainguard/minio/manifests/latest) |

The MinIO source tag was `latest` **only during resolution**; Compose uses the immutable digest, not a moving tag. Its [upstream image](https://images.chainguard.dev/directory/image/minio/overview) is also the upstream Langfuse Compose choice. Registry config confirms UID 65532. Registry layer listings confirmed `minio`, `mc`, `sh`, `sleep`, and `touch` exist in this pinned snapshot, rather than assuming utilities from a different image variant. Digest and architecture evidence does not constitute a vulnerability/signature audit or a successful runtime test.

## Environment and network contract

The parent bootstrap creates `ops/observability/.env` and private secret material; this directory neither generates nor commits secrets. These are root variables in the parent observability environment, not a separate Langfuse `.env`. All variables below are required with `${VAR:?…}` interpolation; there are no fallback credentials:

| Root variable | Constraint/use |
| --- | --- |
| `LF_POSTGRES_PASSWORD` | Unique random URL-safe hexadecimal password; embedded in `DATABASE_URL`, so do not use unescaped URL delimiters. |
| `LF_CLICKHOUSE_PASSWORD` | Separate random password. |
| `LF_REDIS_PASSWORD` | Separate random password. |
| `LF_S3_ACCESS_KEY` | Unique MinIO access identifier, at least 3 characters. |
| `LF_S3_SECRET_KEY` | Separate MinIO secret, at least 8 characters. |
| `LF_SALT` | Unique random salt; preserve with backups. |
| `LF_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters (32 bytes); preserve with backups. |
| `LF_NEXTAUTH_SECRET` | Unique random session secret. |
| `LF_PUBLIC_KEY` | Provisioned project key, `pk-lf-` prefix. |
| `LF_SECRET_KEY` | Provisioned project secret key, `sk-lf-` prefix. |
| `LF_ADMIN_EMAIL` | Valid operator-controlled email address. |
| `LF_ADMIN_PASSWORD` | Unique strong administrator password (at least 12 characters). |

Bootstrap keeps `.env` mode 0600 and its private secrets directory mode 0700. Individual bind-read token files use mode 0644 so non-root container UIDs can read them; the private host directory protects traversal, and each file is mounted read-only only into its intended containers. Do not print rendered Compose/environment output. Environment-based application credentials remain inspectable by Docker administrators. Backups contain sensitive trace data and require encryption/access control. This local HTTP network is not an untrusted multi-tenant boundary.

The parent owns the named bridge network `tele-proxy-observability`. This file merges into the same Compose project with the same default network name; it does not declare an external network. The collector joins that network. All bind paths intentionally resolve from the **first** file's directory, `ops/observability`, and therefore start with `./langfuse/`. Use the ordered `-f` merge below, not `include` or a standalone invocation with a different project directory. The volume keys `lf_postgres_data`, `lf_clickhouse_data`, `lf_redis_data`, and `lf_minio_data` deliberately have no fixed `name`, so separate Compose projects do not share state.

After parent bootstrap has populated `.env`/secret files and the deployment gate is satisfied, start from the repository root:

```sh
cd ops/observability
docker compose --env-file .env \
  -f compose.yaml -f langfuse/compose.yaml \
  --profile monitoring --profile llm-observability up -d
```

Use this same ordered pair of files for the parent's backup/restore and lifecycle commands so all stores belong to one project. Do not start another project concurrently: it would contend for port 20300 and network DNS names. The initial web startup applies database migrations and provisions organization `tele-proxy`, project `tele-proxy-observability`, owner email/password, and project API keys. Public sign-up is disabled. Open `http://127.0.0.1:20300` and sign in with `LF_ADMIN_EMAIL`/`LF_ADMIN_PASSWORD`.

Initialization is create-if-absent, not a credential rotation mechanism: see [v4.0.0 initialization source](https://github.com/langfuse/langfuse/blob/v4.0.0/web/src/initialize.ts). Changing `.env` alone does not rotate an existing user's password, project key, PostgreSQL role, or MinIO metadata. Rotate through the supported application/database controls, update consumers together, and retain the original encryption key and salt for existing encrypted records.

## Exact OTLP endpoint and authentication

[Langfuse's OpenTelemetry contract](https://langfuse.com/integrations/native/opentelemetry) accepts OTLP **HTTP/protobuf or HTTP/JSON traces**, not gRPC, metrics, or logs. The collector's full trace URL is:

```text
http://langfuse-web:3000/api/public/otel/v1/traces
```

The equivalent loopback diagnostic URL is `http://127.0.0.1:20300/api/public/otel/v1/traces`. A generic `OTEL_EXPORTER_OTLP_ENDPOINT` uses the base `http://langfuse-web:3000/api/public/otel` only when that exporter appends `/v1/traces`. A signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or collector `traces_endpoint` must use the **full** URL; do not append the path twice.

Required headers:

```text
Authorization: Basic BASE64_OF_PUBLIC_KEY_COLON_SECRET_KEY
x-langfuse-ingestion-version: 4
```

The Basic username is `LF_PUBLIC_KEY`; the Basic password is `LF_SECRET_KEY`. It is not the dashboard administrator password, a bearer token, or base64 of either key alone. Generate the unwrapped encoded pair without a newline:

```sh
printf '%s:%s' "$LF_PUBLIC_KEY" "$LF_SECRET_KEY" | base64 -w 0
```

That command prints a credential: do not run it in shared logs or commit its result. The parent bootstrap should write the Basic header to its private collector secret material. For SDK env configuration the value is `Authorization=Basic <encoded-pair>,x-langfuse-ingestion-version=4`. The v4 header enables immediate writes to the v4 model; omitting it can delay direct OTLP ingestion. This stack explicitly uses the v4 `events_only`/`direct` configuration, matching [v4 worker defaults](https://github.com/langfuse/langfuse/blob/v4.0.0/worker/src/env.ts).

Only self-contained OTLP spans are in scope. Legacy incremental `/api/public/ingestion`, multimodal uploads, browser object-store URLs, batch exports, and external evaluators are intentionally not enabled. Do not send prompt bodies, responses, secrets, or identifying baggage unless the gateway's explicit capture/redaction policy permits it.

## Retention and capacity

There are three different policies; do not conflate them:

1. **Trace/event rows:** requested retention is 7 days via `LANGFUSE_INIT_PROJECT_RETENTION=7`. [Supported self-hosted retention requires Enterprise Edition](https://langfuse.com/docs/administration/data-retention). The [v4 initialization code](https://github.com/langfuse/langfuse/blob/v4.0.0/web/src/initialize.ts) only applies it when the plan has the `data-retention` entitlement; Community Edition stores event rows indefinitely. This file supplies no license and cannot promise seven-day deletion. With an approved license, inject the vendor-supported `LANGFUSE_EE_LICENSE_KEY` into **both** web and worker through a private parent override, confirm the project setting after startup, and configure any later-created projects individually. Existing projects are not changed by the init variable. Deletion is asynchronous/nightly, not an exact 168-hour deadline; datasets and audit records are outside that policy.
2. **Raw object payloads:** `minio-start.sh` creates the `langfuse` bucket and imports `lifecycle.json` before readiness. Only `events/` expires after 7 days; incomplete multipart uploads under that rule expire after 1 day. This is a real MinIO lifecycle rule, not a claim that deleting S3 objects deletes ClickHouse rows. [Upstream lifecycle guidance](https://langfuse.com/self-hosting/deployment/infrastructure/blobstorage#bucket-lifecycle-policies) states OTLP spans are self-contained, unlike legacy incremental ingestion. Seven days bounds retry/replay/disaster-recovery history: do not adopt it if failed ingestion can remain queued longer. No media prefix is expired, because dataset/media lifetime differs. Bucket versioning is not enabled; if enabled later, explicitly expire noncurrent versions/delete markers as well. Lifecycle scanning is asynchronous.
3. **Operational logs:** each Docker JSON log is capped at 3 × 10 MiB per service (about 180 MiB total, excluding rotation overhead). ClickHouse text logs go to console; file-log space is a 64 MiB tmpfs, query-log TTL is 7 days, and unused high-volume system logs are disabled. Query-log TTL does not govern application traces.

| Service | CPU cap | Memory cap |
| --- | ---: | ---: |
| Web | 1 | 1 GiB |
| Worker | 1 | 2 GiB |
| PostgreSQL | 0.5 | 512 MiB |
| ClickHouse | 2 | 4 GiB |
| Redis | 0.25 | 384 MiB |
| MinIO | 0.5 | 512 MiB |

Memory caps total 8.375 GiB before Docker/host overhead. Reserve capacity rather than assuming this fits an 8 GiB machine. ClickHouse's internal memory ceiling is 3 GiB; Redis uses 256 MiB with `noeviction` so queue loss is not disguised as healthy eviction. Redis exhaustion rejects writes; investigate backlog before increasing limits. All services restart `unless-stopped`, have bounded process counts, health checks, and stop grace periods. Health status does not itself trigger Compose restarts; restart policy handles exited processes. Worker health checks include queue/event-propagation liveness via the [v4 worker health API](https://github.com/langfuse/langfuse/blob/v4.0.0/worker/src/api/index.ts).

Named volumes do **not** impose disk quotas. PostgreSQL WAL target and Redis memory/AOF rewrite thresholds are not hard disk limits. The parent monitoring stack must watch the filesystem hosting Docker volumes and alert on free bytes/inodes and growth; define an operator-approved disk budget, reserve at least 20% free space, and stop ingestion before exhausting it. Redis AOF and ClickHouse merges need temporary headroom. Community Edition trace storage remains unbounded by age even with S3 lifecycle. Do not deploy without accepted retention/capacity ownership; resource/log limits cannot fix that license boundary.

## Backups, restore, rollback

Use the parent's offline backup/restore workflow for these **four volumes together** plus the private root environment, encryption key, salt, image digest record, and configuration. Raw MinIO objects are not a substitute for PostgreSQL project/auth metadata or ClickHouse trace rows. Redis AOF holds pending ingestion jobs, so preserve it at the same recovery point.

1. Stop the collector/other producers, allow the worker to drain, then stop web and worker. Stop PostgreSQL, ClickHouse, Redis, and MinIO cleanly before volume copies. Never tar live database files and claim consistency.
2. Copy the four stopped volumes through the parent's offline Docker-copy backup mechanism. Encrypt the archive, store it off-host with the credentials/configuration in a separately controlled backup, record the project/volume names and image digests, and keep the original stack stopped until copying completes. Follow an explicitly accepted backup expiration policy; backups can retain data beyond the online seven-day objective.
3. Restore into a **new Compose project** with new empty project-scoped volumes and the same pinned images/secrets. Keep all restored containers stopped during population. Never overwrite active volumes or point a rehearsal at production/gateway state. The parent's restore helper must preserve numeric owners (Postgres/Redis image users, ClickHouse 101, MinIO 65532) and file permissions.
4. For a rehearsal, override the fixed network name with a distinct isolated test network and remove or change the loopback web port; a new project name alone does not isolate DNS on `tele-proxy-observability` or release port 20300. Do not attach the production collector. Start stores first, then web/worker, confirm health, login, project keys, recent trace visibility, queue drainage, and object access. Record recovery time and the restored recovery point before permitting producers.
5. For rollback after an image/migration change, stop producers and the changed stack, restore the matching pre-upgrade volume set into a separate project using its recorded image digests, verify it in isolation, then explicitly cut over. Do not simply downgrade application tags against migrated PostgreSQL/ClickHouse data. Keep the failed stack stopped for investigation rather than deleting unrelated volumes.

No deployments, container pulls, Compose validators, tests, or restore drills were run while authoring these artifacts. Registry HTTP manifests and primary-source contracts were inspected; runtime and recovery verification remain operator/main-agent work after the deployment gate is resolved.
