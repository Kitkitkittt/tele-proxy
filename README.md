# tele-proxy

A small, feature-flagged fork of [9Router](https://github.com/decolua/9router) for additive combo instruction policies, durable request/attempt accounting, and private operational observability. It retains the inherited provider adapters, protocol translators, model combos, credential management, and Next.js dashboard rather than adding another gateway in front.

**Deployed 2026-10-29:** dashboard at **https://tele-proxy.vnibb.xyz**, client base URL **https://tele-proxy.vnibb.xyz/v1**. Existing `9router.vnibb.xyz` clients continue through the same loopback gateway; no client configuration was changed. Password, API keys and combos were preserved. Native systemd deployment and public-browser evidence are recorded in the [dated deployment record](docs/observability/TEST_REPORT.md#2026-10-29-native-production-cutover). This supersedes the historical `proxy.vnibb.xyz` target; it does not certify every monitoring/performance gate below.

## Scope and status

- Immutable per-combo policy versions, authorized editing/rollback, and additive instructions applied to each supported primary/retry/fallback attempt.
- An unsampled local ledger distinguishes one logical request from physical provider attempts, with explicit incomplete/unknown accounting.
- Separate provider charges, metered estimates, fixed subscription fees, API-equivalent reference values, and infrastructure allocations. These are not interchangeable cash totals.
- Authenticated `/api/metrics`, metadata-only structured logs and bounded asynchronous OpenTelemetry export; private Prometheus/Grafana/Loki/Alloy profiles, with optional Langfuse and Tempo.
- `TELE_PROXY_ENABLED=1` opts into the extension and requires an absolute dedicated `DATA_DIR`. The default upstream data directory is rejected. A different path is **not** proof that copied production credentials are safe to run concurrently.

The [verification report](docs/observability/TEST_REPORT.md) records synthetic ingress, policy, accounting, browser, and native monitoring evidence. It is not a production-readiness claim. Known limits:

- **Performance target is not met.** The original standalone canary measured **15.07 ms** additional p95; the first deployment rerun measured **5.12 ms** for one sample. The later record-every-run alternating gate on the latest recorded deployed artifact, **10 runs total, five per concurrency** at concurrency 1 and 2 with order reversed each run, passed `<10 ms` in only **3 of 10** runs (deltas −14.3 to +21.7 ms) with all 25 behavior cases passing. Per-run misses are failures; no median-pass rule exists. Durability was not weakened, but a passing sample or a median is not an established performance guarantee.
- Latest recorded deployed source is `500c42b92e43c5bc93365f6c133bb1514c28b3f0`, release `500c42b9-20261029T130824Z`. Its pre-deploy acceptance passed 25/25 cases but its timing run **failed** at +15.997 ms. Loopback/public health 200, public `/api/metrics` 404, authenticated `/v1/models` 200 and read-only DB-count checks were observed. Dashboard HTTP 200 was not observed. The earlier `da851bcf` review retained 35 failed assertions plus two collection failures, so historical full-suite success is not claimed for that binary.
- The latest isolated candidate also remains unqualified: all 25 ingress behavior cases passed in each of 10 alternating runs, but only **4 of 10** met `<10 ms` (additional p95 −0.02 to +31.96 ms). Browser save/rollback-to-wire and inference-linked diagnostic isolation/expiry passed on that candidate; see the separate [candidate record](docs/observability/TEST_REPORT.md#2026-10-29-hot-path-and-offline-suite-candidate).
- Latest offline suite: **4,618 passed, zero failures or collection errors, 52 skipped/pending and one todo**, including the cookie-forwarding, authorized-proxy log-redaction and no-key `lastUsed` regressions. Checkpoint `85dcbe99` had missed a real raw-key disclosure in legacy usage-stat property names; deleting its assertion was not merely removing obsolete coverage. Behavioral 24h/7d serialization checks, colliding-mask separation, precise timestamps and standalone HTTP proof qualify the deployed redaction, recorded in [the security correction](docs/observability/TEST_REPORT.md#2026-10-29-raw-key-stats-disclosure-correction). Live-provider files, missing cloud-worker/ffmpeg prerequisites and opted-out integration cases remain unqualified.
- **Production switches made without an explicit waiver.** A general "commit and redeploy" instruction was treated as an operator exception; that claim is withdrawn in the [verification report](docs/observability/TEST_REPORT.md#2026-10-29-production-switches-against-an-open-performance-hold). The performance gate never passed (4/10 runs under `<10 ms`) and stays open. Current pointer `500c42b9-20261029T130824Z`, previous `6e8a863a-20261029T122006Z`, further frozen point `da851bcf-20261029T082307Z`. Rolling back would restore a fixed credential leak (origin `auth_token`/`9r_mimo_login` forwarded to `account.xiaomi.com`), so the gateway is left running pending an owner decision.
- Native x64 runtime, private SQLite restore, preserved authentication and previous-binary rollback were exercised. Full Docker Compose operation, real Langfuse ingestion/UI, backend-volume restore and supported full trace retention remain separate gates.
- Langfuse Community Edition raw S3-event expiry is not complete trace-row retention. Capacity and supported retention must be resolved before enabling its profile.
- Gemini/Muse browser accounting and hidden library retries remain explicitly incomplete. Required policies reject transports without a trusted instruction channel rather than silently claiming success.
- Gateway telemetry observes model dispatch and requested tools, not actual agent tool execution or task correctness. No universal provider compatibility, savings, security-audit, or zero-downtime claim is made.

## Clone and install

Development branch: `codex/1-tele-proxy`; review: [draft PR #13](https://github.com/Kitkitkittt/tele-proxy/pull/13). Use the release commit recorded by the operator when reproducing a deployment; a moving branch is not an artifact pin.

```sh
git clone --branch codex/1-tele-proxy --single-branch https://github.com/Kitkitkittt/tele-proxy.git
cd tele-proxy
# With nvm installed; .nvmrc pins Node 22.23.4.
nvm install
nvm use
npm ci
npm --prefix tests ci
```

`npm ci` uses the committed lockfiles and normal dependency lifecycle scripts. Do not substitute a global `npm install -g 9router`, a stock upstream image, or `--ignore-scripts` for a qualified production build. This fork is the root dashboard/gateway package; the inherited `cli/` launcher is a separate package and is not required for source development. Node 24.20.0 was used in the historical canary; the repository Node pin is not itself runtime qualification on another architecture.

## Safe local development

Use a fresh clone without `.env`/`.env.local` copied from another installation. `.env.example` is an inherited variable reference, **not** a safe ready-to-run secret file: it contains placeholder secrets, a production-style data path, and upstream cloud-sync URLs. Never point development at `~/.9router`, a running gateway directory, or a copied OAuth-bearing database.

From the repository root, open a clean shell so inherited provider keys, OTLP destinations and proxy variables are not forwarded:

```sh
env -i PATH="$PATH" TERM="${TERM:-dumb}" bash --noprofile --norc
```

In that shell, still at the repository root:

```sh
umask 077
export TELE_PROXY_LOCAL_ROOT="$(mktemp -d /tmp/tele-proxy-local.XXXXXX)"
mkdir -p "$TELE_PROXY_LOCAL_ROOT/home" "$TELE_PROXY_LOCAL_ROOT/build-home"
export HOME="$TELE_PROXY_LOCAL_ROOT/home"
export DATA_DIR="$TELE_PROXY_LOCAL_ROOT/run-state"
export TELE_PROXY_ENABLED=1 TELE_PROXY_CANARY=1 TELE_PROXY_ENVIRONMENT=canary
export NEXT_TELEMETRY_DISABLED=1 ENABLE_REQUEST_LOGS=false
export NO_PROXY=127.0.0.1,localhost
export INITIAL_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export API_KEY_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export MACHINE_ID_SALT="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export TELE_PROXY_PSEUDONYM_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export TELE_PROXY_METRICS_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 20282
```

Port `20282` must be free; do not kill another service to obtain it. The local dashboard is at `http://127.0.0.1:20282/dashboard` and client base URL is `http://127.0.0.1:20282/v1` **only while this process is running**. The password remains in this private shell's environment; do not paste it into issues or logs. Do not enable shell tracing. Stop with Ctrl-C. Keep fixtures synthetic and do not add real provider accounts. `TELE_PROXY_CANARY=1` suppresses selected background activity; it is not a network sandbox or permission to clone OAuth ownership.

The root `npm run dev`/`dev:webpack` scripts select port `20127`; the explicit command above binds loopback on a separate port. Development Next ingress is not the production custom-server security boundary.

### Build and run the standalone artifact

In the same isolated shell after stopping development:

```sh
env HOME="$TELE_PROXY_LOCAL_ROOT/build-home" DATA_DIR="$TELE_PROXY_LOCAL_ROOT/build-state" \
  TELE_PROXY_ENABLED=0 TELE_PROXY_CANARY=1 NEXT_TELEMETRY_DISABLED=1 npm run build
# Continue only if the build succeeds. postbuild copies static/public assets and custom-server.js.
NODE_ENV=production PORT=20283 HOSTNAME=127.0.0.1 node .next/standalone/custom-server.js
```

Runtime inherits the enabled flag, independent run state and generated secrets from the shell. Use `PORT`/`HOSTNAME` for standalone startup, not `--port`; reserve `20283` first. Use the copied custom server rather than bare `next start` for release qualification. See the [production artifact gate](docs/observability/ROLLOUT_ROLLBACK.md#production-artifact-gate-feature-off-at-build-on-at-startup) for privacy, authentication and readiness checks. These commands are instructions, not newly executed verification.

## Tests and canary

Tests are an independent package; there is no root `npm test` script. Run in the isolated shell above, with no real-provider credentials. Run serially rather than alongside a build or benchmark.

```sh
# Focused synthetic regression, paths relative to tests/:
npm --prefix tests test -- unit/combo-policy-native.test.js unit/combo-policy-storage.test.js \
  unit/combo-policy-api.test.js unit/request-ledger.test.js unit/request-ledger-durability.test.js \
  unit/dispatch-physical-retries.test.js unit/gateway-telemetry.test.js unit/dashboard-guard.test.js \
  --maxWorkers=1
# Full offline discovery: live/credential suites require explicit opt-in.
# Cloud worker cases skip when cloud/ is absent; deterministic failures still fail.
npm --prefix tests test -- --maxWorkers=1
# After a successful standalone build, owns fresh temporary state and loopback ports 20280/20281:
node scripts/tele-proxy-canary.mjs --runtime=production --samples=40 --concurrency=2
# Offline monitoring bootstrap assertions; no Docker or inference:
python3 ops/observability/selfcheck.py
```

The canary uses synthetic local providers, starts its own servers, then removes its temporary state; never attach it to production. It exits nonzero on failed behavior or the overhead target miss. Keep its ports free. The [test report](docs/observability/TEST_REPORT.md) contains exercised commands, exact outcomes and limitations. No inherited-failure count is an acceptance threshold; deterministic failures require current evidence.

## Operations and handoff

| Document | Purpose |
|---|---|
| [Improvement plan](docs/observability/IMPROVEMENT_PLAN.md) | Prioritized existing tickets, release gates, cross-machine development and private state handoff |
| [Inventory](docs/observability/INVENTORY.md) | Inspected lineage, routing/storage boundaries, environment and capacity evidence |
| [Architecture](docs/observability/ARCHITECTURE.md) | Signal authority, profiles, bounded resources and retention |
| [Policies](docs/observability/POLICIES.md) | Policy persistence, authorization and native preservation contract |
| [Accounting](docs/observability/ACCOUNTING.md) | Durable ledger, normalization and distinct monetary bases |
| [Privacy](docs/observability/PRIVACY.md) | Metadata-only capture and prohibited payload/secret handling |
| [Verification report](docs/observability/TEST_REPORT.md) | Executed evidence, failures and unavailable runtime gates |
| [Rollout and rollback](docs/observability/ROLLOUT_ROLLBACK.md) | Isolated build, backup/restore and promotion procedures |
| [Operational runbooks](ops/observability/runbooks.md) | Alerts, exporter failures and storage pressure |
| [Langfuse stack](ops/observability/langfuse/README.md) | Pinned backend, retention/capacity limits and ingestion checks |

Older documents retain their original canary-only authorization and old target as historical context. The current user explicitly authorizes further implementation, commit and redeployment; historical planning-only restrictions are not current authority. The [improvement plan](docs/observability/IMPROVEMENT_PLAN.md) identifies the current target and controlled migration boundary; it does not retroactively mark older gates passed. Public ingress must expose only the intended gateway surface, not metrics, OTLP, databases, Grafana or Langfuse admin ports.

Production runs a frozen standalone release, not the globally installed upstream CLI. The inherited dashboard still displays `9Router`/`0.5.111` and an upstream update prompt: **do not use “Update now” or `npm i -g 9router` to upgrade tele-proxy**. Qualify a new native artifact, then deliberately change the release symlink. See the [native operations/rollback procedure](docs/observability/ROLLOUT_ROLLBACK.md#8-native-systemd-deployment-2026-10-29).

## Lineage and license

Forked from `decolua/9router` version `0.5.111`, upstream pin [`3a978a631ad65529c06e48ce495092d5bba29f46`](https://github.com/decolua/9router/tree/3a978a631ad65529c06e48ce495092d5bba29f46). Inherited internal `9router` names, launcher, assets and translated READMEs remain upstream material; their promotional claims are not tele-proxy acceptance evidence.

Licensed under the [MIT License](LICENSE), copyright © 2024–2026 decolua and contributors. Preserve that notice and permission text in redistributed copies/substantial portions. This README replacement does not remove the license, upstream assets or source code. Canonical feature requirements and child tickets are tracked in [issue #1](https://github.com/Kitkitkittt/tele-proxy/issues/1).
