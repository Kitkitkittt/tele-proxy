# Isolated rollout and rollback

**Historical scope:** sections 1–7 describe the original isolated canary; their commands do not authorize production changes. The operator-approved native deployment at `tele-proxy.vnibb.xyz` and later `da851bcf` redeploy are dated in [TEST_REPORT.md](TEST_REPORT.md#2026-10-29-redeploy-da851bcf-and-alternating-overhead-result); current release pointers are in section 8. The current user explicitly authorizes further implementation, commit and redeployment, not unrelated DNS/client/listener or backend changes. This documentation correction performs no runtime checks. Docker monitoring/Langfuse backends are not certified deployed by the gateway cutovers.

**Current operational decision:** the owner held redeployment until every performance run passed. Two switches (`6e8a863a-20261029T122006Z`, then `500c42b9-20261029T130824Z`) were made on an incorrect assumption that a general "commit and redeploy" instruction waived the hold; that claim is withdrawn. Two further switches follow **explicit** authorization: `a73c43a7-20261029T170132Z` (security fixes) and `8c22d9a3-20261029T183114Z` (egress-log redaction), then `73fa569a-20261029T190233Z` (review fix, current pointer, serving). The performance gate never passed (4/10 runs) and remains open; `a73c43a7`'s run passed at +4.230 ms and `8c22d9a3`'s run **failed** at +17.237 ms, so neither is qualification. Do **not** treat any switch, or any single passing run, as qualification. Native `cutover.py --check` is read-only acceptance, not a deploy command. The immediate rollback target for the current pointer is `8c22d9a3-20261029T183114Z`, then `a73c43a7-20261029T170132Z`, then `500c42b9-20261029T130824Z`; the last two lack the forged-cookie SSRF fix and the internal-header stripping. Rolling back reinstates a bypass that is latent under `requireLogin=true` and live under `requireLogin=false`, plus header leakage that is live either way.

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

`python3 selfcheck.py` is the safe offline bootstrap/recovery check: temporary-directory secret/permission assertions and mocked restore preflight/override checks. It uses no network, Docker or inference; it is not a real backend restore. Run during the main verification pass.

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

### Alternating matched benchmark

The default order remains off then on. Use `--benchmark-order=on-off` to reverse it. Each timed mode has a fresh server and separate temporary state, seeded for that mode immediately before the same six warmups and indexed sample workload. The enabled seed additionally configures policies, attribution and tariffs; those differences are part of the measured enabled configuration. Both timed modes run before the separately seeded acceptance, outage and restart exercises. JSON `benchmark.order` records the actual order; `additionalP95EstimateMs` remains enabled minus baseline, regardless of order.

After the isolated production artifact is built, record five matched off/on runs at each concurrency, alternating the first mode across runs: **10 runs total, five per concurrency**, each containing both modes. Keep all results, including failures; do not cherry-pick or compare different artifacts/hardware. The recorded `da851bcf` gate passed only 3 of 10 runs and did not establish stable performance:

```sh
results=$(mktemp -d /tmp/tele-proxy-benchmark.XXXXXX)
failed=0
for concurrency in 1 2; do
  for pair in 1 2 3 4 5; do
    order=off-on
    if [ "$((pair % 2))" -eq 0 ]; then order=on-off; fi
    file="$results/c${concurrency}-pair${pair}-${order}.json"
    if node scripts/tele-proxy-canary.mjs --runtime=production --samples=40 --concurrency="$concurrency" --benchmark-order="$order" >"$file" 2>"$file.stderr"; then
      status=0
    else
      status=$?
      failed=1
    fi
    printf '%s\n' "$status" >"$file.exit"
    printf '%s exit=%s\n' "$file" "$status"
  done
done
printf 'results=%s failed=%s\n' "$results" "$failed"
```

Exit 0 means that invocation completed its acceptance matrix and the additional gateway p95 estimate was `<10 ms`; exit 2 means the p95 gate failed; exit 1 means the run failed before a complete comparison. Any nonzero result leaves the repeatability gate open. Retain artifact identity, hardware/workload/concurrency/sample metadata and all ten JSON stdout files, stderr files and exit-status files; an empty/incomplete result is not a passing pair. Review diagnostics for sensitive data before sharing. This mock-only estimate does not certify production latency, live providers, real Langfuse ingestion or backend-volume recovery.

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

`backup.py` refuses running containers, copies state from stopped containers via Docker's archive API (no helper image, socket mount or credentials in arguments), and writes SHA256 manifest checksums. Back up private `.env` separately and record feature commit, image pins, active profiles, schema/migration versions, secret-set reference, snapshot start/end and last accepted synthetic event time. PostgreSQL, ClickHouse, Redis and MinIO must all be present and stopped for a full Langfuse recovery point; the helper only backs up created services, so compare the manifest's service/path set with the enabled stores before calling it complete. `node-exporter` has no independent state. Compose is not HA; crashes between snapshots can lose the snapshot interval.

For rehearsal create a **different project and fresh empty volumes**, not production or the original project. Use a private Compose override to remove or change **every** published loopback port and set a distinct network name (both base files intentionally retain `tele-proxy-observability`). Compose merges port lists by default: use supported `!reset []`/`!override` semantics, not an additional port that leaves the original bind active. Also replace both canary `/app/logs` and Alloy `/var/log/tele-proxy` binds with a fresh synthetic log directory; `-p` does not isolate the shared `./state/logs` host path. Preserve read-only collector mounts. Use mocks/empty canary state only; never start a cloned gateway with copied OAuth credentials. Retain the matching **synthetic** secret set privately: fresh replacement keys cannot decrypt restored Langfuse data.

`--env-file` changes interpolation only; it does not relocate Compose `secrets.*.file` paths. The private override must point metrics/Grafana secret-file sources at the matching synthetic set, not the default `./secrets` directory. Keep those files outside git and do not bootstrap over the source environment. Preserve source image digests/configuration; do not replace a missing pinned backend image with an unrelated locally cached database image.

Use exactly the same ordered files, private env and project for container creation, helper operations and later startup. The helper accepts repeatable `--compose-override` and `--env-file` options without changing defaults. Example below assumes the operator has already prepared `$RESTORE_ENV` and `$RESTORE_OVERRIDE` at absolute private paths, inspected their effective mounts/network/ports without printing secrets, checked port availability, and confirmed the destination project/volumes have never held data. Create only services represented by the source snapshot; monitoring-only rehearsal must not create/start Langfuse or Tempo. `create` leaves containers stopped; image defaults may initialize files, so “empty” means newly allocated volumes, not reused data.

```sh
# Example monitoring-only snapshot; add canary/Langfuse/Tempo only if present in its manifest.
docker compose --env-file "$RESTORE_ENV" -p tele-proxy-restore \
  -f compose.yaml -f langfuse/compose.yaml -f "$RESTORE_OVERRIDE" \
  --profile monitoring config --quiet
docker compose --env-file "$RESTORE_ENV" -p tele-proxy-restore \
  -f compose.yaml -f langfuse/compose.yaml -f "$RESTORE_OVERRIDE" \
  --profile monitoring create
python3 backup.py restore backups/canary-YYYYMMDD --project tele-proxy-restore \
  --restore-isolated --env-file "$RESTORE_ENV" --compose-override "$RESTORE_OVERRIDE"
```

The helper validates every listed checksum, destination container and duplicate service/path before its first write and rejects the recorded source project as a target. This is not a transaction: Docker-copy failure can leave partial destination data. Keep failed targets stopped, investigate, and use a different fresh project/volumes for a retry; do not start a partially restored stack. The helper does not certify empty volumes, network/port/bind isolation, complete enabled-store coverage or synthetic credential custody; those are explicit operator preconditions above.

Open the recovered gateway with the matching build/migrations, run driver-appropriate integrity checks through the existing adapter, and compare logical/attempt counts, unknown coverage, currencies and every cost basis with the source snapshot. Start only recovered stores first, then applications on the isolated override network/ports; do not attach the source collector. Test Grafana datasource health/queries and, when included, Langfuse generation retrieval via its [pinned API contract](../../ops/observability/langfuse/README.md#retrieval-contract-and-real-ingestion-evidence). Record restore start, first healthy read and successful reconciliation times; recovery duration is through validated reads, not archive copy completion. Record snapshot age and the interval from its last accepted event to producer stop as the possible loss window. Report monitoring and Langfuse restore independently. A backup without this rehearsal is **not restore-validated**. Never use `down -v`, `volume prune`, or delete unrelated data as rollback.

## 7. Promotion and rollback boundary

Promotion is a later authorized action after mock regression, native build, private backend validation, reconciled accounting, overhead measurement, secret scan, privacy fixture and restore rehearsal pass. Take a pre-promotion consistent state backup; pin feature commit/image and record previous routing/image/config. Preserve additive DB columns/tables. Confirm old binary ignores extension schema before claiming flag-only compatibility. No production routing commands are supplied to accidentally activate ingress.

Immediate safe rollback: disable `TELE_PROXY_ENABLED`, restart the isolated canary with the same compatible image, stop exporters/backends if needed; preserve ledger and volumes. Do not remove new columns or recalculate old costs. For incompatible binary/schema rollback, stop/drain gateway, restore the **entire matching pre-change state** with its matching binary/image and secret set in an isolated rehearsal first; a flag cannot reverse migrations. Newer request/attempt evidence since the snapshot would be lost on replacement, so archive it privately before any approved restore. Production routing rollback, if ever promoted, returns the established ingress to the exact recorded old endpoint/image without changing clients or credentials. DNS/ingress/client/OAuth changes remain out of scope now.

## 8. Native systemd deployment (2026-10-29)

Public dashboard: **https://tele-proxy.vnibb.xyz**. Client base: **https://tele-proxy.vnibb.xyz/v1**. Browser/UI verification belongs to the original cutover record; no dashboard HTTP 200 was observed for the later `da851bcf` redeploy. Existing `9router.vnibb.xyz` clients continued to the same gateway without configuration changes. Both public hosts were recorded blocking `/api/metrics`; the local endpoint requires its separate bearer token. These are dated observations, not new probes.

### Per-plane status (#12)

| Plane | Status | Evidence | What is still missing |
|---|---|---|---|
| Gateway (native systemd) | **Deployed and serving** | Release `73fa569a-20261029T190233Z`; health 200 loopback and public; authenticated `/v1/models` 200; NRestarts=0. | None for serving. Performance gate open — see #11. |
| Public ingress (Cloudflare tunnel) | **Live** | `cloudflared.service` active, `NRestarts=0`; local and public DNS agree; public `/api/metrics` 404. | Browser/UI check not re-run since the original cutover. |
| State and backup | **Verified snapshot** | `data.sqlite` 688 MB, `quick_check=ok`, 303/9/7/12/1,357,997; snapshot `pre-73fa569a-…` consistent. | Restorability of the snapshot was never exercised; model catalogs excluded. |
| Monitoring (Prometheus/Grafana/Loki/Alloy) | **Not running** | No matching system units; artifacts digest-pinned and offline-validated. | Sustained capacity and storage deployment authorization, whole Compose qualification, Loki datasource health and alert activation. A later root snapshot exceeded the earlier disk-only reserve threshold; it did not qualify sustained headroom. |
| Langfuse 4.0.0 | **Not running** | Config and single-exporter mapping only; synthetic OTLP sink proof. | Real ingestion, Observations-API retrieval, retention enforcement (Enterprise entitlement). |
| Dashboards and alerts | **Authored, not activated** | 4 dashboards, 15 rules, promtool pass; 46 PromQL targets returned 200 on a native run. | Live rendering and alert firing on a running stack. Loki panel returned 400 and was never retried. |
| Backup restore (backend volumes) | **Not rehearsed** | Native SQLite restore was rehearsed historically. | Cross-project/network/port restore of monitoring and Langfuse volumes with ledger reconciliation. |

This block is the consolidated per-plane answer #12 asks for. Native SQLite rehearsal does **not** prove backend-volume restore, and none of the "not running" rows can be closed by repo-only work.

Latest recorded native production paths on the deployment workstation (not re-inspected by this correction):

| Purpose | Private/local path |
|---|---|
| Frozen current artifact | `~/.local/share/tele-proxy/current` → `releases/73fa569a-20261029T190233Z`; source `73fa569ae81f5eb3962975bcfb94ce8b26fcd9da` (previous: `8c22d9a3-20261029T183114Z`, then `a73c43a7-20261029T170132Z`, then `500c42b9-20261029T130824Z`, then `6e8a863a-20261029T122006Z`, then `da851bcf-20261029T082307Z`) |
| Current database | `~/.local/share/tele-proxy/state/db/data.sqlite` |
| Secret environment | `~/.config/tele-proxy/production.env` (0600; never print/copy into git) |
| Latest pre-redeploy snapshot | `~/.local/share/tele-proxy/backups/pre-73fa569a-20261029T190340Z`: `sqlite3.Connection.backup()` (online, consistent) after `quick_check`, plus auth/JWT/machine/mitm copies; 12 combos on the copy; model catalogs **not** included, so a restore loses them. **Not a full-state backup.** |
| Historical initial-cutover cold snapshot | `~/.local/share/tele-proxy/backups/20261029T024947Z`; separate dated recovery point, not the redeploy backup |
| Previous tele-proxy artifact | `~/.local/share/tele-proxy/releases/8c22d9a3-20261029T183114Z` — immediate rollback target for the current pointer (not re-rehearsed). It carries the egress-log redactions as two duplicated branches rather than one; behaviour is equivalent. `a73c43a7-20261029T170132Z` has the SSRF and header fixes but not the redactions. `500c42b9-20261029T130824Z`, `6e8a863a-20261029T122006Z`, `da851bcf-20261029T082307Z` and `785eeb261d68-20261028T111741Z` remain further frozen points |
| Historical legacy fallback binary | `~/.local/share/tele-proxy/rollback/9router-0.5.112/app/custom-server.js` |
| Current-state rollback profile | `/etc/systemd/system/9router.service.d/tele-proxy-state.conf` |

Read-only operational checks:

```sh
systemctl show tele-proxy.service 9router.service omniroute.service --property=Id,ActiveState,MainPID,UnitFileState,NRestarts
ss -ltnp 'sport = :20128'
curl --fail --silent --show-error http://127.0.0.1:20128/api/auth/status
```

`auth/status=200` alone is not database/inference proof; inspect configured-password/login fields, native driver log, authenticated reads and production request outcomes. Do not publish raw journal output, provider responses, keys or cookies. `node:sqlite` was observed against the dedicated target, not `sql.js` fallback. Public `1010` with a non-browser client is not evidence of gateway failure; browser User-Agent and real Chromium succeeded. Public DNS/Chromium worked while this workstation's system resolver retained a negative cache.

Systemd owns startup: tele-proxy enabled; old 9router/OmniRoute disabled. The old `@reboot` stop/update script was removed from cron and replaced by a token-free systemd delegator. Do not reintroduce it as an update/stop loop. Mutual service conflicts prevent simultaneous owners. The exposed connector token was rotated and old connector sessions evicted; credentials remain in `/etc/cloudflared/token`, never embedded in arguments/scripts. Starting/stopping a connector is separate from gateway restart.

The inherited dashboard still says `9Router 0.5.111` and may offer upstream `0.5.112`. **Do not click Update now or run the upstream global CLI to upgrade this fork.** Its source/runtime is pinned by full commit and artifact manifest, not the inherited display version. Build/qualify a new native release with isolated synthetic state, then switch `current` deliberately; never build over the running artifact.

### Current-state rollback

For the current pointer, binary rollback means deliberately selecting the previous frozen release `8c22d9a3-20261029T183114Z` and restarting the sole gateway owner against the latest compatible state. Older points in order: `a73c43a7-20261029T170132Z`, `500c42b9-20261029T130824Z`, `6e8a863a-20261029T122006Z`, `da851bcf-20261029T082307Z`, then `785eeb261d68-20261028T111741Z`. Drain requests and confirm binary/schema compatibility, state ownership and current credential custody before any approved switch. Security cost of rolling back: `a73c43a7` keeps the SSRF and header fixes and loses only the two egress-log redactions. `500c42b9` and `6e8a863a` predate both security fixes — under the current `requireLogin=true` setting that SSRF bypass stays **latent** (`isAuthenticated` still rejects a tokenless forged cookie), so it is not an immediately open egress path, but it becomes live the moment `requireLogin` is set to `false`, and the internal `x-9r-*` header leakage is live regardless. The partial snapshot is not an entire-state restore point. No rollback has been rehearsed for the four most recent switches.

**Security constraint on rollback.** Releases before `6e8a863a` reintroduce a credential disclosure: the authorized Xiaomi proxy forwarded this app's `auth_token` and `9r_mimo_login` cookie to `account.xiaomi.com`, and feature-mode logs printed upstream bodies, URLs and attacker-supplied paths. Rolling back to `da851bcf` or `785eeb` therefore requires either disabling the Xiaomi login route or accepting that leak. Rolling back to `6e8a863a` keeps the cookie fix but restores the takeover-URL and egress error-detail logging removed in `500c42b9`.

The following legacy `0.5.112` service procedure is historical fallback guidance, not the previous-release pointer:

The previous `0.5.112` binary was frozen and actually rehearsed against a disposable post-extension database with every provider inactive. It preserved core counts and authenticated combo reads. This proves the exercised schema/read path, not every provider's rollback behavior.

If an operator approves rollback, first drain active requests. The following commands **stop tele-proxy** and resume the frozen old binary against the **latest migrated state**, including rotated OAuth credentials:

```sh
sudo systemctl disable --now tele-proxy.service
sudo systemctl enable --now 9router.service
systemctl show 9router.service tele-proxy.service --property=Id,ActiveState,MainPID,UnitFileState
curl --fail --silent --show-error http://127.0.0.1:20128/api/auth/status
```

The installed 9router drop-in pins the frozen wrapper, loopback port 20128 and current state; it bypasses the upstream CLI's update/port-killing behavior. Verify public auth and real routing after any rollback. Do not run old and new gateways together. Do not restore the pre-cutover SQLite snapshot over fresher refresh tokens or delete additive ledger/policy tables. Keep a new consistent current-state backup before a deliberately approved incompatible restore; archive post-snapshot ledger evidence separately.

To return from the legacy fallback to the recorded tele-proxy release, drain/stop 9router first, then enable/start tele-proxy with `current` deliberately pointing to the selected frozen release. Keep the same current state after compatibility review. Neither direction requires changing client keys/base URLs or deleting DNS. Revert only the explicitly added hostname/metrics rules if ingress removal is separately requested; preserve unrelated tunnel entries and the old production hostname. Do not expose telemetry/admin backends as a recovery shortcut.
