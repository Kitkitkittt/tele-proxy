# Verification report

Observed 2026-10-27–28. Synthetic providers only. This is canary evidence, not a production-readiness declaration or security audit. Production services, credentials, OAuth ownership, DNS/ingress and client configurations were not changed.

## Executed checks

| Check | Observed result |
|---|---|
| Final policy/ledger/dispatch/media/stream/telemetry/native/catalog/lifecycle regression command | 31 files passed; 460 tests passed; 1 existing opt-in full Next canary skipped. Serial worker run; separate actual standalone canary executed below. An earlier run overlapping the production build hit two 10-second fixture setup timeouts; no timeout or assertion was weakened. |
| Dashboard guard and telemetry regression | 2 files passed; 33 tests passed. Exact enabled `GET /api/metrics` reaches its own bearer authentication; nested paths, POST and disabled feature remain protected. |
| `env TELE_PROXY_CANARY=1 TELE_PROXY_ENABLED=0 DATA_DIR=/tmp/tele-proxy-build-state HOME=/tmp/tele-proxy-build-home NEXT_TELEMETRY_DISABLED=1 npm run build` | Final frozen-source build passed on Next.js 16.4.3; standalone static/public assets and custom server copied. Inherited `lazyRuntime.js` dynamic `createRequire`/dependency-expression warnings remain. The same artifact is exercised with the flag on at runtime below. |
| `python3 ops/observability/selfcheck.py` | Passed temporary bootstrap validation, unique secrets, private permissions and refusal to overwrite. No secrets printed. |
| `python3 ops/observability/validate.py` | Four dashboard JSON checks passed; exit 2 because Docker validators, real Grafana panels/datasources and real Langfuse mapping were unavailable. No containers started. |
| Prometheus 3.4.2 `promtool check rules alerts.yml` and `promtool test rules alerts.test.yml` | Passed: 15 rules and alert scenarios. Native binary matches the pinned version; this does not prove scrape connectivity. |
| Alloy 1.9.2 `validate ops/observability/alloy/config.alloy` and Loki 3.5.1 `-config.file=ops/observability/loki/config.yaml -verify-config=true` | Both native pinned-version validators exited 0. No services started. |
| Docker Compose merged-profile `config --quiet` | Client-side validation exited 0 with synthetic environment values, despite inaccessible Docker daemon/user config. No real secrets generated, no containers started. |
| Gitleaks 8.30.1 final redacted directory scan | 823 detections: 767 ignored `.next` generated artifacts; 56 nongenerated detections unchanged from the prior upstream-line comparison; zero new nongenerated matches. Public OAuth/client constants and placeholder/test examples are not evidence of newly added user credentials. No generated state is staged/published. |

Focused regression command, from `tests/`:

```sh
env NODE_OPTIONS=--trace-warnings ./node_modules/.bin/vitest run unit/combo-policy-native.test.js unit/combo-policy-storage.test.js unit/combo-policy-api.test.js unit/combo-policy-editor.test.js unit/request-ledger.test.js unit/request-ledger-durability.test.js unit/observe-generation.test.js unit/dispatch-context.test.js unit/dispatch-physical-retries.test.js unit/native-browser-dispatch.test.js unit/native-media-dispatch.test.js unit/native-h2-wreq-dispatch.test.js unit/trae-dispatch.test.js unit/tele-proxy-integration.test.js unit/gateway-telemetry.test.js unit/policy-eligibility.test.js unit/request-origin.test.js unit/codex-gpt6-lite.test.js unit/systemone-dispatch.test.js unit/tele-proxy-catalog-startup.test.js unit/dashboard-guard.test.js unit/tts-ledger.integration.test.js unit/image-generation-ledger.integration.test.js unit/video-generation-ledger.integration.test.js unit/audio-embedding-ledger.integration.test.js unit/non-generation-combo-policy.test.js unit/request-details-lifecycle.test.js unit/db-driver-chain.test.js unit/devin-cli-executor.test.js unit/token-refresh-dispatch.test.js unit/usage-dispatch.test.js --maxWorkers=1
```

The command selects existing files; nonexistent alternate filenames do not imply additional suites ran. Native and integration regressions cover Codex Lite prefixes, known lossy schema/reasoning transformations, required Claude cache-marker preservation, Gemini response envelopes, estimated-token provenance, binary-to-decoded usage, physical Cursor recovery, sql.js abrupt-exit durability, failed-ledger-write incompleteness, wire-model tariffs, merge-mode off, and actual local catalog capabilities.

## Actual Next ingress canary

Executed:

```sh
node scripts/tele-proxy-canary.mjs --runtime=production --samples=40 --concurrency=2
```

All 25 behavior cases passed against the final Next standalone custom-server `/v1` ingress, built with the feature off and started with it on. The benchmark target is reported separately below; a behavioral pass is not a performance pass. Each run owns loopback ports 20280/20281, private temporary HOME/data directories and synthetic credentials, then stops its servers and removes state. It never attaches to an existing server or copies OAuth credentials. Earlier development-runtime and browser checks remain supporting evidence only.

Verified final mock-upstream payloads and persisted records for policy off/on; complete multi-paragraph policy once per attempt; client system/developer instructions; token-saver bypass; 429 fallback (2 sends); inherited 503 retries plus fallback (5 sends); OpenAI-to-Anthropic tools/results; Responses string/structured input; native Anthropic cache blocks; streaming first-content/terminal usage; missing usage; cancellation; spoofed attribution/policy headers; authenticated metrics; bounded export queue/drop counter during collector outage; continued inference; duplicate settlement; restart recovery and abandoned-unknown accounting; required-policy failure with zero sends; no prohibited fixture content in logs/exports.

A synthetic OTLP JSON consumer received 67 batches in the quiet final-artifact run. At the mapping checkpoint it contained 20 request roots and 25 generation observations, including exactly 2 for the forced fallback. Roots are non-billable. This proves the gateway's serialized mapping, **not real Langfuse ingestion or UI behavior**. Required image/speech policies made zero sends; policy-off binary routes made exactly one send each with unknown usage/cost. Authenticated login/Combos HTML had no GA script or preload in either runtime feature mode.

### Ledger reconciliation

Final snapshot after restart/rejection:

| Measurement | Count/value |
|---|---:|
| Logical requests | 88 |
| Physical attempts | 92 |
| Usage-known attempts | 80 |
| Usage-unknown attempts | 12 |
| Cost-known attempts | 72 |
| Cost-unknown attempts | 20 |
| Complete requests | 71 |
| Incomplete requests | 17 |
| Metered estimates, micro-USD | 8640 |

The harness compares actual enabled mock dispatches with ledger attempts before adding the crash/rejection fixtures, checks unique attempt IDs and stored attempt counts, and sums settled attempt estimates to exactly the authoritative total. Failed/missing-terminal/cancelled/abandoned attempts retain unknown cost. Provider charges, invoice spend, subscription fees, reference values and local allocations are not invented by this fixture.

### Overhead

Intel Core i5-6300HQ @2.30GHz, Linux x64, 4 logical CPUs, 25,072,115,712 bytes RAM, Node v24.20.0. Same indexed fixture, 10ms synthetic provider delay, non-streaming 100 input/20 output tokens, 6 warmups followed by 40 samples per mode, concurrency 2. Overhead is p95 of each request's elapsed time minus its matching mock-provider duration; it is not the difference between unrelated percentiles.

| Measurement, ms | Feature off | Feature on |
|---|---:|---:|
| Total p50 | 41.62 | 39.54 |
| Total p95 | 47.11 | 60.80 |
| Mock-provider p95 | 11.45 | 11.15 |
| Gateway p95 estimate | 36.32 | 51.38 |

Additional gateway p95 estimate: **15.07ms**, above the initial 10ms target; command exited 2 while all 25 behavior cases passed. An earlier run overlapping the full-tree secret scan measured 106.54ms and is not treated as controlled overhead. The quiet run had no build/test/scan workload. The earlier development-runtime 3.17ms result does not certify this artifact. Small sequential mode windows limit generalization; no production SLA or sustained-load claim.

CPU/native timing and a narrowly scoped write/sync syscall probe traced the concentrated tail to SQLite's synchronous WAL checkpoint inside existing `saveRequestUsage()` (`usageRepo.js:268`, native adapter commit at `nodeSqliteAdapter.js:75`). Two timing runs measured RELEASE stalls of 19.263ms and 18.795ms; syscall attribution measured a 22.761ms RELEASE containing 13.271ms WAL fsync and 3.214ms database fsync, followed by a 2.831ms WAL fsync. Both concurrent requests were delayed. Native database work averaged approximately 1.9–2.1ms additional per request. Added ledger writes reaching the shared checkpoint sooner is an inference, not a directly established causal change.

Measured-window exporter SDK CPU was 1.201ms; baseline/enabled GC was 11.110/12.945ms. Neither explains the localized tail. Profiled p95 differences varied from −15.687ms to +8.161ms and are attribution runs, not replacements for the uninstrumented 15.07ms acceptance miss. No checkpoints, durability acknowledgements, thresholds or assertions were weakened. A hard <10ms requirement needs lower-fsync-latency storage or separately designed database/checkpoint execution that preserves acknowledgements; no safe one-line fix was established. Private probes/profiles were removed.

## Actual browser verification

Used a separate actual Next loopback server at port 20282 with isolated synthetic state. Verified login, real `/dashboard/combos` editor, load-on-request policy details, saving versions 1/2, restoring version 1 with identical text/hash and enabled/required settings, and redacted preview/history. This caught and fixed an initially unmounted editor in the page-local modal; component tests alone did not catch it.

Verified `/dashboard/usage?tab=ledger` renders counts, independent monetary bases, fixed-fee sections and request inspection. A real synthetic generation returned `canary-ok`: 1 request, 1 attempt, 1 usage-known attempt and 1 cost-unknown attempt, correctly incomplete without a tariff. No Google Analytics script remained in the feature-enabled surface. Screenshots were observed locally, not committed with request state. Browser/server/provider were closed and temporary state removed; no live URL is advertised.

## Native monitoring runtime verification

With Docker unavailable, ran isolated native Grafana 12.0.2, Prometheus 3.4.2, the final standalone gateway and a local synthetic provider. Grafana health and Prometheus readiness returned 200; the real Prometheus datasource health was OK. All four repository dashboards reported `meta.provisioned=true`. Twelve successful client requests produced fifteen actual upstream dispatches; scraped counters matched 12 requests, 15 attempts, 180 output tokens and 12 observations for each first-content histogram.

All 46 PromQL targets were executed through Grafana `/api/ds/query`: HTTP 200 with no query errors. Finite/nonempty targets: infrastructure 8/15, routing 9/11, streaming 11/11, usage 7/9. Host/collector panels were empty because node-exporter/Alloy were not running; other empty targets lacked corresponding events. Loki datasource health and the log-panel query returned 400 because the Compose hostname `loki` was unavailable in this native run. These are not passing log-panel checks. Grafana also logged duplicate table-plugin registration and missing optional plugin/alerting provisioning directories; dashboard provisioning and PromQL still succeeded. All owned processes stopped and private state was removed; no live URL remains.

Separately ran pinned Loki 3.5.1 and Alloy 1.9.2 using the repository file-tail pipeline with temporary loopback/state-path overrides. Three actual authenticated successful gateway requests produced 12 file records and 12 ingested Loki records: three each of request start, attempt completion, client first content and request completion. All records had valid nonzero trace/span IDs; nine had request IDs, correlating three unique requests. Input/output sentinels, gateway/upstream API keys and admin credentials were absent from both file and Loki. Request/trace IDs were not index labels. OTel/Langfuse blocks were omitted in this isolated logging proof; it is not full Compose or Grafana log-panel proof. All owned processes stopped, private state was removed and ports were closed.

## Failures found and corrected

Earlier actual runs exposed policy origin comparison against Next's internal hostname; a fallback fixture that ignored inherited 503 retries; required Anthropic cache-marker rewriting; and dashboard middleware rejecting metrics before token authentication. Review found and fixed Codex Lite instruction loss, post-transform schema loss, catalog initialization bypass, untracked classifier inference, Gemini envelope parsing, binary response settlement, Cursor recovery attribution, estimated provenance, failed-write completeness and sql.js persistence acknowledgement. Original production observations were not rerun to reconfirm them.

## Deployment and remaining runtime gates

- Gateway: isolated synthetic canary exercised, then stopped; production not promoted.
- Metrics/logging: authenticated gateway metrics, synthetic collector outage and actual native Alloy-to-Loki metadata ingestion exercised. Monitoring Compose not deployed; Docker daemon inaccessible.
- Grafana: actual native 12.0.2 provisioning, Prometheus datasource health and all 46 PromQL queries exercised; Compose, host/collector panels and Loki log-panel runtime remain separate gates.
- Langfuse 4.0.0: configuration and gateway mapping supplied; backend not started. Full stack needs sustained capacity plus the supported full-retention decision. Community Edition raw-event S3 expiry is not complete trace-row deletion.
- Tempo: optional profile, not enabled or exercised.
- Cold backup/restore utility: bootstrap checks passed; Docker-volume restore rehearsal unavailable. Additive schema rollback instructions do not imply a successful rehearsal.
- No live-provider calls, metered spend, ARM runtime build, public hostname, remote deployment or client protocol census is claimed. Gemini/Muse browser transport accounting and hidden library retries remain explicitly incomplete rather than fabricated.

Final source review found no remaining high-confidence blocker in the reviewed boundaries; this is source review, not a security audit. Final standalone build and serial regressions passed. Unavailable checks and the measured overhead target miss remain explicit promotion gates, not passes.

GitHub push protection initially rejected four Google OAuth client constants inherited from the pinned public upstream import. The repository owner explicitly authorized four targeted `false_positive` bypasses; all four API requests succeeded. Push protection remains enabled. No user OAuth tokens, raw databases, private captures or generated artifacts are included. Gateway feature commit: `e84f534`; review: [draft PR #13](https://github.com/Kitkitkittt/tele-proxy/pull/13). Remaining deployment/evidence changes are a separate commit.
