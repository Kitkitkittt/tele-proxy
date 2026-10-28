# Inventory

Observed 2026-10-27. This is a bounded implementation inventory, not a security audit.

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
