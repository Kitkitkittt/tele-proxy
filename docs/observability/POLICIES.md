# Combo policies

Policies are optional local combo state behind `TELE_PROXY_ENABLED=1`. Existing combos have no selection and retain their previous behavior. No policy text is seeded by a migration; `quality-engineering` belongs only in the isolated canary fixture.

## Administration

Edit an existing combo, open **Policy details**, and load the current configuration. New combos must be created first. The adjacent editor supports text changes, required/optional status, enable/disable, a configurable estimated injection cap (default 600, range 1–8192), immutable history, and selecting an earlier version. It displays the SHA-256 hash, selected version, estimated token count and a metadata-only preview. The actual policy text remains available to authenticated administrators for editing, not in history/audit/preview content.

`GET /api/combos/[id]/policy` returns `{featureEnabled, policy, history, audit, preview}`. `PUT` creates a version from a complete configuration:

```json
{"policyId":"synthetic-example","text":"Preserve the caller's protocol.","enabled":true,"required":true,"mergeMode":"append_preserve_client","maxInjectedTokens":600,"expectedVersion":null}
```

Use `expectedVersion: null` only for an unconfigured combo. Subsequent edits pass the currently selected version. Rollback selects an existing immutable version with `{"selectVersion":1,"expectedVersion":2}`. New edits after rollback allocate the next maximum version, not the selected version plus one. Stale writes return 409. A combo's policy ID is stable; text/configuration edits create new versions. Policy IDs accept 1–80 letters, digits, dot, underscore or hyphen. Text is limited to 32768 UTF-16 code units, rejects NUL, and must be nonempty for enabled append policies. Counts use UTF-8 bytes divided by four, rounded up: these are estimates, not model-tokenizer measurements.

The editor applies the same cap to every saved version, including disabled and `off` versions. `off` may save empty text even when enabled; an enabled append policy may not. Switching injection off never bypasses version validation.

Policy routes require the existing dashboard JWT session with `authenticated: true`, including when public dashboard viewing is enabled. A model API key, CLI bypass token or policy header cannot edit policies. Mutations reject cross-site origins. Responses are `Cache-Control: no-store`. Feature-off routes return 404. Audit records contain only fixed administrative role, action, version, hash and time; no text, credentials or user identity claims.

The shared administrative origin guard compares browser Origin with the HTTP Host authority, not Next's reconstructed internal hostname. It rejects cross-site requests and ignores untrusted forwarding headers. For HTTPS termination where the internal URL is HTTP, set the existing `BASE_URL` or `NEXT_PUBLIC_BASE_URL` to the public HTTPS origin and preserve its Host header; canonical configuration authorizes the scheme difference only for that same Host. Authenticated non-browser clients may omit Origin.

Codex Responses Lite transports top-level `instructions` as a native developer message beside `additional_tools`, including when the client already supplied that tool prefix. Existing developer messages remain unchanged. The executor consumes the top-level field only after moving its content; retries start from the same immutable pre-injection original, so each physical payload contains one policy.

## Request and provider contract

`snapshotComboPolicy(comboName)` resolves the exact stored combo name at ingress and returns a frozen local snapshot. Reasoning suffix parsing belongs to the existing ingress resolver. Each attempt starts from an immutable original and calls `applyComboPolicy(body, format, snapshot)` after translation; the helper returns a fresh cloned payload. Do not feed a previously injected result into the helper. Client-supplied text or markers never prove that a policy was applied, so text equality is not a deduplication authority.

OpenAI Chat Completions adds a system message without removing existing system/developer messages. Responses preserves string or structured `input` and appends `instructions`. Anthropic retains string/structured top-level system content and cache controls. Gemini retains `systemInstruction` and its parts. Tools, tool IDs, schema, reasoning, session and unrelated blocks remain untouched. Provider-specific binary/envelope executors require explicit physical-dispatch eligibility in integration; an unknown format is not silently converted to a user instruction.

OpenAI-to-Gemini translation preserves every system/developer string or text block in source order as native `systemInstruction.parts`; gateway policy is appended separately once. Non-text system/developer blocks are rejected before dispatch because Gemini's instruction field cannot preserve them. Instruction text is not demoted into conversation turns.

The `/v1beta/models/{alias}:generateContent` and `:streamGenerateContent` ingress keeps the original native Gemini body through routing and forwards client cancellation. URL action controls explicit streaming intent. Native SSE candidates and Antigravity envelopes retain tool IDs/thought signatures; split frames are reassembled before conversion. Responses forced-stream aggregation retains function calls for nonstream Gemini clients.

Required policies reject known lossy Gemini cross-protocol bridges before dispatch: response schemas/MIME constraints, tool-choice controls, thinking configuration/signatures, session continuity, and mixed or wrapped tool-result parts. Same-format Gemini retains those fields. This is explicit unsupported eligibility, not silent removal or an expanded model capability.

Required snapshot validation or native application errors are explicit `COMBO_POLICY_REQUIRED` failures before upstream dispatch. Optional unsupported application also fails explicitly instead of claiming success. Compression/token-saver controls do not govern policy application. Policies supplement instructions; they do not grant permissions or enforce tool execution authorization.

Web search and URL extraction accept provider combo aliases but cannot represent generation instructions. They resolve the same immutable local snapshot and reject any enabled policy whose merge mode is not `off` with HTTP 422 before provider credentials, DNS resolution, or upstream dispatch. Disabled, unconfigured, feature-off and merge-mode-off policies preserve ordinary search/fetch behavior. These network calls are not generation attempts and receive no generation pricing. STT and embeddings handlers do not expand combo aliases; policies therefore cannot be selected through those routes. Regression coverage: `tests/unit/non-generation-combo-policy.test.js`.

## Persistence and rollback boundary

The adapter-neutral migration `2026102701-combo-policy.js` runs lazily inside a transaction and records `_meta.teleProxyPolicySchemaVersion=1`. It adds immutable `comboPolicyVersions`, one current `comboPolicySelections` pointer per combo, and content-free `comboPolicyAudit`; it does not modify existing combo columns or routing data. Version creation, selection and audit commit atomically. Deleting a combo cascades its policy state while retaining its content-free audit. No WAL-specific feature is assumed.

Disable the feature flag to stop policy resolution without deleting optional tables. Selecting an earlier version is the configuration rollback; restoring a backed-up isolated gateway database is the storage restore boundary. Never co-mount production state or copied OAuth credentials into the canary.

Deterministic coverage lives in `tests/unit/combo-policy-{native,storage,api,editor}.test.js`. Parent integration/canary tests must additionally assert the final physical upstream payload, token-saver independence and zero dispatch on required failure. No checks were executed by this implementation slice.
