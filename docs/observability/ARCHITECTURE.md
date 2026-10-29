# Tele-proxy observability architecture

Scope: feature-flagged extension of upstream 9Router 0.5.111, commit `3a978a631ad65529c06e48ce495092d5bba29f46`. Existing routing, OAuth, translators, clients and production ingress remain authoritative and unchanged. **The cutover is complete**: `tele-proxy.vnibb.xyz` is the live public endpoint (native systemd, release `a73c43a7-20261029T170132Z`). The earlier `proxy.vnibb.xyz` promotion target is historical and was not activated.

## Data flow and authority

```text
client -> existing auth -> immutable combo-policy snapshot -> route/translate
       -> actual upstream dispatch(es) -> backpressure-preserving response
                |                             |
                +-> local durable request/attempt ledger <- terminal usage
                +-> bounded metadata OTel SDK -> Alloy -> Langfuse v4
                +-> finite operational metrics -> Prometheus -> Grafana
                +-> redacted operational JSON -> Alloy -> Loki -> Grafana
```

One logical request owns distinct attempts for actual dispatches, including refresh dispatches. Headers/keepalives are not first content. Terminal completion, cancellation and process-death recovery determine completeness. Telemetry export is asynchronous and may drop; ledger records remain unsampled and are the reconciliation authority. Prometheus and sampled investigation traces are **not billing records**. See [ACCOUNTING.md](ACCOUNTING.md) for exact storage and tariff semantics and [PRIVACY.md](PRIVACY.md) for capture boundaries.

`TELE_PROXY_ENABLED=1` enables the extension. Absent/disabled preserves upstream behavior. Local policy versions are available without calling Langfuse. Required-policy application failure stops dispatch; exporter failure does not. Do not conflate these failure modes.

Image-generation requests use the same authenticated request root and per-dispatch accounting. Image adapters expose prompt-only generation rather than a trusted instruction channel, so enabled required combo policies reject before provider work; policies off preserve existing routing. Submitted HTTP generations and authentication retries are distinct attempts, while task polling and asset downloads are not generation. Image outputs without reported token usage remain unknown. Direct video creation also owns one authenticated logical root; its HTTP creation sends and authentication resends are physical attempts. Vertex `:predictLongRunning` creates a job, while `:fetchPredictOperation` polling POSTs and xAI/OpenRouter polling GETs are not generations. Video usage and cost remain unknown when the provider reports neither. Native executors use their existing physical send hooks; hidden or unrecognized executor boundaries explicitly mark accounting incomplete without inventing attempts. Video combos remain rejected before dispatch, including required-policy combos. Other non-chat modality coverage must not be inferred from image/video instrumentation.

## Deployment profiles and isolation

`ops/observability/compose.yaml` defines optional `canary`, `monitoring`, and `distributed-traces` profiles. `ops/observability/langfuse/compose.yaml` defines `llm-observability`, sharing only the dedicated telemetry network. No production DB, credentials, OAuth state, Docker socket, request capture or host home directory is mounted. Node exporter reads host `/sys` read-only and its own `/proc`, with the isolated canary data filesystem mounted read-only at `/storage`; host CPU/RAM counters are not per-container reservations. No production file contents are mounted. A user with Docker access still has host-level privileges; these profiles do not change that trust boundary.

| Profile | Services | Persistent state | Published host bindings |
| --- | --- | --- | --- |
| canary | immutable locally built gateway image | separate canary data + home volumes | `127.0.0.1:20280` |
| monitoring | Prometheus, Grafana, Loki, Alloy, node exporter | dedicated per-service volumes | `127.0.0.1:20900`, `20301`, `20310`, `20418`, `20345` |
| llm-observability | Langfuse 4.0.0 web/worker, PostgreSQL, ClickHouse, Redis, MinIO | four dedicated storage volumes | `127.0.0.1:20300` web only |
| distributed-traces | Tempo, disabled initially | dedicated Tempo volume | `127.0.0.1:20320` |

Loopback/private Docker network is the backend authorization boundary; metrics additionally require a unique bearer token. Grafana and Langfuse have unique admin secrets. No public ingress, DNS, OAuth or notification-channel setup is included. Local untrusted users must not be allowed access to the telemetry network or Docker daemon. For access from another workstation, use an authorized SSH tunnel rather than publishing backend ports.

All service images are pinned by registry index digest, with native Linux amd64/arm64 manifest evidence in `ops/observability/image-manifests.json` and the Langfuse directory. No `platform` override or emulation is selected. Native gateway build/dependency support must still be verified on its actual target architecture. Registry existence is not runtime compatibility, a vulnerability audit, or deployment proof.

## Signal contracts and dashboards

Gateway metrics use framework-native `/api/metrics`; any `/metrics` convenience rewrite must preserve authentication. Low-cardinality dimensions are bounded environment, combo/provider/model catalogs, outcome and finite reasons. Never add request IDs, project/session strings, hashes, secrets or raw errors as metric labels. Structured request/trace IDs are investigation fields, not Loki index labels. Loki indexes only service/environment.

Four provisioned Grafana dashboards cover usage/unknown-cost coverage, routing reliability, separate upstream/client first content, and infrastructure/exporter health. Their text panels link authoritative ledger/admin views for per-project attribution, fixed fees, invoice-reconciled spend, provider charges, metered estimates, subscription allocations, API-equivalent reference value and local infrastructure assumptions. Distinct bases must never be summed into a cash total. Missing series show missing evidence rather than synthetic zero-cost claims. Prometheus alert rules and [runbooks](../../ops/observability/runbooks.md) are code; delivery is dashboard-visible only until an existing authorized receiver is configured.

Initial alert thresholds are engineering defaults, not an agreed production SLO. Minimum event counts suppress unstable low-traffic percentage alarms. Confirm traffic and latency objectives before promotion. Ledger-write failures, required-policy failures, drops and backend unavailability remain actionable at low volume.

## Langfuse v4 mapping

The pinned v4.0.0 OTLP endpoint is `http://langfuse-web:3000/api/public/otel/v1/traces`, Basic authorization from the project public/secret key pair, with `x-langfuse-ingestion-version: 4`. Alloy sets explicit `traces_endpoint`; it does **not** append `/v1/traces` twice. SDK exports only to Alloy. Root request spans are non-billable; each dispatch is one generation with explicit usage, policy version/hash and cost-basis metadata. The Langfuse display-model field is namespaced `tele-proxy-unpriced::provider::actualModel` to prevent shipped reference-price matching; the actual model remains queryable in generation/metadata attributes. Do not add a cash tariff to that namespace unless its documented basis is intended. Automatic model-reference pricing is not evidence of paid spend. Inspect generation count, zero versus unknown and displayed cost basis before trusting the UI. See [pinned stack notes](../../ops/observability/langfuse/README.md).

Canary metadata traces start at 100%; no head sampler claims to retain every eventual error. Alloy memory limiter, finite batches/queue, timeout and bounded retries cap outage impact. No disk-backed trace queue is enabled. Optional Tempo is storage only until its exporter is deliberately wired; it is not an initial inference dependency. True agent tool execution, correctness evaluation and inter-token timing are not observed by gateway dispatch instrumentation.

## Retention and capacity

Prometheus uses supported 14-day time retention **and 4GB size retention** (whichever first); Loki compactor uses 7 days plus deletion delay; Tempo block retention is 7 days when enabled. Docker local logs rotate at 3 x 10MB per service. Queues are independently bounded. Retention is not a filesystem quota: Loki/ClickHouse/MinIO/ledger can exhaust disk before deletion under high ingress. Alert on projected exhaustion and stop telemetry ingestion before threatening the gateway ledger.

Langfuse v4 Community Edition does not enforce the self-hosted Enterprise time-based trace-retention feature. Raw event-object lifecycle alone does not delete ClickHouse/PostgreSQL trace metadata. Seven-day full Langfuse retention therefore requires the supported licensed feature or an explicitly accepted larger-capacity deployment, **not an undocumented SQL purge**. No Langfuse deployment is claimed here. Ledger pruning uses `pruneLedger({retentionDays:90})` or authenticated admin retention operation; schedule daily if the integration does not. It transactionally removes only old terminal records, never inflight requests/attempts, preserving tariff and fixed-fee evidence.

Given reported local headroom (51GiB free disk, 13GiB available RAM), the full Langfuse profile is held: vendor guidance is 4 cores/16GiB RAM and 100GiB example storage, in addition to gateway/monitoring and host reserve. Resource limits are test ceilings, not proof the vendor workload fits. Reserve at least 20% host memory and 10GiB disk for OS/rollback, and measure sustained usage before selecting a host. Do not move storage to a production host merely because it is reachable.

Measure storage rather than assert a guessed bytes/request rate. At two quiet snapshots record volume bytes, logical-request and attempt deltas, scrape series, retention age, compression, replicas and workload. For signal i: `bytes_per_request_i = max(0, delta_volume_bytes_i - idle_growth_i) / delta_requests`; record attempts/request separately. Estimate `daily_bytes_i = bytes_per_request_i * measured_requests_per_second * 86400 + idle_daily_i`, then `required_i = daily_bytes_i * retention_days * 1.5 + WAL/compaction_peak_i`. Metrics instead use measured bytes/series/day times active series. `days_to_full = usable_free_bytes / positive_net_daily_growth`; alert before 72h and 15% free. Re-measure after model mix, label catalog, retention or sampling changes. No measured growth or p95 overhead result exists until the main integration report records an exercised workload.

## Limitations and evidence

Compose, backend health and generation mapping require version-specific validation on a Docker-capable host. Docker **is** reachable here via noninteractive `sudo -n docker info` (server `29.1.3`, x86_64) — the earlier "permission denied" note described the unprivileged client and is superseded. Nothing has been started, so the artifacts remain configuration, not running services. Current headroom is **32 GiB free on a 93%-used root filesystem and 16.9 GiB available RAM**, tighter than the older 51 GiB/13 GiB figures; disk is the binding constraint for any telemetry store. Capacity, retention-license acceptance, backup restore rehearsal and live credentials/spend authorization remain separate promotion gates. No live inference, production volume mount, DNS, ingress or active client endpoint change is authorized by these artifacts. [ROLLOUT_ROLLBACK.md](ROLLOUT_ROLLBACK.md) contains executable validation and recovery instructions; actual executed results belong in [TEST_REPORT.md](TEST_REPORT.md).
