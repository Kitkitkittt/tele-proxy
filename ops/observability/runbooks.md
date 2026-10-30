# Tele-proxy canary observability runbooks

## Scope, prerequisites, and alert delivery

These files describe an isolated canary, not a production deployment claim. Run Compose commands below from `ops/observability`. Keep DNS, ingress, production credentials, and client endpoints unchanged. Do not paste environment values, authorization headers, raw databases, or proprietary request/response content into incident notes.

Required service DNS and private ports:

| Service | Endpoint / prerequisite |
|---|---|
| Canary | `canary:20128/api/metrics`; `TELE_PROXY_ENABLED=1`, `TELE_PROXY_ENVIRONMENT=canary`, metrics token configured |
| Prometheus | `prometheus:9090`; `/etc/prometheus/prometheus.yml` and `/etc/prometheus/alerts.yml` mounted read-only; readable `/run/secrets/metrics-token` matching canary token |
| Grafana | `grafana:3000`; provisioning directory at `/etc/grafana/provisioning`; dashboards at `/var/lib/grafana/dashboards`; metrics enabled; unique admin password |
| Alloy | `alloy:12345/metrics`; OTLP receiver on private `4318`; bounded file-log and trace export pipelines |
| Loki | `loki:3100`; private metrics and log API; persistent bounded storage |
| Node exporter | `node-exporter:9100`; isolated canary data volume mounted read-only at `/storage`; its own `/proc` mountinfo and read-only `/sys`; no host root or Docker socket mount |

Prometheus scrapes six services every 15 seconds, with a 10-second timeout and 30-second rule evaluation. Canary uses bearer authorization read from the mounted secret, never a token in committed YAML. Its scrape sample/label limits bound accidental cardinality. No administrative usage credentials are provisioned in Grafana. Prometheus and Loki datasource UIDs are `prometheus` and `loki`; no Tempo datasource or service is required.

Grafana automatically provisions four dashboards into **Tele Proxy**. Browser links use the isolated Compose loopback ports: gateway `http://127.0.0.1:20280`, Grafana `http://127.0.0.1:20301`, Prometheus `http://127.0.0.1:20900`. These are configuration defaults, not verified reachable URLs. Use an authorized SSH tunnel for remote access; loopback links otherwise refer to the browser's machine. Change the checked-in links if the canary binding changes; do not change public ingress for monitoring.

**Notifications are disabled.** There is no Alertmanager target, receiver, webhook, email, or external delivery configured. Every rule carries `delivery=dashboard_only`; pending/firing `ALERTS` appear in all four dashboards. Prometheus `/alerts` exposes full annotations including runbook links. Those links target the feature branch on GitHub and resolve once that branch is published; this file remains the offline runbook. No notification delivery has been tested or claimed. If Prometheus or Grafana itself is down, this stack cannot reliably announce its own complete outage; inspect container health through the existing authorized operational channel.

Thresholds are initial canary guardrails, not approved production SLOs: failure >10%, fallback events/request >0.2, rate-limited attempts >10%, and missing usage >5%. Ratio alerts require at least 20 observations in their lookback plus sustained duration; critical ledger/policy and telemetry-loss events do not wait for traffic volume. Calibrate after observing synthetic canary traffic. No budget, stale-quota, or inferred billing alert exists without a real configured authoritative signal.

## Metric contract and accounting boundaries

Application metrics use prefix `nine_router_`, with bounded `environment` on every series:

| Suffix | Type / additional labels | Meaning |
|---|---|---|
| `requests_total` | Counter; `combo,outcome` | One finalized logical request |
| `attempts_total` | Counter; `provider,outcome,reason` | One finalized actual upstream attempt |
| `upstream_http_5xx_attempts_total` | Counter; `provider` | Settled instrumented HTTP attempts with an observed upstream response status 500–599 |
| `confirmed_empty_streams_total` | Counter; `combo` | Fully consumed successful client responses positively recognized as empty canonical single-choice OpenAI Chat SSE; not a total across protocols |
| `request_duration_seconds` | Histogram; `combo,outcome` | Logical request through terminal completion/cancellation/failure |
| `upstream_first_content_seconds` | Histogram; `provider` | Attempt dispatch to meaningful upstream content, not headers |
| `client_first_content_seconds` | Histogram; `combo` | Request ingress to meaningful client content, not headers |
| `tokens_total` | Counter; `provider,type` | Normalized token categories across attempts |
| `fallbacks_total` | Counter; `reason` | Fallback events, potentially several per request |
| `inflight_requests` | Gauge | Active logical requests |
| `policy_application_failures_total` | Counter; `reason` | Policy application failure |
| `usage_unknown_total` | Counter; `provider` | One finalized attempt lacking complete input/output usage |
| `ledger_write_failures_total` | Counter | Durable accounting degradation |
| `telemetry_dropped_total` | Counter; `reason` | Bounded trace-export/log queue failures or drops |
| `export_queue_size` | Gauge | Current application export queue depth |
| `process_resident_memory_bytes` | Gauge | Gateway process RSS, not container memory |
| `process_start_time_seconds` | Gauge | Gateway process start time as Unix seconds; changes between scrapes show observed process restarts, not container restart counts |
| `process_cpu_seconds_total` | Counter | Cumulative process CPU time |
| `event_loop_delay_seconds` | Gauge | Gateway event-loop delay |

Outcomes: `success`, `error`, `cancelled`, `incomplete`. Routing reasons: `rate_limit`, `upstream_error`, `network`, `timeout`, `auth`, `policy`, `cancelled`, `unknown`. Drop reasons: `queue_full`, `export_failed`, `init_failed`, `log_queue_full`, `log_write_failed`. Token types: `input`, `output`, `cached_input`, `cache_write`, `reasoning`. Cached input and reasoning may already be included in inclusive input/output; do not sum detail categories into inclusive totals. Histograms have finite boundaries `.05,.1,.25,.5,1,2.5,5,10,30,60,120,300,600` seconds plus `+Inf`; extreme quantiles beyond the finite ceiling are not exact latency measurements.

No request/key/session/project identifiers, prompt hashes, raw errors, or arbitrary model strings are metric labels. Loki index labels are only `service` and `environment`; correlation IDs remain JSON fields. Log panels query metadata-only gateway logs, not container discovery or raw bodies.

**The durable ledger is authoritative.** Open authenticated `/dashboard/usage` for reconciliation and project-level attribution. `GET /api/usage/ledger` supplies known/unknown usage/cost coverage, currency totals in integer Micros across reported, reconciled, metered, reference, subscription and local bases, plus fixed fees. Divide by 1,000,000 only within one currency. Do not add alternative bases or currencies together; do not multiply fixed period fees by request count. Unknown charges are not zero, metered estimates are not provider invoices, and reference value is not cash spend or guaranteed savings. These facts are deliberately not invented as Prometheus billing metrics or obtained by scraping the authenticated admin API.

Operational coverage limitations are explicit on dashboards: tokens cannot be grouped by combo/project from this metric contract. The 5xx counter covers observed upstream `Response` statuses and DNS-bypass response-like statuses on instrumented HTTP attempts, not native-managed transports, network failures without a response, or gateway/client-facing status codes. An absent series is unknown, not zero; `increase` also requires enough scrapes. Empty-stream coverage is limited to canonical single-choice OpenAI Chat SSE; unknown and unsupported streams are not classified. There is no gateway-only overhead, per-call generation-speed, quota-age, configured-budget, or authoritative container-restart series. Provider success fraction measures observed attempts, not active provider health. Process start-time changes reveal observed process restarts, but multiple restarts between scrapes count once. First-content p95 differences do not measure gateway overhead. Aggregate output tokens/second measures finalized tokens over wall time, not per-call generation speed or inter-token latency. Use ledger/log evidence and the controlled benchmark for those questions.

### Missing-signal classification (#10)

Each signal the ticket requires is either implemented, covered by an authoritative alternative, or an omission. "Alternative" means a documented, authenticated path exists — **not** that the signal appears in Prometheus. Omissions are not accepted without an operator decision.

| Required signal | State | Evidence / alternative |
|---|---|---|
| Requests vs attempts | Implemented | `nine_router_requests_total`, `nine_router_attempts_total`; authoritative reconciliation in `/api/usage/ledger`. |
| Provider availability | **Not implemented** | `nine_router_attempts_total{outcome}` measures observed attempts, not active-provider health. No synthetic provider poller exists; availability remains unknown. |
| Combo/project token views | **Alternative** | Forbidden as metric labels; use authenticated `GET /api/usage/ledger` project attribution and `/dashboard/usage`. |
| Observed HTTP 5xx attempts | **Implemented, bounded** | `nine_router_upstream_http_5xx_attempts_total{provider}` counts observed upstream 500–599 responses on instrumented HTTP attempts, including DNS bypass, not native-managed transports, network failures, or client-facing statuses. Missing series is unknown, not zero; this is not complete coverage of every transport. |
| Empty-stream count | **Implemented, limited** | `nine_router_confirmed_empty_streams_total{combo}` counts fully consumed successful client-facing SSE only when every chunk matches the strict canonical single-choice OpenAI Chat allowlist with consistent response identity (ID and model at most 128 characters), one finish reason `stop`, and `[DONE]`. Only bounded identity metadata is retained temporarily; content is never retained beyond the bounded message being parsed. It excludes content, mismatched identity, unsupported fields/formats, malformed/oversized data, invalid UTF-8, errors, missing terminal and cancellation. Absence is unknown, not zero; no complete empty-stream rate is implied. |
| Per-call generation speed / inter-token latency | **Omission** | Only aggregate finalized tokens over wall time. Use the controlled benchmark. |
| Gateway-only overhead | **Alternative** | `scripts/tele-proxy-canary.mjs` paired off/on runs with per-request provider subtraction. |
| Quota age | **Alternative** | Provider quota state lives in provider metadata, not metrics; read from the dashboard. |
| Configured budget | **Omission** | No budget engine exists; inventing one is out of scope for #10. |
| Container restarts | **Alternative** | `nine_router_process_start_time_seconds` changes reveal observed restarts; multiple restarts between scrapes count once. Native systemd, so no container series applies. |
| Telemetry queue depth and drops | Implemented | `nine_router_export_queue_size` (gauge, depth) and `nine_router_telemetry_dropped_total{reason}`. |
| Cancellations | Implemented | `nine_router_attempts_total{outcome="cancelled"}` and ledger `cancelled` outcome. |
| First-content timing | Implemented, bounded | `nine_router_client_first_content_seconds` and `nine_router_upstream_first_content_seconds` histograms; a p95 difference between them is not proof of gateway overhead. |
| Request latency | Implemented | `nine_router_request_duration_seconds` histogram. |
| In-flight requests, event-loop delay, RSS, CPU | Implemented | `nine_router_inflight_requests`, `nine_router_event_loop_delay_seconds`, `nine_router_process_resident_memory_bytes`, `nine_router_process_cpu_seconds_total`. |
| Unknown-usage rate | Implemented | `nine_router_usage_unknown_total`. |

Accepting the omissions is an operator decision this document cannot grant. The runtime half of #10 — Loki datasource health, one real log query, alert activation — remains blocked on a running #9 monitoring stack.

## Canary unavailable

Alerts: `TeleProxyCanaryUnavailable`.

1. Check `docker compose --profile canary --profile monitoring ps` and Prometheus `/targets`. Distinguish refused connection/timeouts, HTTP 401/403, sample-limit errors, and malformed metrics.
2. Confirm the isolated canary is intended to run, private DNS resolves, and container port is 20128. Check secret-file permissions and token agreement without printing either value. Do not make `/api/metrics` public to fix scraping.
3. Inspect bounded, redacted canary metadata logs and resource health. Repair only the canary process or mount involved. A successful scrape proves the metrics endpoint is reachable, not that every upstream provider works.
4. Clear only after consecutive successful scrapes and a synthetic request within the existing authorized test setup. Do not send paid production traffic as a health probe.

## Request failures

Alerts: `TeleProxyRequestFailureRate`.

1. Open Routing reliability; compare logical outcomes with provider attempt outcomes and fallback reasons. Cancellation is separate from error/incomplete.
2. Correlate request/trace IDs in metadata logs and the ledger, not metric labels. Check capability/policy failures, incomplete streams, provider response classification, and downstream cancellation.
3. Restore the specific canary configuration or previously pinned canary image when a regression is established. Preserve current ledger volumes and evidence. Do not suppress errors, silently drop tools/history, or retry a new model after content reached the client.
4. Resolve after the sustained failure ratio recovers; low traffic can make a ratio disappear without proving the issue fixed. Confirm a deterministic synthetic request separately.

## Fallbacks and rate limits

Alerts: `TeleProxyElevatedFallbacks`, `TeleProxyUpstreamRateLimited`.

1. Compare `fallbacks_total` by finite reason with `attempts_total{reason="rate_limit"}` by provider. Multiple fallback events per logical request can make the event ratio exceed one.
2. Check authorized provider quota/rate evidence and attempt ledger status. `rate_limit` identifies classified 429 failures; `upstream_error` includes other upstream errors and must not be called a precise 5xx count.
3. Reduce test concurrency or pause the affected canary workload; honor provider retry/quota policy. Do not rotate accounts to evade quotas, change production credentials, or enable unapproved metered fallback.
4. Confirm the configured fallback preserves policy, tools, context, and protocol; inspect every charged attempt in the ledger, including the failed primary.

## Missing usage

Alerts: `TeleProxyMissingUsage`.

1. Compare unknown-usage events with finalized attempts for the same environment/window. In-flight requests have not finalized. An idle dashboard or a missing counter is not proof of known usage.
2. In the authenticated ledger inspect incomplete attempts, cancellations, missing terminal stream usage, unsupported usage fields and provenance. Recover abandoned attempts as incomplete/unknown, never successful/free.
3. Reconcile against provider evidence only through supported admin workflows; preserve reported usage over estimates and inclusive-token semantics. Do not derive authoritative costs from sampled traces or counters.
4. Unknown cost can remain after usage is known when tariffs/billing evidence are missing. Verify usage coverage and cost coverage independently.

## Policy failure

Alerts: `TeleProxyPolicyApplicationFailure`.

1. Identify combo/policy version/hash from local authorized ledger/metadata records; do not log the full policy body.
2. Confirm required-policy failures prevented upstream dispatch. If an upstream call occurred, stop the affected synthetic workload and preserve evidence.
3. Correct the specific immutable policy/configuration or select the previously approved version. Never disable a required policy, use a client bypass header, or downgrade it to an untrusted user instruction merely to clear an alert.
4. Check policy-preservation fixtures and a controlled mock upstream before resuming canary traffic.

## Ledger write failure

Alerts: `TeleProxyLedgerWriteFailure`.

1. Treat usage/cost coverage as degraded immediately. Inspect data-volume capacity, ownership/read-only mounts, database-driver errors and supported migration state. Do not print database contents or credentials.
2. Keep telemetry/export availability separate: restoring Alloy cannot recover failed authoritative writes. Do not replay inference requests to reconstruct charges.
3. Preserve the database and use the documented backup/restore procedure. Stop the affected canary workload if needed to prevent unaccounted activity. A configured mandatory budget must not fail open when its authoritative store is unavailable.
4. After repair, reconcile missing attempts against authorized evidence and mark unrecoverable amounts unknown. A quiet error counter after restart is not proof of completeness.

## Disk pressure

Alerts: `TeleProxyStorageLow`, `TeleProxyStorageCritical`, `TeleProxyStorageMetricsMissing`.

1. Check `/storage` node-exporter series and scrape health. Its mountinfo must describe the exporter container's `/storage` bind; using host `/proc/1/mountinfo` can hide that mount. A missing metric is a monitoring failure, not healthy free space.
2. Capacity is the canary volume's backing filesystem, not an isolated volume quota. Verify the actual storage paths and free space for Prometheus/Loki/Alloy/Langfuse separately; this exporter does not mount or inventory every backend filesystem.
3. Review measured growth, existing retention, rotation and pending backups. Initial configured bounds are metrics 14 days with 4 GB TSDB retention; logs 7 days with bounded application rotation; export queues have independent limits. Size retention from measured bytes/request and workload, not example vendor sizing.
4. Pause synthetic canary load before exhaustion. Use supported retention/cleanup only for this stack's disposable telemetry after preserving required evidence. Never run broad Docker prune, delete unrelated volumes, or touch production data to clear an alert. Never delete ledger records as a telemetry cleanup shortcut.

## Export drops

Alerts: `TeleProxyTelemetryDrops`, `TeleProxyExportQueueBacklog`, `TeleProxyCollectorExportFailure`, `TeleProxyCollectorEnqueueFailure`.

1. Compare application drop reasons, queue depth and backend scrape availability. `log_write_failed` can mean filesystem/ownership failure; `queue_full` and `export_failed` can indicate collector outage. Inference must stay available and queues bounded.
2. Check Alloy's readiness and receiver/exporter health, Langfuse profile health and OTLP endpoint/authentication agreement without exposing headers. Inspect Loki file-source/write health separately; a healthy Alloy scrape does not prove either export path is delivering records.
3. Collector counters use `otelcol_exporter_send_failed_spans` and `otelcol_exporter_enqueue_failed_spans` (OTel Collector 0.125.0 embedded in Alloy 1.9.2); rules accept Prometheus-translated `_total` variants with `or`, not an additive duplicate. Failed sends may be retried, while enqueue rejection indicates lost observations. Runtime metric spelling still requires deployed validation.
4. Restore the backend/network/permissions, not unbounded buffers or synchronous model-path export. Keep one gateway trace stream into Alloy. Do not add a second direct Langfuse exporter to mask collector failures.
5. Confirm queues drain and drops stop under a bounded synthetic collector-outage/recovery scenario. Lost investigative telemetry is not a reason to replay authoritative accounting events or infer missing charges.

## Backend unavailable

Alerts: `TeleProxyTelemetryBackendUnavailable`.

1. Inspect the named Prometheus target error and `docker compose --profile monitoring ps`; check resource limits, readiness, private DNS, read-only configuration mounts and secret permissions.
2. For Grafana check metrics are enabled; a scrape failure may not mean its UI is down. For Loki inspect retention/storage and `/ready`; for Alloy inspect receivers and exporter health. Never enable unauthenticated public access as remediation.
3. If Prometheus is stopped it cannot evaluate its own unavailability. Use container health and the established operational channel; no external watchdog/notification system is provisioned here.
4. Restore only the affected isolated service, keeping persistent volumes. Confirm scrape recovery and data delivery independently.

## Checks for the integrating agent

No builds, tests, validators, or live smoke checks were run for these artifacts in this assignment. From the repository root, use the pinned Prometheus image's `promtool` to run `check config` with the Compose mounts/secrets and `check rules` on `alerts.yml`; run `test rules` on `alerts.test.yml`. Validate Grafana provisioning/import and all panel queries against the pinned Grafana/Prometheus services; observe zero traffic and missing-series states. Confirm `/storage` filesystem visibility, collector metric spellings, classified 429 attempts, alert transitions/annotations, and the metadata-only Loki panel under a synthetic collector outage. Do not describe generated JSON or a configured localhost URL as proof of a deployed dashboard.
