# tele-proxy improvement and cross-machine handoff plan

Planning baseline: 2026-10-28; deployment status corrected 2026-10-30. Repository: `Kitkitkittt/tele-proxy`; development branch: `codex/1-tele-proxy`; review: [draft PR #13](https://github.com/Kitkitkittt/tele-proxy/pull/13). **Latest recorded native deployment: source `de03dfae83d393d5173f0462fe4dd22da66368e5`, release `a73c43a7-20261029T170132Z`**, made under an explicit owner authorization after the open gate was presented; see the [deploy record](TEST_REPORT.md#2026-10-29-deploy-of-the-security-fixes-a73c43a7). The performance gate remains open. Original cutover/browser observations remain dated evidence, not new checks. No Docker image deployment is implied.

## Status as of 2026-10-30

The code-bearing tickets are implemented and evidenced. What remains is runtime qualification on infrastructure this host cannot currently supply, plus documentation reconciliation, which is now done.

| Ticket | State | What actually remains |
|---|---|---|
| #2 | Inventory refreshed 2026-10-30 | The ledger records only `client_family`, not route or client version, so a protocol/version distribution cannot be produced from existing data. Sustained capacity needs a 24-hour measurement on an unpressured host. |
| #3 | Implemented; mounted editor exercised | Nothing open. Do not re-implement. |
| #4 | Implemented; 25-case canary | Only uncovered native-protocol transitions, per the per-ticket row below. |
| #5 | Implemented; durable ledger | Browser/Muse physical-send boundaries remain incomplete. |
| #6 | Implemented; bases separated | Reconcile newly covered transports only. |
| #7 | Implemented after the SSRF and logging fixes | No open redaction path identified in this pass. |
| #8 | Mapping proven synthetically only | **Blocked**: needs a running Langfuse stack and the Enterprise retention entitlement. |
| #9 | Artifacts pinned, validated offline | **Blocked** on host capacity: 32 GiB free, 93% used, against a ≥10 GiB reserve + 20% free rule. |
| #10 | Four dashboards and 15 rules exist | **Blocked** on the #9 stack for Loki/datasource proof; the missing-signal classification table is now written. |
| #11 | 4,622 offline tests; 25/25 cases ×10 | **Blocked**: the `<10 ms` gate is 4/10 with no attributed cause; needs correlation instrumentation, then qualified storage. |
| #12 | Docs complete; native deploy recorded | **Blocked** on #8/#9 for the backend-volume restore drill; the consolidated per-plane status block is now written. |
## Current objective and authority

Finish the acceptance criteria in [parent #1](https://github.com/Kitkitkittt/tele-proxy/issues/1) and children #2–#12 while preserving the live routing/client contract. The earlier **planning-only** request was historical. The current user explicitly authorizes further implementation, commit and redeployment. That does not authorize unrelated DNS/client changes, storage-service deployment, credential disclosure or metered inference. This documentation correction performs none of those operations and runs no runtime checks.

The separately authorized native cutover to **`tele-proxy.vnibb.xyz`** is complete. Older issue text retains `proxy.vnibb.xyz` and the original canary-only boundary; the dated deployment record supersedes those statements only for that completed operation. Remaining implementation uses isolated synthetic state and free private ports. Public-hostname compatibility was verified, not direct LAN-IP continuity: the listener changed from all interfaces to loopback. Do not silently widen it.

One gateway owns live credential refresh and mutable state at a time. Development machines share **source through git**, not a writable state directory or synchronized OAuth database. OmniRoute is already stopped; preserve its private recovery material rather than repeating retirement or migration.

## What is already evidenced, and what is not

[TEST_REPORT.md](TEST_REPORT.md) separates the original cutover from the later redeploy. The original cutover's frozen standalone passed 25 synthetic cases and preserved 303 connections, 9 provider nodes, 7 keys, 12 combos and 1,313,452 usage rows; private restored-state/authentication checks, a checksummed cold backup, legacy-binary read rehearsal, public TLS/API-key/browser checks and existing successful traffic were observed then. The later `da851bcf` redeploy recorded health/models reads and binary rollback, **not dashboard HTTP 200**. Its `pre-da851bcf-20261029T082208Z` backup was online `VACUUM INTO` with integrity/checksums; only SQLite/auth/JWT/machine copied, **not cold or full state**. Latest recorded service ownership remains tele-proxy on loopback 20128, with 9router/OmniRoute inactive; no ownership or public URL check was repeated by this correction. The original Cloudflare credential rotation and old-host compatibility remain historical evidence.

The original quiet canary missed additional p95 at **15.07 ms**; the first deployment rerun measured **5.12 ms** with 40 sequential samples per mode, and a prior noisy run measured **−15.06 ms**. The later alternating gate on `da851bcf` recorded **10 runs, five per concurrency**, with only **3 of 10** below `<10 ms`; all 25 synthetic behavior cases passed in each run. This is failed performance qualification, not stability or complete functional qualification. The prior full suite retained **35 failed assertions**, plus `db-benchmark` collection failure (missing `lowdb`) and `embeddings.cloud` collection failure (missing cloud file). Full Compose/backend-volume restore, real Langfuse ingestion/full retention, sustained growth and security audit also remain unqualified.

Historical candidate qualification is recorded in [TEST_REPORT.md](TEST_REPORT.md#2026-10-29-hot-path-and-offline-suite-candidate): 4,610 offline passes and all 25 ingress cases in ten runs, but only 4/10 performance runs below `<10 ms`. That suite missed an actual raw-key stats disclosure after its assertion was removed. Corrective source `b7932127` replaces public raw-key bucket names and adds behavioral 24h/7d serialization checks; corrective discovery passed 4,608 tests, zero failures, 52 skipped/pending and one todo. [Security correction evidence](TEST_REPORT.md#2026-10-29-raw-key-stats-disclosure-correction) includes actual standalone HTTP proof. Neither candidate is deployed; production remains `da851bcf`.

Current release decision: the user explicitly chose **hold redeployment until performance passes**, rather than a recorded exception. Preserve the ten-run repeatability gate and synchronous accounting durability. Further security corrections and stale-evidence reconciliation may be committed without promotion.

## Remaining-ticket implementation plan

Historical planning checkpoint: `2285369db2d9e7a640d68ebca86ca2aaefd8bb68`; its original `785eeb261d688bf5071f13c700e153b3f93497b2` runtime pin is superseded by the recorded `da851bcfb6ccad7ee80f2dd8d5e50badfea9686b` deployment. All twelve issues were open when fetched on 2026-10-29. Open does not mean unimplemented. Reuse those issues and [draft PR #13](https://github.com/Kitkitkittt/tele-proxy/pull/13); #1 remains the requirements map. No second backlog or repeated initial migration is required for the authorized redeploy.

### Execution waves

| Wave | Tickets | Dependency and exit |
|---|---|---|
| 1 — refresh baseline | **#2**, **#11** evidence matrix | Read-only inventory; map every parent criterion to existing evidence, missing implementation or unavailable runtime proof. Distinguish checkout, deployed artifact and historical checks. |
| 2A — finish gateway gaps | **#3–#7** | Mounted editor save/rollback-to-wire and inference-linked project diagnostics were implemented and exercised in the candidate record; do not build second paths. Remaining physical-send/transport preservation and explicit privacy gaps proceed independently of Docker/Langfuse. |
| 2B — monitoring and dashboards | **#9 monitoring**, **#10** | Host qualification follows #2. Missing signal/panel fixtures can run alongside 2A; actual dashboard/alert checks follow healthy isolated monitoring. Do not wait for Langfuse. |
| 3 — real Langfuse | **#9 llm-observability**, then **#8** | Requires native host capacity, isolated stores/secrets and supported full-retention decision. Tempo remains optional/off. This blocker does not block 2A or monitoring-only work. |
| 4 — final acceptance and recovery | **#11**, **#12** | Final candidate qualification follows relevant fixes; synthetic monitoring restore follows #9, Langfuse retrieval/restore follows #8. Prepare recovery earlier. Close #1 only after child acceptance and review/merge. |

### Per-ticket next slice and acceptance

| Ticket; evidence already present | Remaining work | Observable acceptance gate |
|---|---|---|
| [#2 — Inventory deployed lineage, security boundaries, protocols, and capacity](https://github.com/Kitkitkittt/tele-proxy/issues/2). Inventory is older than the deployment record. | Refresh `INVENTORY.md`: source/runtime/schema/driver pins, client versions/protocols, service/port owners, existing monitoring, sustained resource reservations and advisory scope. Reconcile loopback/LAN access and local NXDOMAIN versus public DNS/Chromium. Inspect accessible authorized hosts before requesting missing access. | Dated redacted facts, no security-audit/idle-host claim. Default stays loopback; any direct-LAN restoration needs an explicit interface/firewall/auth decision. No service restart or secret dump. |
| [#3 — Add immutable per-combo policy versions, authorized editor, preview and rollback](https://github.com/Kitkitkittt/tele-proxy/issues/3). Storage/API/editor exist; mounted v1/v2/save/rollback-to-wire was exercised in the candidate record. | Preserve that dated evidence; only reproduce/fix a newly established gap or changed editor path. Do not repeat implementation because the issue is open. | Candidate browser changes reached mock-wire payloads; broader immutable history/auth/stale-version/old-combo acceptance remains tied to its exact tested source and fixtures. No production policy seeding. |
| [#4 — Preserve native protocol instructions on every primary, retry and fallback attempt](https://github.com/Kitkitkittt/tele-proxy/issues/4). Native application, required-policy rejection and 25-case canary exist. | Map existing final-wire cases first; add only uncovered active protocol/tool transitions, ordered Gemini instructions, retry/fallback cache/schema/session/reasoning preservation and slow-consumer/first-content cases. | Exactly one snapshotted policy per actual send; client fields survive; required local failure makes zero sends; marker/token-saver spoofing cannot bypass it; no fallback after client content. Uses #3 snapshots/#5 dispatch boundary; unsupported required-policy paths reject explicitly. |
| [#5 — Persist unsampled logical-request and attempt ledger with idempotent recovery](https://github.com/Kitkitkittt/tele-proxy/issues/5). Durable IDs, settlement, recovery and adapters exist. | Finish one observable Gemini/Muse browser or hidden-retry physical-generation boundary at a time using local wire fixtures; exclude auth/upload/poll/download. Reconcile authenticated project/session mapping and failure completeness with #1. | One request and one durable attempt per real generation send; duplicate finalization/export adds nothing; missing visibility/process death remain incomplete/unknown. Adapter restart/durability holds. If mandatory budget reservations are configured, store failure must fail closed; do not invent a budget engine for this conditional requirement. |
| [#6 — Normalize usage and reconcile distinct tariff, subscription, reference and infrastructure bases](https://github.com/Kitkitkittt/tele-proxy/issues/6). Formulas, tariff snapshots, independent bases and coverage view exist. | Reconcile newly covered #5 transports with reported/estimated/missing terminal usage, inclusive cache/reasoning and cache writes. Recheck authenticated admin display per currency/basis and authentic tariff attribution. | Fixed fees once per period, not request; no subset double-count; missing usage/tariff remains null; reference value is not cash spend. Require actual operator evidence for deployment invoices/tariffs, never guessed prices. Depends on #5, not Langfuse. |
| [#7 — Instrument bounded metrics, metadata-only logs, privacy and asynchronous OpenTelemetry](https://github.com/Kitkitkittt/tele-proxy/issues/7). Exporter/metrics and inference-linked project diagnostics are implemented and exercised (`teleProxy.js`, `privacyDiagnostics.js`; candidate HTTP evidence). | Requalify changed legacy debug paths and collector outage; remove the newly identified preauthorization cookie logging in `src/proxy.js`. Preserve the existing approved-project attribution and bounded opt-in/expiry path; do not add a second capture authority. | Candidate inference proved project isolation/spoof resistance, opt-in/disable/expiry and prohibited-content rejection. New ingress logging changes need synthetic-cookie behavioral coverage. Metadata-only remains the ceiling; no arbitrary-content toggle or regex-safety claim. |
| [#8 — Validate pinned Langfuse generation mapping and explicit cost basis](https://github.com/Kitkitkittt/tele-proxy/issues/8). Synthetic OTLP mapping exists, not backend ingestion. | On qualified #9, send forced-fallback synthetic traffic through gateway → Alloy → pinned Langfuse 4.0.0; retrieve the trace with supported authenticated API/UI. Record the exact query/auth-path contract without secrets. | One nonbillable root/two generations, same trace ID, actual model, usage and policy metadata. Unknown differs from zero; reference-price inference is not cash spend; exporter retry does not inflate authoritative ledger totals. No duplicate direct export. Depends on capacity/retention, not merely web-container health. |
| [#9 — Provision bounded private monitoring, Langfuse and optional Tempo Compose profiles](https://github.com/Kitkitkittt/tele-proxy/issues/9). Digest-pinned profiles/validators and native proofs exist. | Qualify monitoring-only on an authorized native Docker host: daemon/Compose access, architecture, private binds, UID/volumes/secrets, health/restart/persistence and outage recovery. Measure idle baseline and representative 24-hour growth/bytes per request. Qualify Langfuse separately after retention/capacity. | Native images/pinned validators and authenticated scrape/log/collector paths work; measured headroom/OS rollback reserve and bounded drops recover. Verify 14-day metrics, 7-day logs and existing 90-day ledger scheduler under controlled time; caps are not volume quotas/retention proof. No silent emulation/GPU/socket mounts/shared production state. |
| [#10 — Provision four operational dashboards and visible alerts as code](https://github.com/Kitkitkittt/tele-proxy/issues/10). Four dashboards, 15 rules and partial native queries exist. | Map each missing required signal to a real bounded source: combo/project token views, exact 5xx/empty streams, provider availability, throughput/overhead, quota age, configured budget, host/disk and restarts. Project views may use authenticated ledger queries, not arbitrary metric labels. | All four dashboards and real Prometheus/Loki queries work on #9; synthetic low-volume conditions exercise visible alerts. Attempt success is not availability; chunks are not tokens; missing is not zero. Required absent signals remain open. Notifications need an existing authorized receiver, never invented webhooks. |
| [#11 — Exercise isolated canary acceptance matrix, overhead, recovery and privacy](https://github.com/Kitkitkittt/tele-proxy/issues/11). Historical synthetic cases pass; the two latest alternating overhead gates failed 7/10 and 6/10 runs; the final artifact passed only 4/10. | Maintain criterion-to-evidence matrix; qualify final artifact after #3–#7 fixes, including mounted UI, backpressure, actual sends, monetary bases and retained/exported privacy surfaces. Reuse the existing mock-only alternating off/on benchmark control. | Repeatability gate: five matched off/on runs per concurrency 1 and 2, 10 total, order reversed each run, 40 samples/mode/run; identical workload/hardware and per-request provider subtraction. Record every result; each additional gateway p95 must be `<10 ms`, otherwise gate remains failed. Keep +15.07/−15.06/+5.12 ms and failed alternating history. Preserve durable acknowledgements/checkpoint safety in any fsync fix. Backend checks depend on #9/#10/#8. |
| [#12 — Document proxy.vnibb.xyz promotion, restore and rollback without public cutover](https://github.com/Kitkitkittt/tele-proxy/issues/12). Docs, native state/auth/public acceptance, backup and old-binary read rehearsal exist. | Reconcile historical hostname/authority with completed cutover; do not repeat it. Rehearse checksummed synthetic backend-volume restore to a different Compose project/network/ports, reconciling ledger totals/unknowns/currencies and enabled Grafana/Langfuse retrieval. | Exact source/image/schema/secret-set references, restore duration/recoverable age/loss window and rollback scope. Native SQLite rehearsal does not prove backend restore. Monitoring drill follows #9; Langfuse drill follows #8. No production OAuth copies, active-volume overwrite or unrelated cleanup; future approved rollback preserves newest tokens. |

### Implementation checks

These are **proposed commands, not executed by this documentation correction**. Use a credential-free environment, synthetic isolated `HOME`/absolute `DATA_DIR` and free private ports as in [README](../../README.md#safe-local-development); never use active state or ports 20128/20129 for qualification. No root typecheck script exists: JavaScript changes use applicable syntax/lint checks and native build, not an invented TypeScript gate.

From `tests/`, run the single relevant file while implementing, then the related group:

```sh
# #3
./node_modules/.bin/vitest run unit/combo-policy-storage.test.js unit/combo-policy-api.test.js unit/combo-policy-editor.test.js --maxWorkers=1
# #4
./node_modules/.bin/vitest run unit/combo-policy-native.test.js unit/tele-proxy-integration.test.js unit/policy-eligibility.test.js unit/dispatch-physical-retries.test.js unit/native-browser-dispatch.test.js --maxWorkers=1
# #5/#6
./node_modules/.bin/vitest run unit/request-ledger.test.js unit/request-ledger-durability.test.js unit/audio-embedding-ledger.integration.test.js --maxWorkers=1
# #7
./node_modules/.bin/vitest run unit/gateway-telemetry.test.js unit/dashboard-guard.test.js unit/dispatch-context.test.js --maxWorkers=1
```

For uncertain behavior, keep a deterministic failing-before/passing-after regression at the consumer-visible seam. Do not duplicate existing cases or replace mounted UI/physical-wire proof with helper/mock-echo tests. Diagnostic fixtures must drive actual attributed inference and prohibited-content exclusion.

At integration, inspect test discovery before running the full safe local suite once: one worker, fresh state, no provider credentials, enforced external-network denial, and real-provider suites explicitly excluded/reported. Current config discovers `**/*.test.js` but excludes `.real.test.js`/`.live.test.js` unless `RUN_REAL=1`; other credential/local-proxy cases retain explicit opt-ins. Record exact selection and unavailable coverage; exclusions/skips are not passes. Run tests/build/benchmark serially, build feature-off and exercise the exact artifact feature-on. Do not replace the deployed release during qualification.

Root canary after isolated native build: `node scripts/tele-proxy-canary.mjs --runtime=production --samples=40 --concurrency=2`. Default `--benchmark-order=off-on` preserves baseline first; `--benchmark-order=on-off` measures the enabled run first. Both timed modes use fresh separate state and startup, seeded for their respective mode immediately before six warmups and identical indexed samples, and precede the separate acceptance/outage/restart exercises. Alternate these orders for five matched off/on runs at each concurrency 1 and 2 using the [record-every-run procedure](ROLLOUT_ROLLBACK.md#alternating-matched-benchmark): **10 runs total, five per concurrency**, each containing both modes. The result records `benchmark.order`; per-request provider subtraction is unchanged. The recorded `da851bcf` gate failed 7 of 10 runs; retain every result and keep performance qualification open until every run meets `<10 ms`.

On the qualified isolated host, from `ops/observability`: `python3 selfcheck.py`, then `python3 validate.py` (0: exercised checks pass; 1: failed; 2: unavailable). Follow [pinned runtime/validator commands](ROLLOUT_ROLLBACK.md#2-validate-on-a-docker-capable-host), [Langfuse contract](../../ops/observability/langfuse/README.md) and [synthetic backup/restore](ROLLOUT_ROLLBACK.md#6-consistent-backup-and-isolated-restore-rehearsal). Do not bootstrap over secrets or stop production to test a runbook.

### Decisions and conservative defaults

- **Host:** inspect accessible authorized hosts first; none is selected here. Historical Docker denial and point-in-time capacity are neither current impossibility nor sustained-headroom proof. Preserve existing VniBB/Jenkins and OS/rollback reservations; reuse compatible monitoring instead of adding a second stack.
- **Langfuse:** pinned CE raw-event expiry does not enforce full trace-row retention. Obtain supported full 7-day retention/entitlement before acceptance. An explicitly authorized CE experiment remains retention-noncompliant; no SQL-deletion workaround or silent requirement reduction.
- **Diagnostics:** existing inference-linked approved-project metadata capture and opt-in/expiry are implemented. Preserve metadata-only defaults and its single settings authority; remaining privacy/debug-path checks are not a request for arbitrary-content capture.
- **LAN/DNS:** keep loopback/public-host clients; inventory former direct-LAN users before proposing interface/firewall changes. Investigate resolver discrepancy read-only; do not rewrite DNS that public resolvers/Chromium already reach.
- **Operator inputs:** tariff/invoice/budget/quota evidence, backup custody, existing notification receiver and any later paid smoke need authentic inputs. Continue reachable mock-only work without them; never invent prices, receivers, spend limits or permission.

## Candidate release gate sequence

1. Refresh inventory/evidence matrix; assign one accountable owner per runnable slice in existing issues/PR. Reuse current integration branch; extra worktrees only for independent implementation, never shared live state.
2. Finish gateway gaps with seam-level regressions; qualify monitoring independently after host inspection. Keep qualification isolated; the current implementation/redeploy authorization does not imply DNS/client or listener changes.
3. Freeze candidate source/runtime/lockfiles/schema and artifact identity. Run selected regression/full safe suite, native build, mock-wire/privacy/browser smoke and controlled overhead serially.
4. Run monitoring and, when unblocked, real Langfuse ingestion/retention. Restore synthetic backend volumes separately; reconcile all cost bases/unknowns and retrieval with recovery timing.
5. Review standards and #1/spec coverage separately, scan publication for secrets, commit/push reviewed source/evidence, update owning issues/PR. Failed/unavailable criteria remain open; serving traffic does not close all tickets.
6. Report gateway, monitoring, Langfuse, recovery and performance independently. The current user authorizes redeployment; execute it as a deliberate operational step with current-token rollback and recorded outcomes. Listener/DNS/client changes remain outside that scope.

### Definition of a release record

Keep a redacted record with full source commit/image digest, native runtime/architecture, schema/driver versions, active flags/profiles, chosen state path identifier, service manager identity, new-hostname origin, previous route/config identity, performed commands/exit status, benchmark workload/results and precise unavailable gates. Identify the backup and secret set by private reference, not contents. Record the verified reachable URLs only. Historical reports remain historical rather than being overwritten as if their artifact were current.

## Cross-machine development handoff

### Share code, not a running installation

On the destination workstation:

```sh
git clone --branch codex/1-tele-proxy --single-branch https://github.com/Kitkitkittt/tele-proxy.git
cd tele-proxy
nvm install
nvm use
npm ci
npm --prefix tests ci
# Inspect the source identity before beginning work:
git rev-parse HEAD
git status --short
```

`.nvmrc` currently pins `22.23.4`. Use a clean shell and fresh absolute `DATA_DIR`/temporary `HOME` as in [README](../../README.md#safe-local-development). Build natively on the destination architecture; do not copy `.next`, `node_modules`, SQLite native modules or a development HOME between x64/ARM machines. A running service on another machine is not a reason to point this clone at its live directory.

Before changing machines, the source owner provides a **secret-free handoff note**: full source commit, branch, issue ownership, intended changes, dirty/uncommitted file list, exact last exercised checks and results, blockers, and relevant operational-document links. Commit/push only reviewed source/docs to the authorized branch, or transfer a reviewed source-only patch if not yet committed. Do not use a blanket repository archive that can include ignored `.env`, `.next`, logs, state, captures or credentials. Do not force-push/reset another workstation's work. The receiver checks the full commit and worktree before continuing and installs from lockfiles.

Multiple machines may develop simultaneously against independent synthetic state. Each development process owns its own `DATA_DIR`, HOME, ports and fixture credentials. Never synchronize SQLite through a network drive, rsync loop, cloud file sync or a writable shared volume. Do not run copied OAuth accounts on two hosts even when their DB paths differ.

### Private state and recovery are not development setup

The live-owner handoff is already complete. Do not repeat its shutdown/copy/start sequence to work on remaining tickets. Cross-machine development transfers source only and uses fresh synthetic state; public git must never carry databases, tokens, captures or credential-bearing archives.

For a separately authorized future production move or rollback, use the [native current-state procedure](ROLLOUT_ROLLBACK.md#8-native-systemd-deployment-2026-10-29). Drain and stop the sole owner before a final consistent snapshot; verify checksums, matching binary/schema/secret set and current credential state. Preserve newest refreshed OAuth tokens instead of restoring an old snapshot blindly. Never share mutable state or run copied credentials on two hosts. Restore only affected routes and preserve unrelated storage/network configuration.

The #12 synthetic backend-volume drill is independent: different project, network, ports and volumes, no production OAuth and no production service shutdown. Record counts, unknown coverage, cost bases, retrieval, recovery time and recoverable age; native SQLite proof is not full backend restore proof.

## Deliberately deferred

- No gateway rewrite, second proxy tier, Kubernetes, multi-tenant billing framework, global compression policy or automatic quality router.
- No agent tool-execution tracing or task-quality claim until agent-side evidence is explicitly implemented and exercised.
- Tempo stays optional/off until distributed trace storage is needed. Langfuse stays off until its capacity and supported retention decision is made; monitoring can be accepted independently.
- No claim that absent usage means zero cost, that reference value is savings, or that successful startup satisfies performance/recovery/security acceptance.

The original planning/README replacement and this evidence correction are documentation-only. Later explicitly authorized operations and native deployments are recorded in their dated verification sections; the current user authorizes further implementation, commit and redeployment. Private state, token files, logs and snapshots stay outside git. Cross-machine source handoff remains the procedure above; never synchronize the running state.
