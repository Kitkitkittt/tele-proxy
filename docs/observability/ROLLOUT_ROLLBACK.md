# Isolated rollout and rollback

**Stop boundary:** loopback canary only. `proxy.vnibb.xyz` remains an intended name; no DNS, public ingress, live OAuth, metered inference or client configuration change is part of these commands. Commands below are operator procedures, not claimed executed results. Check [TEST_REPORT.md](TEST_REPORT.md) for actual evidence. Docker was inaccessible (permission denied) in the implementation environment; backends are **not deployed**.

## 1. Prepare without starting anything

1. Use branch `codex/1-tele-proxy`, retain upstream pin `3a978a631ad65529c06e48ce495092d5bba29f46`; record the actual feature commit/image digest in the release record. Build the gateway natively on the deployment CPU architecture using the repository workflow; pin its registry content digest. Do not substitute an upstream stock image without this feature. Do not use emulation or copy live data/refresh tokens.
2. Check sustained CPU/RAM/disk, occupied ports, existing service reservations and Docker permission on the chosen host. Current reported 51GiB disk/13GiB available RAM does **not** meet vendor-recommended full-stack Langfuse capacity with headroom. Monitoring-only is a separate decision; do not install storage on a pressured production gateway.
3. Generate independent canary secrets without displaying them:

```sh
cd ops/observability
python3 bootstrap.py --image local-registry/tele-proxy@sha256:YOUR_ACTUAL_64_HEX_DIGEST
# Input above must be an actual immutable image digest; bootstrap rejects placeholders.
```

`bootstrap.py` refuses replacement; `.env` and `secrets/` are ignored, private, and must never be attached to an issue. No default passwords exist. Back up `.env` encrypted offline; its Langfuse encryption key is necessary for recovery. Do not run shell tracing or paste expanded Compose output. Rotate by deliberate replacement plus affected service recreation, not rerunning bootstrap over existing state.

`python3 selfcheck.py` is the safe offline bootstrap check: temporary-directory validation, unique-secret/permission assertions, and refusal-to-overwrite. It uses no network, Docker or inference; run during the main verification pass.

## Production artifact gate: feature off at build, on at startup

Run from the repository root in a credential-free shell, on the native deployment architecture. These are required operator commands, not executed evidence. `npm ci` preserves the root lockfile and native dependency lifecycle scripts; do not substitute an unlocked install or disable scripts. The Dockerfile uses the same locked install with its existing registry/retry flags. `.dockerignore` includes the root lockfile in the build context; `.npmignore` is unrelated to Docker.

```sh
set -eu
umask 077
SMOKE_ROOT="$(mktemp -d /tmp/tele-proxy-production-smoke.XXXXXX)"
mkdir -p "$SMOKE_ROOT/build-home" "$SMOKE_ROOT/run-home"
npm ci
env TELE_PROXY_CANARY=1 TELE_PROXY_ENABLED=0 DATA_DIR="$SMOKE_ROOT/build-state" HOME="$SMOKE_ROOT/build-home" NEXT_TELEMETRY_DISABLED=1 npm run build
# Stop here if install/build failed. Start this exact standalone artifact, not next dev.
export TELE_PROXY_METRICS_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
env NODE_ENV=production PORT=20283 HOSTNAME=127.0.0.1 NEXT_TELEMETRY_DISABLED=1 \
  TELE_PROXY_CANARY=1 TELE_PROXY_ENABLED=1 TELE_PROXY_ENVIRONMENT=canary \
  DATA_DIR="$SMOKE_ROOT/run-state" HOME="$SMOKE_ROOT/run-home" \
  INITIAL_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')" \
  JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  API_KEY_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  TELE_PROXY_PSEUDONYM_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  node .next/standalone/custom-server.js >"$SMOKE_ROOT/runtime.log" 2>&1 &
SMOKE_PID=$!
trap 'kill "$SMOKE_PID" 2>/dev/null || true' EXIT
# Bounded readiness; require HTTP 200, not just a listening port.
curl --retry 60 --retry-connrefused --retry-delay 1 --retry-max-time 120 --connect-timeout 2 --max-time 5 --fail --silent --show-error http://127.0.0.1:20283/api/auth/status
curl --fail --silent --show-error http://127.0.0.1:20283/login >"$SMOKE_ROOT/login.html"
printf 'header = "Authorization: Bearer %s"\n' "$TELE_PROXY_METRICS_TOKEN" | \
  curl --config - --fail --silent --show-error http://127.0.0.1:20283/api/metrics >"$SMOKE_ROOT/metrics.txt"
# After all inspection and mock-only requests, stop only this smoke process.
kill "$SMOKE_PID"
wait "$SMOKE_PID" || [ "$?" -eq 143 ]
trap - EXIT
```

`PORT` and `HOSTNAME` configure the standalone server; `--port` does not. Keep port20283 free and use fresh smoke state, never production state. Clear inherited provider credentials, proxy settings and OTLP headers/endpoints before starting; use only a local synthetic collector when inspecting exports. Do not run shell tracing or publish the private smoke directory. Retain redacted evidence, then remove only this newly created directory.

**Release gates:** inspect both prerendered `.next/server/app` HTML and fetched login/dashboard HTML plus browser network requests. No Google Analytics scripts, `gtag` initialization, analytics measurement ID or Google Analytics/Tag Manager request may be baked into the artifact in either feature mode; analytics was removed, not flag-hidden. Authenticated metrics must return real series and unauthenticated metrics must remain denied. Exercise mock-only inference with a synthetic sentinel, then inspect runtime stdout, legacy console-capture buffers, capture directories, OTLP payloads and retained state per [PRIVACY.md](PRIVACY.md): no prohibited content or legacy capture initialization. Record build exit, runtime checks, artifact identity and unavailable gates in [TEST_REPORT.md](TEST_REPORT.md). A health response alone does not satisfy these privacy gates.

`node scripts/tele-proxy-canary.mjs --runtime=production --samples=40 --concurrency=2` exercises this exact standalone artifact with the feature off and on, authenticates the dashboard, and checks fetched login/Combos HTML for analytics. Omitting `--runtime=production` selects the separate development-runtime regression. Docker image build/runtime validation remains separate and unavailable until daemon permission exists. Neither native run implies deployment or promotion.

## 2. Validate on a Docker-capable host

From `ops/observability`, after secrets exist. Compose requires a current v2 plugin supporting profiles and the `local` logging driver. `config --quiet` checks without printing expanded credentials:

`python3 validate.py` runs the same pinned config checks plus four-dashboard JSON checks and prints a secret-free JSON summary. Exit0 means all exercised checks passed,1 a failure,2 an explicitly unavailable validator/runtime check. It does not deploy backends or make inference requests; Grafana rendering and Langfuse mapping remain separate runtime gates.

```sh
docker compose --env-file .env -f compose.yaml -f langfuse/compose.yaml --profile canary --profile monitoring --profile llm-observability --profile distributed-traces config --quiet
docker compose --env-file .env --profile monitoring run --rm --no-deps --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose --env-file .env --profile monitoring run --rm --no-deps --entrypoint /bin/promtool prometheus check rules /etc/prometheus/alerts.yml
docker compose --env-file .env --profile monitoring run --rm --no-deps alloy validate /etc/alloy/config.alloy
docker compose --env-file .env --profile monitoring run --rm --no-deps loki -config.file=/etc/loki/config.yaml -verify-config=true
```

Use pinned binaries from the images, not an unrelated host version. Grafana JSON syntax alone is insufficient: start Grafana with its real provisioning and inspect `/api/health`, provisioning logs, datasource `/api/datasources/uid/prometheus/health`, and each of the four dashboard UIDs from JSON via authenticated API. Query real series and confirm panels are neither query errors nor misleading zeros. Validate optional Tempo with its pinned binary/version when enabling and check `/ready`. Langfuse health/generation tests need its full storage/worker stack, not merely web-container startup.

No validators are claimed passed here. Record missing binaries/daemon access, commands, exit status, output locations and image digest in `TEST_REPORT.md`. Do not relabel unavailable tools as skipped passes.

## 3. Start isolated gateway/monitoring only

```sh
docker compose --env-file .env --profile monitoring up -d
docker compose --env-file .env --profile canary up -d canary
docker compose --env-file .env --profile canary --profile monitoring ps
```

The gateway's image must allow non-root UID1000 and initialize its own named volumes. Its state is `canary-data`/`canary-home`, never production. `state/logs` contains only the app's metadata-only redacted JSON: active `gateway.jsonl` plus two rotated files, each5MiB (15MiB ceiling); Alloy reads it read-only. Bootstrap prepares that directory; if the host UID is not1000, grant UID1000 write access to this new directory only. If named-volume initialization fails, fix ownership on these new empty volumes only; never mount production state or run blanket host `chown`.

Candidate local URLs (not reachable claims): gateway `http://127.0.0.1:20280`, Grafana `http://127.0.0.1:20301`, Prometheus `http://127.0.0.1:20900`, Alloy `http://127.0.0.1:20345`, Loki readiness `http://127.0.0.1:20310/ready`. Bindings are loopback; use an authorized SSH tunnel for remote access. Metrics `/api/metrics` needs the generated bearer token; avoid placing it in process arguments or command history. Prometheus reads a read-only secret file.

Seed the exact issue's `quality-engineering` v1 using the isolated canary fixture/exercise, not migrations/global configuration. Existing combo POST plus authenticated `PUT /api/combos/{id}/policy` uses `{policyId:"quality-engineering", text:EXACT_SPEC_TEXT, enabled:true, required:true, mergeMode:"append_preserve_client", maxInjectedTokens:600, expectedVersion:null}`. A real authenticated dashboard-session cookie is required even when `requireLogin=false`; provider bearer keys and CLI bypass do not authorize policy changes. The canonical text lives in the canary exercise fixture. Required-policy local failure must make zero mock upstream dispatches. Do not seed or modify production combos. No provider credentials are needed for mocks.

Run the repository's deterministic canary exercise against mock providers: success, forced fallback, tool request/result, streaming terminal usage, client cancellation, and collector outage. Verify distinct attempt IDs, one logical request, ledger completeness/cost basis, actual final upstream payloads and no prohibited content in logs/spans. Header receipt must not count as first content. Compare enabled/disabled gateway overhead with identical fixture/concurrency/sample count; report measured p95, target <10ms additional overhead, not a universal SLA. Parent integration report owns actual commands/results.

Metadata traces run at 100% on the small canary. With Langfuse off, Alloy retries at most15s per batch and drops from a bounded queue; this expected outage must not block inference. Ledger persists independently. Missing Langfuse means generation mapping remains unverified, not successful.

## 4. Optional Langfuse and Tempo gates

Langfuse 4.0.0 setup details, exact OTLP path/auth, storage lifecycle and architecture evidence: [stack README](../../ops/observability/langfuse/README.md). Before starting, obtain sufficient sustained capacity and resolve the **Enterprise-only full time-based trace retention** requirement. Seven-day raw S3 event expiry is implemented separately; it is not full Community Edition trace deletion. Do not bypass this with unreviewed ClickHouse/PostgreSQL deletion. `llm-observability` stays off until the supported retention/capacity decision is accepted.

```sh
docker compose --env-file .env -f compose.yaml -f langfuse/compose.yaml --profile llm-observability up -d
```

Candidate Langfuse URL is `http://127.0.0.1:20300`, never a verified endpoint until health and login succeed. Prove one logical trace with two real mock dispatches produces exactly two generation observations; root has no billable cost, usage/model are correct, unknown cost stays unknown/reference-labeled, explicit zero remains zero and exporter retry does not duplicate ledger totals. Confirm ingestion-v4 header and inspect that Langfuse's automatic reference price does not masquerade as cash spend.

Tempo is disabled initially. To enable, start `distributed-traces`; copy optional Alloy exporter content into the active configuration and add `otelcol.exporter.otlphttp.tempo.input` to the existing batch output (one gateway export stream, collector fan-out). Validate/reload Alloy. Then provision the optional Tempo datasource. Do not claim Tempo receives traces merely because its process exists.

## 5. Retention, growth and routine operations

Prometheus:14d/4GB; Loki:7d+2h compactor delay; Tempo:7d when enabled; Docker service logs:3x10MB. Queue bounds are independent from disk retention. Daily invoke the authenticated admin `POST /api/usage/ledger` body `{ "action":"retention", "retentionDays":90 }` if the integration has not installed the equivalent same-process schedule. Terminal records older than cutoff are transactionally pruned; inflight requests/attempts are retained; tariff/fixed-fee evidence is preserved. Do not claim90d automatic retention without a verified scheduler.

Record quiet-baseline bytes and24h positive growth per named volume, requests/second, attempts/request, active series and compression. Use formulas in [ARCHITECTURE.md](ARCHITECTURE.md); no growth rate has been measured here. Alert before15% free or72h projected exhaustion, reserve10GiB rollback/OS space, and stop telemetry ingress before ledger durability is endangered. Inspect CPU/RAM over representative sustained load; container limits are ceilings, not allocations or sizing proof. No service notification delivery is configured: alerts are visible in Prometheus/Grafana only. Add an existing authorized receiver separately and record delivered evidence.

## 6. Consistent backup and isolated restore rehearsal

Use cold backups for this small canary; no SQLite driver/WAL assumption. Drain mock traffic and stop **only this named project**; stops do not delete volumes. Backups include sensitive state and must be encrypted/stored outside the public repo.

```sh
docker compose --env-file .env -f compose.yaml -f langfuse/compose.yaml --profile canary --profile monitoring --profile llm-observability --profile distributed-traces stop
python3 backup.py backup backups/canary-YYYYMMDD
# Restart only previously active profiles, not all profiles.
```

`backup.py` refuses running containers, copies state from stopped containers via Docker's archive API (no helper image, socket mount or credentials in arguments), and writes SHA256 manifest checksums. Back up private `.env` separately and record feature commit, image pins, active profiles and migration versions. PostgreSQL, ClickHouse, Redis and MinIO must all be stopped for this consistent offline boundary. Compose is not HA; crashes between snapshots can lose the snapshot interval.

For rehearsal create a **different project and fresh volumes**, not production or the original project. Use a private Compose override to bind different loopback ports and a distinct network name (root uses fixed network `tele-proxy-observability`); never start a cloned gateway with copied OAuth credentials. Use mocks/empty canary state only. `docker compose -p tele-proxy-restore ... create` creates stopped containers. Then:

```sh
python3 backup.py restore backups/canary-YYYYMMDD --project tele-proxy-restore --restore-isolated
```

Verify manifest checksums (script does), open the recovered gateway with the matching build/migrations, run driver-appropriate integrity checks through the existing adapter, and compare logical/attempt counts, unknown coverage, currencies and every cost basis with the source snapshot. Start recovered backends only on the isolated override network/ports; test Langfuse generation retrieval and Grafana datasource health. Record duration, reconciliation and maximum recoverable age. A backup without this rehearsal is **not restore-validated**. Never use `down -v`, `volume prune`, or delete unrelated data as rollback.

## 7. Promotion and rollback boundary

Promotion is a later authorized action after mock regression, native build, private backend validation, reconciled accounting, overhead measurement, secret scan, privacy fixture and restore rehearsal pass. Take a pre-promotion consistent state backup; pin feature commit/image and record previous routing/image/config. Preserve additive DB columns/tables. Confirm old binary ignores extension schema before claiming flag-only compatibility. No production routing commands are supplied to accidentally activate ingress.

Immediate safe rollback: disable `TELE_PROXY_ENABLED`, restart the isolated canary with the same compatible image, stop exporters/backends if needed; preserve ledger and volumes. Do not remove new columns or recalculate old costs. For incompatible binary/schema rollback, stop/drain gateway, restore the **entire matching pre-change state** with its matching binary/image and secret set in an isolated rehearsal first; a flag cannot reverse migrations. Newer request/attempt evidence since the snapshot would be lost on replacement, so archive it privately before any approved restore. Production routing rollback, if ever promoted, returns the established ingress to the exact recorded old endpoint/image without changing clients or credentials. DNS/ingress/client/OAuth changes remain out of scope now.
