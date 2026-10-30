import { randomUUID, createHmac } from "node:crypto";
import { getAdapter } from "./db/driver.js";
import migration from "./db/migrations/2026102702-request-ledger.js";

const migrated = new WeakSet();
const enabled = () => process.env.TELE_PROXY_ENABLED === "1";
const now = () => new Date().toISOString();
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 160) => typeof value === "string" && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : null;
const opaque = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;
const camel = row => row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value])) : null;
const rawFields = ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount"];
const detailFields = { prompt_tokens_details: ["cached_tokens"], input_tokens_details: ["cached_tokens"], completion_tokens_details: ["reasoning_tokens"], output_tokens_details: ["reasoning_tokens"], cache_creation: ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] };

/** Reported totals stay inclusive; cached/reasoning details are not added twice. */
export function normalizeUsage(usage, format = "openai") {
  const u = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {};
  const raw = {};
  for (const key of rawFields) if (integer(u[key]) !== null) raw[key] = u[key];
  for (const [key, fields] of Object.entries(detailFields)) {
    const details = {};
    for (const field of fields) if (integer(u[key]?.[field]) !== null) details[field] = u[key][field];
    if (Object.keys(details).length) raw[key] = details;
  }
  let input = integer(u.input_tokens ?? u.prompt_tokens);
  let output = integer(u.output_tokens ?? u.completion_tokens);
  let cached = integer(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens);
  let writes = integer(u.cache_creation_input_tokens);
  let reasoning = integer(u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens);
  if (["claude", "anthropic"].includes(format) || "cache_read_input_tokens" in u || "cache_creation_input_tokens" in u) {
    cached = integer(u.cache_read_input_tokens);
    // Anthropic's base input excludes cache reads and cache writes.
    if (input !== null) input = integer(input + (cached ?? 0) + (writes ?? 0));
  }
  if (["gemini", "gemini-cli"].includes(format) || "promptTokenCount" in u) {
    input = integer(u.promptTokenCount); cached = integer(u.cachedContentTokenCount);
    reasoning = integer(u.thoughtsTokenCount); output = integer(u.candidatesTokenCount);
    if (output !== null) output = integer(output + (reasoning ?? 0));
  }
  // A present but invalid subset cannot be priced as though that subset were zero.
  const invalidSubset = [
    u.input_tokens_details?.cached_tokens, u.prompt_tokens_details?.cached_tokens,
    u.cache_read_input_tokens, u.cache_creation_input_tokens, u.cachedContentTokenCount,
    u.output_tokens_details?.reasoning_tokens, u.completion_tokens_details?.reasoning_tokens, u.thoughtsTokenCount,
  ].some(value => value !== undefined && integer(value) === null);
  if (input !== null && (cached ?? 0) + (writes ?? 0) > input) input = null;
  if (output !== null && (reasoning ?? 0) > output) output = null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: writes, reasoningTokens: reasoning, usageSource: !invalidSubset && input !== null && output !== null ? u.estimated === true || u.source === "estimated" ? "estimated" : "reported" : "unknown", allowlistedRawUsage: raw };
}

async function database() {
  const db = await getAdapter();
  if (!migrated.has(db)) {
    db.transaction(() => {
      if (!db.get("SELECT value FROM _meta WHERE key = ?", ["teleProxyLedgerSchemaVersion"])) {
        migration.up(db);
        db.run("INSERT INTO _meta(key,value) VALUES(?,?)", ["teleProxyLedgerSchemaVersion", "1"]);
      }
    });
    db.flush?.();
    migrated.add(db);
  }
  return db;
}
function insert(db, table, values) {
  const columns = Object.keys(values);
  db.run(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(values));
}
function update(db, table, key, id, values) {
  db.run(`UPDATE ${table} SET ${Object.keys(values).map(c => `${c} = ?`).join(",")} WHERE ${key} = ? AND ${table === "teleProxyRequests" ? "completed_at" : "ended_at"} IS NULL`, [...Object.values(values), id]);
}
/** Both price bases in one statement; the unique (provider, model, contract, effective_from, basis) key yields one row per basis. */
function tariffs(db, provider, model, contract, time) {
  const rows = db.all(`SELECT * FROM teleProxyTariffs t WHERE t.provider = ? AND t.model = ? AND t.contract_id = ? AND t.basis IN ('metered','reference') AND t.created_at <= ? AND t.effective_from = (SELECT MAX(x.effective_from) FROM teleProxyTariffs x WHERE x.provider = t.provider AND x.model = t.model AND x.contract_id = t.contract_id AND x.basis = t.basis AND x.effective_from <= ? AND (x.effective_to IS NULL OR x.effective_to > ?) AND x.created_at <= ?)`, [provider, model, contract, time, time, time, time]);
  const found = {};
  for (const row of rows) found[row.basis] ??= { ...row, data: JSON.parse(row.snapshot) };
  return { price: found.metered ?? null, reference: found.reference ?? null };
}

export async function startRequest(fields = {}) {
  if (!enabled()) return null;
  const db = await database();
  // Only the ingress-authenticated opaque database ID is accepted, never a header/key prefix.
  const keyId = opaque(fields.authenticatedKeyId);
  const key = keyId ? db.get("SELECT id FROM apiKeys WHERE id = ?", [keyId]) : null;
  const attribution = key ? db.get("SELECT * FROM teleProxyAttribution WHERE key_id = ?", [key.id]) : null;
  const requestId = randomUUID();
  insert(db, "teleProxyRequests", {
    request_id: requestId, trace_id: /^[0-9a-f]{32}$/.test(fields.traceId || "") && !/^0+$/.test(fields.traceId) ? fields.traceId : null,
    received_at: now(), environment: text(process.env.TELE_PROXY_ENVIRONMENT, 40) || "canary",
    authenticated_key_id: key?.id ?? null, approved_project_id: attribution?.project_id ?? null, contract_id: attribution?.contract_id ?? "unknown",
    optional_session_id: null, client_family: oneOf(fields.clientFamily, ["codex", "claude", "openai", "opencode", "pi", "omp", "unknown"], "unknown"),
    requested_alias: text(fields.requestedAlias), resolved_combo: text(fields.resolvedCombo), reasoning_effort: text(fields.reasoningEffort, 32),
    policy_id: text(fields.policyId), policy_version: integer(fields.policyVersion), policy_hash: /^[0-9a-f]{64}$/.test(fields.policyHash || "") ? fields.policyHash : null,
    policy_applied_status: oneOf(fields.policyAppliedStatus, ["off", "pending", "applied", "failed", "unsupported"], "off"),
  });
  db.flush?.();
  return camel(db.get("SELECT * FROM teleProxyRequests WHERE request_id = ?", [requestId]));
}

export async function startAttempt(requestId, fields = {}) {
  if (!enabled()) return null;
  const db = await database();
  let result;
  db.transaction(() => {
    const request = db.get("SELECT * FROM teleProxyRequests WHERE request_id = ?", [requestId]);
    const attemptId = opaque(fields.attemptId) || randomUUID();
    const existing = db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]);
    if (existing) {
      if (existing.request_id !== requestId) throw new Error("Attempt belongs to another request");
      result = camel(existing); return;
    }
    if (!request || request.completed_at) throw new Error("Ledger request is missing or terminal");
    const contract = request.contract_id;
    const started = now(), provider = text(fields.provider), model = text(fields.requestedModel);
    const { price, reference } = tariffs(db, provider, model, contract, started);
    const sequence = db.get("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM teleProxyAttempts WHERE request_id = ?", [requestId]).n;
    const secret = process.env.TELE_PROXY_PSEUDONYM_SECRET;
    const connection = secret && text(fields.connectionId) ? createHmac("sha256", secret).update(fields.connectionId).digest("hex").slice(0, 32) : null;
    insert(db, "teleProxyAttempts", { attempt_id: attemptId, request_id: requestId, sequence, started_at: started,
      provider, connection_pseudonym: connection, requested_model: model, contract_id: contract,
      fallback_reason: oneOf(fields.fallbackReason, ["primary", "rate_limit", "upstream_error", "auth_refresh", "unavailable", "policy_unsupported", "account_fallback", "retry", "unknown"], "unknown"),
      billing_mode: price?.data.billingMode || "unknown", price_snapshot_id: price?.id ?? null, reference_price_snapshot_id: reference?.id ?? null,
      currency: price?.currency ?? reference?.currency ?? null });
    db.run("UPDATE teleProxyRequests SET attempt_count = attempt_count + 1 WHERE request_id = ?", [requestId]);
    result = camel(db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]));
  });
  db.flush?.();
  return result;
}

/** The caller must prove the transport callback was not invoked. */
export async function discardUnsentAttempt(requestId, attemptId) {
  if (!enabled()) return null;
  const db = await database();
  db.transaction(() => {
    const attempt = db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]);
    if (!attempt) return;
    if (attempt.request_id !== requestId) throw new Error("Attempt belongs to another request");
    if (attempt.status !== "inflight" || attempt.ended_at !== null || attempt.upstream_first_content_ms !== null || attempt.downstream_first_content_ms !== null || attempt.invoice_reconciled_spend_micros !== null || attempt.subscription_allocation_micros !== null || attempt.local_infrastructure_allocation_micros !== null) throw new Error("Attempt has already been observed");
    const count = db.run("UPDATE teleProxyRequests SET attempt_count = attempt_count - 1 WHERE request_id = ? AND completed_at IS NULL AND attempt_count > 0", [requestId]);
    if (count.changes !== 1) throw new Error("Cannot release attempt from terminal or inconsistent request");
    db.run("DELETE FROM teleProxyAttempts WHERE attempt_id = ? AND request_id = ?", [attemptId, requestId]);
  });
  db.flush?.();
  return true;
}

/** Integer micro-currency arithmetic; one rounding step after all categories. */
export function estimateMicros(usage, snapshot) {
  if (!snapshot || usage.usageSource === "unknown" || usage.inputTokens === null || usage.outputTokens === null) return null;
  if (snapshot.billingMode === "subscription" && snapshot.basis !== "reference") return snapshot.zeroMarginalFee === true ? 0 : null;
  if (snapshot.billingMode !== "metered" && snapshot.basis !== "reference") return null;
  const cached = usage.cachedInputTokens ?? 0, writes = usage.cacheWriteTokens ?? 0;
  const reasoning = snapshot.reasoningMicrosPerMillion !== undefined ? usage.reasoningTokens ?? 0 : 0;
  const categories = [[usage.inputTokens - cached - writes, "inputMicrosPerMillion"], [cached, "cachedInputMicrosPerMillion"], [writes, "cacheWriteMicrosPerMillion"], [usage.outputTokens - reasoning, "outputMicrosPerMillion"], [reasoning, "reasoningMicrosPerMillion"]];
  if (snapshot.cacheWrite5mMicrosPerMillion !== undefined || snapshot.cacheWrite1hMicrosPerMillion !== undefined) {
    const details = usage.allowlistedRawUsage?.cache_creation;
    const short = integer(details?.ephemeral_5m_input_tokens), long = integer(details?.ephemeral_1h_input_tokens);
    if (writes && (short === null || long === null || short + long !== writes)) return null;
    categories[2] = [short ?? 0, "cacheWrite5mMicrosPerMillion"];
    categories.push([long ?? 0, "cacheWrite1hMicrosPerMillion"]);
  }
  let total = 0n;
  for (const [count, rate] of categories) {
    if (integer(count) === null || count && integer(snapshot[rate]) === null) return null;
    if (count) total += BigInt(count) * BigInt(snapshot[rate]);
  }
  const amount = (total + 500000n) / 1000000n;
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export async function finishAttempt(attemptId, fields = {}) {
  if (!enabled()) return null;
  const db = await database();
  let result;
  db.transaction(() => {
    const attempt = db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]);
    if (!attempt) throw new Error("Ledger attempt does not exist");
    if (attempt.ended_at) { result = camel(attempt); return; }
    const usage = normalizeUsage(fields.usage ?? fields.rawUsage, fields.format);
    if (fields.usageSource === "estimated" && usage.usageSource === "reported") usage.usageSource = "estimated";
    if (fields.usageComplete === false) usage.usageSource = "unknown";
    const responseModel = text(fields.responseModel), model = responseModel || attempt.requested_model;
    const byId = id => { const row = id ? db.get("SELECT * FROM teleProxyTariffs WHERE id = ?", [id]) : null; return row ? { ...row, data: JSON.parse(row.snapshot) } : null; };
    const repriced = model === attempt.requested_model ? null : tariffs(db, attempt.provider, model, attempt.contract_id, attempt.started_at);
    const price = repriced ? repriced.price : byId(attempt.price_snapshot_id);
    const reference = repriced ? repriced.reference : byId(attempt.reference_price_snapshot_id);
    const metered = estimateMicros(usage, price?.data);
    const referenceValue = estimateMicros(usage, reference?.data);
    const reportedCurrency = /^[A-Z]{3}$/.test(fields.currency || "") ? fields.currency : null;
    const reported = text(fields.chargeEvidenceSource, 240) && reportedCurrency ? integer(fields.providerReportedChargeMicros) : null;
    const currency = price?.currency ?? reportedCurrency ?? reference?.currency ?? null;
    update(db, "teleProxyAttempts", "attempt_id", attemptId, {
      ended_at: now(), response_model: responseModel, status: oneOf(fields.status, ["success", "error", "cancelled", "abandoned", "incomplete"], "incomplete"),
      error_class: oneOf(fields.errorClass, ["auth", "rate_limit", "timeout", "network", "upstream", "policy", "cancelled", "unknown"], null),
      cancel_state: oneOf(fields.cancelState, ["none", "client_cancelled", "upstream_aborted", "unknown"], "none"),
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cached_input_tokens: usage.cachedInputTokens,
      cache_write_tokens: usage.cacheWriteTokens, reasoning_tokens: usage.reasoningTokens, usage_source: usage.usageSource,
      allowlisted_raw_usage: JSON.stringify(usage.allowlistedRawUsage), provider_reported_charge_micros: reported,
      charge_evidence_source: reported !== null ? text(fields.chargeEvidenceSource, 240) : null,
      provider_reported_currency: reported !== null ? reportedCurrency : null, reference_currency: reference?.currency ?? null,
      metered_cost_estimate_micros: metered, api_equivalent_value_micros: referenceValue,
      currency, billing_mode: price?.data.billingMode || "unknown", price_snapshot_id: price?.id ?? null,
      reference_price_snapshot_id: reference?.id ?? null, cost_status: reported !== null ? "reported" : metered !== null ? "estimated" : "unknown",
      upstream_first_content_ms: integer(fields.upstreamFirstContentMs), downstream_first_content_ms: attempt.downstream_first_content_ms ?? integer(fields.downstreamFirstContentMs),
    });
    result = camel(db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]));
  });
  db.flush?.();
  return result;
}

export async function finishRequest(requestId, fields = {}) {
  if (!enabled()) return null;
  const db = await database();
  let result;
  db.transaction(() => {
    const request = db.get("SELECT * FROM teleProxyRequests WHERE request_id = ?", [requestId]);
    if (!request) throw new Error("Ledger request does not exist");
    if (request.completed_at) { result = camel(request); return; }
    const counts = db.get("SELECT COUNT(*) AS n, SUM(CASE WHEN ended_at IS NULL OR usage_source = 'unknown' OR cost_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count FROM teleProxyAttempts WHERE request_id = ?", [requestId]);
    const end = now();
    update(db, "teleProxyRequests", "request_id", requestId, { completed_at: end,
      final_status: oneOf(fields.finalStatus ?? fields.status, ["success", "error", "cancelled", "abandoned", "policy_failed"], "error"),
      total_duration_ms: Math.max(0, Date.parse(end) - Date.parse(request.received_at)),
      accounting_completeness: fields.accountingIncomplete !== true && counts.n > 0 && !counts.unknown_count ? "complete" : "incomplete",
      policy_applied_status: oneOf(fields.policyAppliedStatus, ["off", "applied", "failed", "unsupported"], request.policy_applied_status) });
    result = camel(db.get("SELECT * FROM teleProxyRequests WHERE request_id = ?", [requestId]));
  });
  db.flush?.();
  return result;
}
/** Correct a failed client EOF acknowledgement after success was persisted. */
export async function correctRequestEofOutcome(requestId, outcome) {
  if (!enabled()) return null;
  if (!["cancelled", "error"].includes(outcome)) throw new Error("Invalid EOF correction outcome");
  const db = await database();
  let result;
  db.transaction(() => {
    db.run("UPDATE teleProxyRequests SET final_status = ? WHERE request_id = ? AND completed_at IS NOT NULL AND final_status = 'success'", [outcome, requestId]);
    const request = db.get("SELECT * FROM teleProxyRequests WHERE request_id = ?", [requestId]);
    if (!request) throw new Error("Ledger request does not exist");
    result = camel(request);
  });
  db.flush?.();
  return result;
}


/** Startup only, before accepting traffic: never apply recovery to another running process. */
export async function recoverAbandoned({ before = now() } = {}) {
  if (!enabled()) return { requests: 0, attempts: 0 };
  if (!Number.isFinite(Date.parse(before))) throw new Error("Invalid recovery boundary");
  const db = await database();
  let result;
  db.transaction(() => {
    const attempts = db.get("SELECT COUNT(*) AS n FROM teleProxyAttempts WHERE ended_at IS NULL AND started_at < ?", [before]).n;
    const requests = db.get("SELECT COUNT(*) AS n FROM teleProxyRequests WHERE completed_at IS NULL AND received_at < ?", [before]).n;
    db.run("UPDATE teleProxyAttempts SET ended_at = ?, status = 'abandoned', cancel_state = 'unknown', usage_source = 'unknown', cost_status = 'unknown', metered_cost_estimate_micros = NULL, api_equivalent_value_micros = NULL WHERE ended_at IS NULL AND started_at < ?", [now(), before]);
    db.run("UPDATE teleProxyRequests SET completed_at = ?, final_status = 'abandoned', accounting_completeness = 'incomplete' WHERE completed_at IS NULL AND received_at < ?", [now(), before]);
    result = { requests, attempts };
  });
  db.flush?.();
  return result;
}

export async function getLedgerSummary({ from = "1970-01-01T00:00:00.000Z", to = now(), limit = 25 } = {}) {
  if (!enabled()) return { enabled: false };
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) > Date.parse(to)) throw new Error("Invalid ledger time range");
  const db = await database();
  const range = [new Date(from).toISOString(), new Date(to).toISOString()];
  const r = db.get("SELECT COUNT(*) AS n, SUM(CASE WHEN accounting_completeness = 'complete' THEN 1 ELSE 0 END) AS complete FROM teleProxyRequests WHERE received_at >= ? AND received_at <= ?", range);
  const a = db.get("SELECT COUNT(*) AS n, SUM(CASE WHEN usage_source != 'unknown' THEN 1 ELSE 0 END) AS usage_known, SUM(CASE WHEN cost_status != 'unknown' THEN 1 ELSE 0 END) AS cost_known FROM teleProxyAttempts WHERE started_at >= ? AND started_at <= ?", range);
  const basisColumns = ["provider_reported_charge_micros", "invoice_reconciled_spend_micros", "metered_cost_estimate_micros", "api_equivalent_value_micros", "subscription_allocation_micros", "local_infrastructure_allocation_micros"];
  const currencies = new Map();
  let cursor = "";
  for (;;) {
    const rows = db.all(`SELECT attempt_id, currency, provider_reported_currency, reference_currency, ${basisColumns.join(",")} FROM teleProxyAttempts WHERE started_at >= ? AND started_at <= ? AND attempt_id > ? ORDER BY attempt_id LIMIT 1000`, [...range, cursor]);
    for (const row of rows) {
      if (!currencies.has(row.currency)) currencies.set(row.currency, Object.fromEntries(basisColumns.map(key => [key, null])));
      for (const column of basisColumns) {
        if (row[column] === null) continue;
        const currency = column === "provider_reported_charge_micros" ? row.provider_reported_currency : column === "api_equivalent_value_micros" ? row.reference_currency : row.currency;
        if (!currencies.has(currency)) currencies.set(currency, Object.fromEntries(basisColumns.map(key => [key, null])));
        currencies.get(currency)[column] = (currencies.get(currency)[column] ?? 0n) + BigInt(row[column]);
      }
    }
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].attempt_id;
  }
  const totals = [...currencies].map(([currency, sums]) => camel({ currency, ...Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, value === null || value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)])) }));
  return { enabled: true, requests: r.n, attempts: a.n,
    coverage: { usageKnownAttempts: a.usage_known || 0, usageUnknownAttempts: a.n - (a.usage_known || 0), costKnownAttempts: a.cost_known || 0, costUnknownAttempts: a.n - (a.cost_known || 0), requestComplete: r.complete || 0, requestIncomplete: r.n - (r.complete || 0) },
    totals, fixedFees: db.all("SELECT * FROM teleProxyFixedFees WHERE period_start <= ? AND period_end >= ? ORDER BY period_start DESC", [range[1], range[0]]).map(camel),
    recentRequests: db.all("SELECT * FROM teleProxyRequests WHERE received_at >= ? AND received_at <= ? ORDER BY received_at DESC LIMIT ?", [...range, Math.min(100, Math.max(1, integer(limit) ?? 25))]).map(camel),
    priceSnapshots: db.all("SELECT * FROM teleProxyTariffs ORDER BY created_at DESC LIMIT 100").map(row => ({ ...camel(row), snapshot: JSON.parse(row.snapshot) })),
  };
}
export async function getRequestAttempts(requestId) {
  if (!enabled()) return [];
  const db = await database();
  return db.all("SELECT * FROM teleProxyAttempts WHERE request_id = ? ORDER BY sequence", [requestId]).map(row => ({ ...camel(row), allowlistedRawUsage: JSON.parse(row.allowlisted_raw_usage || "{}") }));
}

/** Admin configuration uses immutable snapshots; no upstream reference-price import. */
export async function addTariff(fields) {
  if (!enabled()) throw new Error("Tariff ledger is disabled");
  const db = await database();
  const provider = text(fields.provider), model = text(fields.model), contract = opaque(fields.contractId);
  const basis = oneOf(fields.basis, ["metered", "reference"], null);
  const billingMode = oneOf(fields.billingMode, ["metered", "subscription", "local"], null);
  if (!provider || !model || !contract || !basis || !billingMode || !/^[A-Z]{3}$/.test(fields.currency || "") || !text(fields.evidenceSource, 240) || !Number.isFinite(Date.parse(fields.effectiveFrom))) throw new Error("Tariff requires provider, model, contract, basis, billing mode, currency, effective date and evidence");
  const start = new Date(fields.effectiveFrom).toISOString();
  if (fields.effectiveTo && !Number.isFinite(Date.parse(fields.effectiveTo))) throw new Error("Tariff end date is invalid");
  const end = fields.effectiveTo ? new Date(fields.effectiveTo).toISOString() : null;
  if (end && end <= start) throw new Error("Tariff end must follow start");
  const snapshot = { provider, model, contractId: contract, basis, billingMode, currency: fields.currency, effectiveFrom: start, effectiveTo: end, evidenceSource: fields.evidenceSource };
  for (const key of ["inputMicrosPerMillion", "outputMicrosPerMillion", "cachedInputMicrosPerMillion", "cacheWriteMicrosPerMillion", "cacheWrite5mMicrosPerMillion", "cacheWrite1hMicrosPerMillion", "reasoningMicrosPerMillion"]) {
    if (fields[key] !== undefined) {
      if (integer(fields[key]) === null) throw new Error("Tariff rates must be nonnegative integer micro-units per million tokens");
      snapshot[key] = fields[key];
    }
  }
  if (billingMode === "subscription") snapshot.zeroMarginalFee = fields.zeroMarginalFee === true;
  const id = randomUUID();
  insert(db, "teleProxyTariffs", { id, provider, model, contract_id: contract, effective_from: start, effective_to: end, basis, currency: fields.currency, evidence_source: fields.evidenceSource, created_at: now(), snapshot: JSON.stringify(snapshot) });
  db.flush?.();
  return { id, ...snapshot };
}
export async function setKeyAttribution({ keyId, projectId, contractId }) {
  if (!enabled()) throw new Error("Attribution ledger is disabled");
  const db = await database();
  if (!opaque(keyId) || !opaque(projectId) || !opaque(contractId) || !db.get("SELECT id FROM apiKeys WHERE id = ?", [keyId])) throw new Error("Attribution requires an existing opaque key ID and approved project/contract IDs");
  db.run("INSERT INTO teleProxyAttribution(key_id,project_id,contract_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET project_id=excluded.project_id,contract_id=excluded.contract_id,updated_at=excluded.updated_at", [keyId, projectId, contractId, now()]);
  db.flush?.();
  return { keyId, projectId, contractId };
}
export async function addFixedFee(fields) {
  if (!enabled()) throw new Error("Fixed fee ledger is disabled");
  const db = await database();
  if (integer(fields.amountMicros) === null || !/^[A-Z]{3}$/.test(fields.currency || "") || !text(fields.evidenceSource, 240) || !["subscription", "local"].includes(fields.billingMode) || !Number.isFinite(Date.parse(fields.periodStart)) || !Number.isFinite(Date.parse(fields.periodEnd)) || Date.parse(fields.periodEnd) <= Date.parse(fields.periodStart)) throw new Error("Fixed fee requires valid period, integer micro amount, currency, basis and evidence");
  const id = randomUUID();
  insert(db, "teleProxyFixedFees", { id, period_start: new Date(fields.periodStart).toISOString(), period_end: new Date(fields.periodEnd).toISOString(), currency: fields.currency, amount_micros: fields.amountMicros, billing_mode: fields.billingMode, evidence_source: fields.evidenceSource, created_at: now() });
  db.flush?.();
  return { id };
}
export async function reconcileAttempt(attemptId, fields) {
  if (!enabled()) throw new Error("Reconciliation ledger is disabled");
  const db = await database();
  const amount = integer(fields.amountMicros), evidence = text(fields.evidenceSource, 240);
  const column = { invoice: "invoice_reconciled_spend_micros", subscription_allocation: "subscription_allocation_micros", local_allocation: "local_infrastructure_allocation_micros" }[fields.basis];
  if (!column || amount === null || !evidence || !/^[A-Z]{3}$/.test(fields.currency || "")) throw new Error("Reconciliation requires basis, amount, currency and evidence");
  const evidenceColumn = { invoice: "invoice_evidence_source", subscription_allocation: "subscription_evidence_source", local_allocation: "local_evidence_source" }[fields.basis];
  db.transaction(() => {
    const row = db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]);
    if (!row?.ended_at || row.currency && row.currency !== fields.currency) throw new Error("Reconciliation needs a completed attempt in the same currency");
    if (row[column] !== null) {
      if (row[column] !== amount || row[evidenceColumn] !== evidence) throw new Error("Reconciliation evidence is immutable");
      return;
    }
    db.run(`UPDATE teleProxyAttempts SET ${column} = ?, ${evidenceColumn} = ?, currency = ?${fields.basis === "invoice" ? ", cost_status = 'reconciled'" : ""} WHERE attempt_id = ?`, [amount, evidence, fields.currency, attemptId]);
  });
  db.flush?.();
  return camel(db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]));
}

/** Delete terminal metadata only; keep tariffs and fixed-fee evidence for reconciliation. */
export async function pruneLedger({ retentionDays = 90 } = {}) {
  if (!enabled()) return { requests: 0, attempts: 0 };
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("Ledger retention must be 1–3650 days");
  const db = await database();
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  let result;
  db.transaction(() => {
    const filter = "SELECT request_id FROM teleProxyRequests WHERE completed_at IS NOT NULL AND completed_at < ? AND NOT EXISTS (SELECT 1 FROM teleProxyAttempts a WHERE a.request_id = teleProxyRequests.request_id AND a.ended_at IS NULL)";
    const requests = db.get(`SELECT COUNT(*) AS n FROM teleProxyRequests WHERE request_id IN (${filter})`, [cutoff]).n;
    const attempts = db.get(`SELECT COUNT(*) AS n FROM teleProxyAttempts WHERE request_id IN (${filter})`, [cutoff]).n;
    db.run(`DELETE FROM teleProxyAttempts WHERE request_id IN (${filter})`, [cutoff]);
    db.run(`DELETE FROM teleProxyRequests WHERE request_id IN (${filter})`, [cutoff]);
    result = { requests, attempts, cutoff };
  });
  db.flush?.();
  return result;
}

/** A terminal usage record may acquire its first downstream observation once. */
export async function recordDownstreamFirstContent(attemptId, elapsedMs) {
  if (!enabled()) return null;
  if (!opaque(attemptId) || integer(elapsedMs) === null) throw new Error("Invalid downstream timing observation");
  const db = await database();
  db.run("UPDATE teleProxyAttempts SET downstream_first_content_ms = ? WHERE attempt_id = ? AND downstream_first_content_ms IS NULL", [elapsedMs, attemptId]);
  db.flush?.();
  return camel(db.get("SELECT * FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId]));
}
