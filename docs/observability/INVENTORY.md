# Inventory

Bounded read-only host snapshot, refreshed **2026-10-30 UTC**. Checkout, deployed release and resource observations are current as of this session; they are **not** a security audit, capacity qualification or release acceptance, and production traffic changes them immediately.

**Recorded deployment.** At the earlier refresh, checkout and deployed source were `73fa569ae81f5eb3962975bcfb94ce8b26fcd9da` on `codex/1-tele-proxy`. The checkout has since advanced and is under active development; it is not the deployed artifact. Upstream `upstream/master` was pinned at `3a978a631ad65529c06e48ce495092d5bba29f46` (9Router `0.5.111`). Deployed release `73fa569a-20261029T190233Z` has 3,598 files, manifest `7c8d7a6e18893d66…`; see the [deploy record](TEST_REPORT.md#2026-10-30-review-fix-and-redeploy-73fa569a). No Docker gateway image applies — this is a native systemd deployment.

## 2026-10-30 refresh

At 03:50 UTC, the existing `tele-proxy.service` was active with `NRestarts=0`, and loopback `/api/health` returned HTTP 200. Root had approximately 23 GiB available and was 96% used; load averages were 18.70, 21.20 and 17.90. These are point-in-time observations, not sustained-capacity or inference proof. No monitoring storage was deployed.

Collected with `git rev-parse/status`, `systemctl show/is-active/list-units`, `readlink`, `ss`, `df`, `free`, `getent`, `dig`, `node/npm --version`, client `--version`, `sudo -n docker info`, and a **read-only** SQLite connection. No environment, unit contents, credential files, request payloads or row data were printed.

| Item | Observation | Boundary |
|---|---|---|
| Gateway service | `tele-proxy.service` active/running, `NRestarts=0`, memory 482,385,920 bytes, cumulative CPU 110,238,717,000 ns. | Snapshot, not peak or sustained load. |
| Deployment | `current` → `releases/73fa569a-20261029T190233Z`; metadata agrees with the recorded source and manifest. | Identity read from the symlink and deployment metadata; the artifact was **not** rehashed this session. |
| State DB | `db/data.sqlite` mode `0600`, 688,123,904 bytes; state dir 676 MiB. `quick_check=ok`. Read-only counts: 303 connections, 9 nodes, 7 keys, 12 combos, 1,357,997 usage rows. | Counts drift with live traffic. Integrity checked; restorability of any backup was not. |
| Listeners | Only `127.0.0.1:20128` among gateway/monitoring candidate ports. 20129, 20280/20281, 3000, 3100, 4317/4318, 9090, 12345 unbound. | Port state is transient. Loopback remains deliberate; direct-LAN reach is not restored. |
| Ingress | `cloudflared.service` active, `NRestarts=0`. Public and local resolution agree (2 A records each). | DNS agreement does not establish HTTPS, auth, browser UI or origin health; no probe run here. |
| Monitoring services | Zero matching running system units for prometheus/grafana/loki/alloy/langfuse/tempo. | Bounded local coverage only; says nothing about Docker, other hosts or differently-named units. |
| Docker | `sudo -n docker info` → server `29.1.3`, `x86_64`. No containers started. | Access exists; image/volume/Compose health and restore remain unqualified. |
| Host | 25,072,115,712 B RAM (16,934,301,696 available), 4,607,057,920 B swap used. Root ext4/NVMe 468 G total, 32 G available, **93% used**. | Disk pressure remains material; no new telemetry store is qualified on this host. Not a 24-hour growth measurement. |
| Toolchain | Node `v24.20.0`, npm `11.19.0`; `.nvmrc` pins a different dev runtime (`22.23.4`) — do not confuse with the running Node. | — |
| Clients | `pi 0.86.1`, `omp/18.13.3`, `codex-cli 0.159.2`, `opencode 1.18.35`, `claude 2.1.259`. | Versions do not establish which protocol each client currently sends. |
| Legacy routers | `9router.service` and `omniroute.service` inactive. | Retirement already done; private recovery material is preserved, not re-verified. |

Superseded statements earlier in this file: the `da851bcf`/`785eeb` deployment pins and the "hold redeployment" posture. The performance gate is still open — see the [verification report](TEST_REPORT.md) — but the deployed release is now `73fa569a`.

## Historical inventory snapshot

## Current checkout versus deployed artifact

The table preserves the **03:54 UTC snapshot**. Its old checkout/release pins and read-only authority apply to that inspection only. The current user explicitly authorizes further implementation, commit and redeployment; no additional runtime outcome is asserted here.

| Item | Observed fact / evidence boundary |
|---|---|
| Checkout | `/home/vphk2001/tele-proxy`, branch `codex/1-tele-proxy`, HEAD `0983387103ecceadeb1b96d3fe038d837a1d243c` (`docs: plan remaining tele-proxy acceptance work`). Origin <https://github.com/Kitkitkittt/tele-proxy>; upstream <https://github.com/decolua/9router>. |
| Upstream lineage | Local `upstream/master` remains pinned to `3a978a631ad65529c06e48ce495092d5bba29f46`, 9Router `0.5.111`. No fetch/rebase/upgrade performed during this refresh. |
| Dirty state | Shared implementation in progress, not a frozen release. At 03:54 UTC: modified `docs/observability/{ACCOUNTING,PRIVACY}.md`, `open-sse/executors/chatgpt-web/{chatHttp,imageGenHttp}.js`, `ops/observability/grafana/dashboards/infrastructure-telemetry.json`, `ops/observability/langfuse/compose.yaml`, `ops/observability/runbooks.md`, `src/lib/{gatewayTelemetry,privacyDiagnostics,teleProxy}.js`. This list predates this inventory/evidence edit and other concurrent work; none was reset/discarded. |
| Toolchain | Linux `7.0.0-38-generic`, x86_64; Node `v24.20.0`, npm `11.19.0`. Root `package-lock.json` is tracked; `tests/package-lock.json` is not tracked. `.nvmrc` pins a different development runtime (`22.23.4`, documented in the roadmap); do not confuse it with the running Node. |
| Installed clients | `pi --version`: `0.86.1`; `omp --version`: `18.13.3`; `codex --version`: `0.159.2`; `opencode --version`: `1.18.35`; `claude --version`: `2.1.259`. Versions alone do not establish which client/protocol is active. No client configuration or payloads were read. |
| Running gateway at 03:54 UTC | `tele-proxy.service` active/running/enabled, `NRestarts=0`. Its process executable resolved to `/usr/local/bin/node`; working directory and `current` symlink resolved to private release `~/.local/share/tele-proxy/releases/785eeb261d68-20261028T111741Z`. Superseded by the later recorded `da851bcf-20261029T082307Z` release. |
| Deployed source/artifact at 03:54 UTC | The original deployment record pins source `785eeb261d688bf5071f13c700e153b3f93497b2`, inherited version `0.5.111`, native `node:sqlite`, and standalone hash-map SHA-256 `3ed44a49459f71924b3ccb779d55cc19e93b2d89f3fc5eb33e138f64ca57c080`. That refresh observed the matching release path, **did not rehash the artifact or query its live schema/driver**. The later redeploy identity is recorded above; no Docker gateway image/digest applies to either native deployment. |
| Previous binary | Global npm metadata reports installed `9router@0.5.112`, not `0.5.111`. Installed package, upstream source and active frozen tele-proxy are separate identities. `9router.service` and `omniroute.service` are inactive/dead/disabled, PID zero. |

Commands were limited to `git rev-parse/branch/status/show/remote/ls-files`, version queries, `systemctl show`, `ss`, `readlink`, `stat`, `du`, `lscpu`, `free`, `df`, `getent`, `dig`, and public GitHub advisory metadata. No process arguments, environment, unit contents, SSH keys, credential files, database rows or request captures were printed. Existing test/build commands and historical outcomes are in [TEST_REPORT.md](TEST_REPORT.md); no test, build, validator or inference was run for this documentation slice.

## Current topology and bounded capacity

| Item | Observation | Gap / implication |
|---|---|---|
| Gateway ownership | Only `127.0.0.1:20128` listens among gateway/monitoring candidate ports; 20129, 20280/20281, 3000, 3100, 4317/4318, 9090 and 12345 had no listener at inspection. | Port availability is transient. Loopback is deliberate; former direct-LAN connectivity is not preserved by a public-hostname compatibility check. No interface/firewall change authorized here. |
| Ingress | `cloudflared.service` active/running, `NRestarts=0`, memory 28,631,040 bytes. | Prior verified public TLS/auth and metrics blocking remain dated deployment evidence, not re-exercised here. Tunnel credentials/configuration were not read. |
| Resolver | Local `getent ahostsv4 tele-proxy.vnibb.xyz` now succeeds; public `dig @1.1.1.1` returns the same two A records. Addresses omitted. | The earlier local NXDOMAIN is historical and was not reproduced now. DNS agreement does not establish HTTPS, authentication, browser UI or origin health. No resolver flush/configuration change performed. |
| Gateway state | Dedicated `~/.local/share/tele-proxy/state` mode `0700`; `db/data.sqlite` mode `0600`, 636,780,544 bytes; whole state directory approximately 615 MiB by `du`. | Metadata only; SQLite was not opened. Counts/schema/integrity/retention execution and recoverable backup age are not freshly established. Production traffic can change size immediately. |
| Gateway resource snapshot | Service memory 697,896,960 bytes; cumulative CPU 431,815,054,000 ns. Intel Core i5-6300HQ @2.30 GHz, 4 cores/4 logical CPUs. | These are not peak usage, CPU rate, load-test or idle-host measurements. |
| Host memory/storage snapshot | RAM 25,072,115,712 bytes total, 14,086,529,024 available; swap 6,583,803,904 used. Root filesystem 501,809,635,328 bytes total, 45,352,763,392 available, 91% used. | No sustained RAM/CPU/disk reserve or 24-hour bytes/request growth measured. Disk pressure remains material; no new telemetry stores qualified on this host. |
| Monitoring services | Conventional `prometheus`, `grafana-server`, `loki`, `alloy`, `langfuse`, `tempo` system units are not found. Exact-name process queries found no Prometheus/Grafana/Loki/Alloy/Tempo process. | This is bounded local coverage, not proof of absence in Docker, custom units, other hosts or processes with different names. Historical native proof processes were stopped. |
| Docker | Unprivileged client `29.1.3` exists; user config and daemon socket access denied. Integration owner subsequently observed `sudo -n docker info` succeed, reporting Docker `29.1.3`, `x86_64`. No containers started. | Docker is accessible through the observed noninteractive sudo route; unprivileged denial is not a host-access blocker. Container/image/volume health, full Compose runtime/restore and sustained capacity remain unqualified. No group/permission change is implied. |
| Other authorized hosts | SSH capability reports no configured hosts; `~/.ssh/config` is absent. | Application/CI ARM hosts and existing shared monitoring/reservations remain unverified; no host identity/access route is supplied by this repository. Do not presume VniBB/Jenkins or GPU hosts idle, allocate their capacity, or invent remote host facts. |

## Fork-specific implementation map

These are **checkout source references**, not proof the dirty checkout is deployed. Dynamic provider transports still need final-wire evidence; implemented protocols do not establish actual client traffic distribution.

| Boundary | Source evidence |
|---|---|
| Rewrites and protocol ingress | `next.config.mjs:65-102`; `src/app/api/v1/{chat/completions,responses,messages}/route.js`; Gemini `src/app/api/v1beta/models/[...path]/route.js:40-112`. Image/audio/embedding/video/search/fetch routes are separate families under `src/app/api/v1/`. |
| Authenticated dispatch | `src/sse/handlers/chat.js:38-105,149-170,245-266,289-328`; format/executor selection `open-sse/handlers/chatCore.js:178-221,342-360`. |
| Combo/history/editor | `src/lib/db/repos/combosRepo.js:17-71`; `src/app/api/combos/**`; authenticated policy history/write route `src/app/api/combos/[id]/policy/route.js:10-45`; immutable save/rollback `src/lib/comboPolicy.js:87-139`; mounted editor `src/app/(dashboard)/dashboard/combos/page.js:1349-1350`. |
| Snapshotted additive policy | `src/lib/teleProxy.js` ingress snapshot/application; post-compression application `open-sse/handlers/chatCore.js:317-340`; native fields `open-sse/services/comboPolicy.js:86-145`; required eligibility `open-sse/services/policyEligibility.js:67-95`. Default injection cap is 600 **estimated** tokens, configurable rather than an unconditional hard-coded maximum. |
| Prices and accounting | `src/lib/requestLedger.js` usage normalization, immutable tariff snapshots, integer micro-units, fixed fees and recovery; inherited editable reference prices remain separate in `src/lib/db/repos/pricingRepo.js` and `src/app/api/pricing/route.js`. A combo alias is not an actual tariff identity. |
| Finalization | `src/lib/teleProxy.js` upstream observer and downstream completion/cancellation; `src/lib/requestLedger.js:149-214`; inherited `open-sse/handlers/chatCore/{streamingHandler,nonStreamingHandler,sseToJsonHandler}.js` and `open-sse/utils/stream.js`. Legacy estimated/default usage is not ledger-reported usage. |
| Retry/fallback/cancel | `open-sse/executors/base.js:102-181`; `open-sse/services/dispatchContext.js:34-86`; proxy TLS/direct retry `open-sse/utils/proxyFetch.js:255-271,363-391`; account fallback `src/sse/handlers/chat.js:373-390`; combo stream peek `open-sse/services/combo.js:475-623`. Chat signals combine at `open-sse/handlers/chatCore.js:353-360`; native Gemini adapter cancellation needs its own wire proof, not inference from chat coverage. |
| Auth and privacy | `src/lib/auth/dashboardSession.js:33-72`; `src/sse/services/keyAccess.js:48-73,123-155`; socket/proxy trust `custom-server.js`, `src/dashboardGuard.js`; legacy request-detail suppression `src/lib/db/repos/requestDetailsRepo.js:143-146`; bounded project diagnostics `src/lib/privacyDiagnostics.js`. No arbitrary-content redaction safety claim follows from metadata capture. |
| Data/adapter boundary | `src/lib/dataDir.js:14-21` requires isolated absolute feature-mode state; `src/lib/db/paths.js:5-12`; adapter selection `src/lib/db/driver.js:88-95`. Production schema and adapter were not introspected during this read-only refresh. |

## Refreshed advisory scope

`gh api repos/decolua/9router/security-advisories --paginate` returned **19 published advisories** on 2026-10-29. The eight historical entries below remain relevant review boundaries. Additional published entries omitted from that older shortlist:

| Advisory | Boundary | Published affected / patched metadata |
|---|---|---|
| [GHSA-32gc-64m7-hj7v](https://github.com/decolua/9router/security/advisories/GHSA-32gc-64m7-hj7v) | Spoofed internal-IP login lockout bypass | `0.5.4` / malformed `5.6` |
| [GHSA-8g4w-4ffg-8vgx](https://github.com/decolua/9router/security/advisories/GHSA-8g4w-4ffg-8vgx) | Authenticated OIDC test SSRF | `<=0.5.4` / malformed `5.6` |
| [GHSA-6mwv-4mrm-5p3m](https://github.com/decolua/9router/security/advisories/GHSA-6mwv-4mrm-5p3m) | Kiro region SSRF/auth forwarding | `<=0.5.2` / `0.5.6` |
| [GHSA-86m2-fcxq-5q7c](https://github.com/decolua/9router/security/advisories/GHSA-86m2-fcxq-5q7c) | Host-header relay/SSRF | `<=0.4.80` / `0.4.82` |
| [GHSA-8gmq-j984-vp4r](https://github.com/decolua/9router/security/advisories/GHSA-8gmq-j984-vp4r) | `/codex` rewrite authorization bypass | `<=0.4.80` / `0.4.82` |
| [GHSA-qj3v-64wj-q825](https://github.com/decolua/9router/security/advisories/GHSA-qj3v-64wj-q825) | Web-fetch SSRF | `<=0.4.71` / `0.4.72` |
| [GHSA-7cfm-pqrj-xgq7](https://github.com/decolua/9router/security/advisories/GHSA-7cfm-pqrj-xgq7) | Forwarded-IP login lockout bypass | `<=0.4.71` / `>=0.4.77` |
| [GHSA-4922-8r65-fq26](https://github.com/decolua/9router/security/advisories/GHSA-4922-8r65-fq26) | Host/MCP argument RCE | `0.4.59` / `0.4.60` |
| [GHSA-6g2f-w7g3-77vf](https://github.com/decolua/9router/security/advisories/GHSA-6g2f-w7g3-77vf) | Incomplete local-only Host fix | `<=0.4.55` / empty |
| [GHSA-g6g7-pvmx-m74p](https://github.com/decolua/9router/security/advisories/GHSA-g6g7-pvmx-m74p) | Missing auth/OS command injection | `<=0.4.39` / `0.4.44` |
| [GHSA-fhh6-4qxv-rpqj](https://github.com/decolua/9router/security/advisories/GHSA-fhh6-4qxv-rpqj) | Unprotected MCP plugin RCE | `>=0.4.30,<0.4.37` / `0.4.37` |

The pinned `0.5.111` lies beyond the explicitly stated older affected versions; malformed/empty patch metadata is not silently repaired and does not prove safety. No dependency audit, exploit replay or full source/security audit was run. Historical authentication regression results remain evidence only for their exercised boundaries.

## Source schema and price pins

Source schema pins are distinct: `src/lib/db/schema.js:1-6` declares central `SCHEMA_VERSION=2`; additive ledger migration `src/lib/db/migrations/2026102702-request-ledger.js:1-7` is `2026102702`; `src/lib/requestLedger.js:46-61` separately stamps `teleProxyLedgerSchemaVersion='1'`. None is a freshly observed production DB value. Legacy default rates (`open-sse/providers/pricing.js`, `MODEL_PRICING`/`PROVIDER_PRICING`) merge with `kv(scope='pricing')` overrides; evidence-backed immutable `teleProxyTariffs` are separate. Shipped reference prices are not actual contract spend.

## Unverified inventory fields

Actual enabled combo aliases/reasoning-suffix distribution, active client protocol/version distribution, authenticated project/session configuration, production tariff/budget/quota evidence and current backup age were not queried because this slice excludes production state and request inspection. Dated deployment evidence established **12 combos**, not their present names/configuration. Do not substitute the parent issue's example aliases (`quality`, `balanced`, `fast`, `cheap`, `free`, `vision`) for an observed current list. Remote ARM host identities/access, existing shared monitoring and sustained service reservations are not available through configured SSH capabilities. Unprivileged Docker visibility is denied, but the integration owner's `sudo -n docker info` succeeded; container/runtime qualification is still unperformed. These gaps are explicit inputs for authorized inventory/qualification, not claims that those resources or configurations do not exist.

## Historical implementation baseline — 2026-10-27–28

## Lineage and tooling

- New isolated checkout: `tele-proxy`, branch `codex/1-tele-proxy`, public origin <https://github.com/Kitkitkittt/tele-proxy>.
- Imported upstream: <https://github.com/decolua/9router/commit/3a978a631ad65529c06e48ce495092d5bba29f46>, version `0.5.111`, dated 2026-10-26. Upstream MIT license retained. No production rebase/upgrade performed.
- Installed global CLI independently reports `0.5.111`; compiled installed routes are not the editable checkout. Earlier `0.5.104` migration notes are stale.
- New origin started clean from its initialization commit. Imported public upstream and feature work are isolated from other local repositories. No unrelated user files reset or discarded.
- Runtime observed: Node `v24.20.0`, npm `11.19.0`, Linux x64. Upstream had no root lockfile; npm install with lifecycle scripts disabled generated `package-lock.json` for reproducibility.
- Root scripts: `npm run build` (Next webpack), `npm run start`; upstream dev/start scripts default to port 20127, not the documented 20128. Tests are independent `tests/` Vitest package. Use `cd tests && npx vitest run`; live-provider suites require separate authorization and are excluded from canary checks. Upstream instructions report known baseline failures; this is not an observed test result.

On 2026-10-28, fetching `upstream/master` confirmed that it still points at the imported 9Router commit above; no upstream merge was performed. OmniRoute's [repository](https://github.com/cheaper-inference/OmniRoute) is the canonical redirect of the previously referenced `diegosouzapw/OmniRoute`. Its fetched `release/v3.8.53` branch was at [8a8c64ee33b83803df74628a83f8372f7a1432c7](https://github.com/cheaper-inference/OmniRoute/commit/8a8c64ee33b83803df74628a83f8372f7a1432c7); the latest published release reported by GitHub was [v3.8.52](https://github.com/cheaper-inference/OmniRoute/releases/tag/v3.8.52). Branch head is not a release or deployment claim. The separately installed standby was pinned to npm 3.8.51; no installation, state, credentials or routing were changed. OmniRoute remains a comparison source, not an approved migration or replacement.

Monitoring source versions are pinned separately from the gateway: [Langfuse 4.0.0](https://github.com/langfuse/langfuse/tree/v4.0.0), [Prometheus 3.4.2](https://github.com/prometheus/prometheus/tree/v3.4.2), [Grafana 12.0.2](https://github.com/grafana/grafana/tree/v12.0.2), [Loki 3.5.1](https://github.com/grafana/loki/tree/v3.5.1), [Alloy 1.9.2](https://github.com/grafana/alloy/tree/v1.9.2), and optional [Tempo 2.8.1](https://github.com/grafana/tempo/tree/v2.8.1). Image digests and supporting store pins are authoritative in `ops/observability/compose.yaml` and `ops/observability/langfuse/compose.yaml`; fetching source metadata does not establish runtime compatibility or provenance.

At the fetched OmniRoute commit, [combo overrides](https://github.com/cheaper-inference/OmniRoute/blob/8a8c64ee33b83803df74628a83f8372f7a1432c7/open-sse/services/comboAgentMiddleware.ts#L118-L221) remove caller system messages or replace Responses instructions. They are not interchangeable with this fork's additive policy. Its [routing OTLP mapper](https://github.com/cheaper-inference/OmniRoute/blob/8a8c64ee33b83803df74628a83f8372f7a1432c7/open-sse/services/routing/otel.ts#L193-L234) maps missing token usage to zero, so its events are not a replacement for the ledger's unknown-versus-zero accounting. Its [log export](https://github.com/cheaper-inference/OmniRoute/blob/8a8c64ee33b83803df74628a83f8372f7a1432c7/docs/frameworks/LOG-EXPORT.md) is resumable and at-least-once; its [summary projection](https://github.com/cheaper-inference/OmniRoute/blob/8a8c64ee33b83803df74628a83f8372f7a1432c7/src/lib/usage/callLogExportQueries.ts#L76-L131) includes account and session metadata. No export or plugin is adopted: preserving client instructions, metadata-only privacy and authoritative durable accounting takes precedence. This is source comparison, not a runtime test or a complete assessment of upstream capabilities.

## Request and state map

| Boundary | Implementation |
|---|---|
| Chat Completions and native routes | `src/app/api/v1/**`, `next.config.mjs` rewrites, `src/sse/handlers/chat.js` |
| Auth/model permissions | `src/dashboardGuard.js`, `src/lib/auth/dashboardSession.js`, `src/sse/services/keyAccess.js` |
| Combo persistence/editor | `src/lib/db/repos/combosRepo.js`, `src/app/api/combos/**`, dashboard combo editor |
| Account refresh/fallback | `src/sse/services/auth.js`, `src/sse/handlers/chat.js` |
| Native format dispatch | `open-sse/handlers/chatCore.js`, `open-sse/translator/index.js`, `open-sse/executors/**` |
| Chat/Responses/Anthropic/Gemini conversion | `open-sse/translator/request/**`, `translator/formats/**`; direct routes preferred, otherwise OpenAI pivot |
| Global prompt/compression baseline | `open-sse/rtk/systemInject.js`, `customPrompt.js`, `index.js`; policy enforcement must remain independent |
| Combo fallback and first-output peek | `open-sse/services/combo.js` |
| Existing terminal usage | `open-sse/handlers/chatCore/{streamingHandler,nonStreamingHandler,sseToJsonHandler}.js`, `open-sse/utils/stream.js` |
| Existing persistence | `src/lib/db/driver.js`, `schema.js`, `migrations/`, `repos/`; `usageDb.js` is now a SQLite re-export, despite stale upstream instructions |
| Data paths | `src/lib/dataDir.js`, `src/lib/db/paths.js`; gateway database `<DATA_DIR>/db/data.sqlite` |
| Raw logging hazards | `open-sse/utils/requestLogger.js`, `src/lib/db/repos/requestDetailsRepo.js`, `usageRepo.js` |

DB adapter fallback: Bun SQLite, better-sqlite3, Node SQLite, sql.js. New code must use the abstraction rather than assume WAL/native behavior. Chat Completions, Responses, Anthropic Messages and Gemini routes are implemented; actual remote client versions/protocol distribution were not available in this local inventory. No client configuration changed.

An executor call is not a physical attempt. Base executor retries URLs/statuses; proxy transport can retry TLS or fall back direct; special transports include HTTP/2, browser fetch and subprocess prompts. Auth/bootstrap/upload/poll/download traffic is not generation. Physical dispatch instrumentation must distinguish these paths and preserve abort/backpressure.

## Local runtime and capacity

- Existing 9Router system service observed active, `NRestarts=0`, global CLI on port 20128, approximately 1.21 GiB service memory. Existing listener binds all interfaces; unchanged.
- Existing OmniRoute listener on loopback port 20129; unchanged.
- Ports 20280/20281 were available for isolated mock canary at inspection. Neither existing gateway port is used.
- Local root filesystem: 51 GiB free (89% used). RAM: 23 GiB total, 13 GiB available; swap 7 GiB used. These are point-in-time measurements, not sustained-load headroom.
- Docker API and Docker configuration access denied for current user. Container inventory, backend deployment, remote ARM capacity and image runtime validation are not established by this observation. No permission escalation or unrelated volume deletion performed.
- Remote application/CI host capacity is unverified; no production telemetry storage is deployed by this change. Langfuse sizing guidance is not proof this shared host can support it.
- Canary uses synthetic state in a dedicated absolute `DATA_DIR` and isolated HOME. In feature mode, missing/unwritable/default-production data directory fails closed rather than falling back to `~/.9router`.

## Auth and advisories

Dashboard JWT/session auth and inference API-key authorization are distinct. Preserve socket-derived client identity in `custom-server.js`; bare Next development is loopback canary only and is not public-ingress proof. Existing keys are plaintext in local state; do not copy/export them or use them as telemetry identity. Existing usage rows can contain raw keys; new ledger uses authenticated opaque IDs.

Published upstream advisories were queried through GitHub on 2026-10-27. Candidate `0.5.111` is outside the stated older affected ranges, but version comparison is not a complete security review. Some advisories have missing or malformed patched-version metadata (`5.6`); do not infer a comprehensive clearance.

- [JWT fallback authentication bypass, GHSA-jphh-m39h-6gwx](https://github.com/decolua/9router/security/advisories/GHSA-jphh-m39h-6gwx): affected through 0.4.41; patched >=0.4.44.
- [Database import/export credential theft, GHSA-qvfm-67h2-2qfx](https://github.com/decolua/9router/security/advisories/GHSA-qvfm-67h2-2qfx): stated affected through 0.4.71; patch field empty.
- [Provider CRUD/key leak, GHSA-vjc7-jrh9-9j86](https://github.com/decolua/9router/security/advisories/GHSA-vjc7-jrh9-9j86): stated affected through 0.4.41; patch field says none yet.
- [Reverse-proxy locality bypass, GHSA-x5c9-v98j-722r](https://github.com/decolua/9router/security/advisories/GHSA-x5c9-v98j-722r): affected through 0.4.80; patched >=0.5.2.
- [Spoofed internal IP authentication bypass, GHSA-5mj8-gf6m-fhw8](https://github.com/decolua/9router/security/advisories/GHSA-5mj8-gf6m-fhw8): stated affected 0.5.4; malformed patch metadata.
- [MCP argument RCE, GHSA-63p9-g54h-prrp](https://github.com/decolua/9router/security/advisories/GHSA-63p9-g54h-prrp): affected 0.4.59; patched 0.5.2.
- [Settings mass-assignment auth downgrade, GHSA-vmjq-hvgq-2wv4](https://github.com/decolua/9router/security/advisories/GHSA-vmjq-hvgq-2wv4): affected through 0.5.2; patched 0.5.4.
- [Image prefetch DNS rebinding SSRF, GHSA-cmhj-wh2f-9cgx](https://github.com/decolua/9router/security/advisories/GHSA-cmhj-wh2f-9cgx): affected through 0.4.80; patched >=0.5.2.

Inherited diagnostic contained a credential-like default. It was removed before publishing source; no value is reproduced here. New telemetry must disable legacy raw body/key capture, including debug/error paths. Secret scanning before publication remains required.

## Explicit limits

No live provider inference, remote deployment audit, production DB integrity check, client version audit, sustained-capacity benchmark or public `proxy.vnibb.xyz` cutover is claimed by this inventory. Runtime acceptance results belong in `TEST_REPORT.md` after execution. The full redacted user contract is [issue #1](https://github.com/Kitkitkittt/tele-proxy/issues/1), with linked work tickets.
