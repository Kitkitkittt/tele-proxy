import initSqlJs from "sql.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLES } from "../../src/lib/db/schema.js";

const TIME = "2026-10-27T12:00:00.000Z";
const USAGE = { prompt_tokens: 1000, completion_tokens: 200 };
let SQL;
let adapter;
let ledger;
let getAdapter;

// The only storage mock is driver selection. Every statement and transaction runs
// against SQLite, with the same synchronous adapter contract as sqljsAdapter.js.
function memoryAdapter() {
  const raw = new SQL.Database();
  raw.exec("PRAGMA foreign_keys = ON");
  const query = (sql, params, first) => {
    const statement = raw.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        if (first) return row;
        rows.push(row);
      }
      return first ? undefined : rows;
    } finally {
      statement.free();
    }
  };
  return {
    driver: "sql.js",
    exec: (sql) => raw.exec(sql),
    get: (sql, params = []) => query(sql, params, true),
    all: (sql, params = []) => query(sql, params, false),
    run(sql, params = []) {
      raw.run(sql, params);
      return { changes: raw.getRowsModified() };
    },
    transaction(fn) {
      raw.exec("SAVEPOINT ledger_test");
      try {
        const result = fn();
        raw.exec("RELEASE ledger_test");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK TO ledger_test; RELEASE ledger_test");
        throw error;
      }
    },
    close: () => raw.close(),
  };
}

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("TELE_PROXY_ENABLED", "1");
  vi.stubEnv("TELE_PROXY_ENVIRONMENT", "unit-test");
  vi.stubEnv("TELE_PROXY_PSEUDONYM_SECRET", "unit-test-pseudonym-secret");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(TIME));
  adapter = memoryAdapter();
  for (const [name, table] of Object.entries(TABLES)) {
    const columns = Object.entries(table.columns).map(([column, definition]) => `${column} ${definition}`);
    if (table.primaryKey) columns.push(table.primaryKey);
    adapter.exec(`CREATE TABLE ${name} (${columns.join(",")})`);
    for (const index of table.indexes || []) adapter.exec(index);
  }
  adapter.run("INSERT INTO _meta(key,value) VALUES(?,?)", ["schemaVersion", "legacy-version"]);
  getAdapter = vi.fn(async () => adapter);
  vi.doMock("@/lib/db/driver.js", () => ({ getAdapter }));
  ledger = await import("../../src/lib/requestLedger.js");
});

afterEach(() => {
  adapter?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/db/driver.js");
  vi.doUnmock("next/server");
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/auth/dashboardSession");
});

function tariff(overrides = {}) {
  return {
    provider: "openai", model: "priced-model", contractId: "contract-a",
    basis: "metered", billingMode: "metered", currency: "USD",
    effectiveFrom: "2026-01-01T00:00:00.000Z", evidenceSource: "contract:unit-test",
    inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 4000000,
    ...overrides,
  };
}

async function attribute({ keyId = "key-a", projectId = "project-a", contractId = "contract-a" } = {}) {
  adapter.run("INSERT INTO apiKeys(id,key,createdAt) VALUES(?,?,?)", [keyId, `secret-${keyId}`, TIME]);
  await ledger.setKeyAttribution({ keyId, projectId, contractId });
  return keyId;
}

async function startPricedRequest(overrides = {}) {
  await attribute();
  const price = await ledger.addTariff(tariff(overrides));
  const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
  const attempt = await ledger.startAttempt(request.requestId, {
    provider: price.provider, requestedModel: price.model, fallbackReason: "primary",
  });
  return { price, request, attempt };
}

describe("request ledger usage normalization", () => {
  it("keeps OpenAI cache and reasoning details inside their reported totals", () => {
    expect(ledger.normalizeUsage({
      prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 50 },
    })).toEqual({
      inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400,
      cacheWriteTokens: null, reasoningTokens: 50, usageSource: "reported",
      allowlistedRawUsage: {
        prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    });
  });

  it("accepts Responses API inclusive input/output details without adding them twice", () => {
    expect(ledger.normalizeUsage({
      input_tokens: 100, output_tokens: 30,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens_details: { reasoning_tokens: 20 },
    })).toMatchObject({ inputTokens: 100, outputTokens: 30, cachedInputTokens: 80, reasoningTokens: 20, usageSource: "reported" });
  });

  it.each(["anthropic", "claude"])("adds Anthropic non-inclusive cache reads and writes for %s", (format) => {
    const raw = {
      input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 },
    };
    expect(ledger.normalizeUsage(raw, format)).toEqual({
      inputTokens: 450, outputTokens: 20, cachedInputTokens: 300, cacheWriteTokens: 50,
      reasoningTokens: null, usageSource: "reported", allowlistedRawUsage: raw,
    });
  });

  it("detects Anthropic cache fields even without an explicit format", () => {
    expect(ledger.normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 })).toMatchObject({
      inputTokens: 30, outputTokens: 5, cachedInputTokens: 20, usageSource: "reported",
    });
  });

  it.each(["gemini", "gemini-cli"])("includes Gemini thoughts in output but not a second time in total for %s", (format) => {
    expect(ledger.normalizeUsage({
      promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50,
      cachedContentTokenCount: 400, totalTokenCount: 1250,
    }, format)).toMatchObject({
      inputTokens: 1000, outputTokens: 250, cachedInputTokens: 400,
      reasoningTokens: 50, usageSource: "reported",
    });
  });

  it.each([{ estimated: true }, { source: "estimated" }])("retains native estimate provenance without persisting arbitrary metadata: %j", (provenance) => {
    expect(ledger.normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, ...provenance, secret: "private" })).toMatchObject({
      inputTokens: 10, outputTokens: 5, usageSource: "estimated", allowlistedRawUsage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  it.each([undefined, null, [], "not usage", 10])("does not invent usage from %j", (value) => {
    expect(ledger.normalizeUsage(value)).toEqual({
      inputTokens: null, outputTokens: null, cachedInputTokens: null,
      cacheWriteTokens: null, reasoningTokens: null, usageSource: "unknown", allowlistedRawUsage: {},
    });
  });

  it.each([-1, 1.25, "12", NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, true, null])(
    "rejects malformed token count %s without coercion", (value) => {
      expect(ledger.normalizeUsage({ prompt_tokens: value, completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: value }, completion_tokens_details: { reasoning_tokens: value },
      })).toEqual({ inputTokens: null, outputTokens: 2, cachedInputTokens: null,
        cacheWriteTokens: null, reasoningTokens: null, usageSource: "unknown",
        allowlistedRawUsage: { completion_tokens: 2 },
      });
    },
  );

  it("allowlists numeric usage only and drops content, identifiers, and arbitrary nested metadata", () => {
    expect(ledger.normalizeUsage({
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2, secret: "api-key", audio_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 1, text: "private" },
      cache_creation: { ephemeral_5m_input_tokens: 0, secret: "private" },
      messages: [{ content: "private prompt" }], api_key: "secret", project_id: "forged",
    }).allowlistedRawUsage).toEqual({
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
      cache_creation: { ephemeral_5m_input_tokens: 0 },
    });
  });

  it("keeps reported zero distinct from absent usage and never infers totals from total_tokens", () => {
    expect(ledger.normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 })).toMatchObject({ inputTokens: 0, outputTokens: 0, usageSource: "reported" });
    expect(ledger.normalizeUsage({ total_tokens: 100 })).toMatchObject({ inputTokens: null, outputTokens: null, usageSource: "unknown" });
  });

  it.each([
    [{ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } }, "openai", "inputTokens"],
    [{ prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } }, "openai", "outputTokens"],
    [{ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2, cache_read_input_tokens: 1 }, "anthropic", "inputTokens"],
    [{ promptTokenCount: 1, candidatesTokenCount: Number.MAX_SAFE_INTEGER, thoughtsTokenCount: 1 }, "gemini", "outputTokens"],
  ])("marks impossible subsets and overflowing totals unknown", (usage, format, field) => {
    expect(ledger.normalizeUsage(usage, format)).toMatchObject({ [field]: null, usageSource: "unknown" });
  });
});

describe("integer micro-currency pricing", () => {
  it("prices each non-overlapping cache, write, and reasoning category exactly once", () => {
    const usage = ledger.normalizeUsage({ input_tokens: 500, output_tokens: 200,
      cache_read_input_tokens: 400, cache_creation_input_tokens: 100,
      output_tokens_details: { reasoning_tokens: 50 },
    }, "anthropic");
    expect(ledger.estimateMicros(usage, tariff({ cachedInputMicrosPerMillion: 500000,
      cacheWriteMicrosPerMillion: 3000000, reasoningMicrosPerMillion: 6000000,
    }))).toBe(2400);
  });

  it("rounds once after summing fractional micro-units across categories", () => {
    expect(ledger.estimateMicros(ledger.normalizeUsage({ prompt_tokens: 1, completion_tokens: 1 }),
      tariff({ inputMicrosPerMillion: 250000, outputMicrosPerMillion: 250000 }))).toBe(1);
  });

  it("uses exact integer products beyond floating-point precision and rejects unsafe final amounts", () => {
    const usage = ledger.normalizeUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 });
    expect(ledger.estimateMicros(usage, tariff({ inputMicrosPerMillion: 1000000 }))).toBe(Number.MAX_SAFE_INTEGER);
    expect(ledger.estimateMicros(usage, tariff({ inputMicrosPerMillion: 2000000 }))).toBeNull();
  });

  it.each([null, undefined, { billingMode: "unknown" }])("leaves absent or unknown tariff %j unknown", (snapshot) => {
    expect(ledger.estimateMicros(ledger.normalizeUsage(USAGE), snapshot)).toBeNull();
  });

  it("never turns missing/incomplete usage into a zero charge", () => {
    expect(ledger.estimateMicros(ledger.normalizeUsage({}), tariff())).toBeNull();
    expect(ledger.estimateMicros({ ...ledger.normalizeUsage(USAGE), usageSource: "unknown" }, tariff())).toBeNull();
  });

  it.each([
    [{ prompt_tokens: 1, completion_tokens: 0 }, { inputMicrosPerMillion: undefined }],
    [{ prompt_tokens: 0, completion_tokens: 1 }, { outputMicrosPerMillion: undefined }],
    [{ prompt_tokens: 1, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1 } }, {}],
    [{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1 }, {}],
  ])("requires a tariff for every positive billable category", (raw, rates) => {
    expect(ledger.estimateMicros(ledger.normalizeUsage(raw), tariff(rates))).toBeNull();
  });

  it("prices evidenced five-minute and one-hour cache writes separately without adding the aggregate twice", async () => {
    const price = await ledger.addTariff(tariff({ cacheWriteMicrosPerMillion: 99000000,
      cacheWrite5mMicrosPerMillion: 3000000, cacheWrite1hMicrosPerMillion: 6000000,
    }));
    const usage = ledger.normalizeUsage({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
    }, "anthropic");
    expect(price).toMatchObject({ cacheWrite5mMicrosPerMillion: 3000000, cacheWrite1hMicrosPerMillion: 6000000 });
    expect(ledger.estimateMicros(usage, price)).toBe(660);
  });

  it.each([undefined, { ephemeral_5m_input_tokens: 60 },
    { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 },
  ])("requires complete duration evidence matching aggregate cache writes: %j", (cache_creation) => {
    const usage = ledger.normalizeUsage({ input_tokens: 100, output_tokens: 10,
      cache_creation_input_tokens: 100, cache_creation,
    }, "anthropic");
    expect(ledger.estimateMicros(usage, tariff({ cacheWrite5mMicrosPerMillion: 3000000,
      cacheWrite1hMicrosPerMillion: 6000000,
    }))).toBeNull();
  });

  it("does not require rates for zero categories and uses output pricing when reasoning is not separately priced", () => {
    expect(ledger.estimateMicros(ledger.normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), { billingMode: "metered" })).toBe(0);
    expect(ledger.estimateMicros(ledger.normalizeUsage({ prompt_tokens: 0, completion_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 8 },
    }), tariff())).toBe(40);
  });

  it.each([-1, 0.5, "1000000", Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects malformed positive-category rate %s", (rate) => {
    expect(ledger.estimateMicros(ledger.normalizeUsage(USAGE), tariff({ inputMicrosPerMillion: rate }))).toBeNull();
  });

  it("requires explicit zero-marginal-fee evidence for subscription estimates", () => {
    const usage = ledger.normalizeUsage(USAGE);
    expect(ledger.estimateMicros(usage, tariff({ billingMode: "subscription" }))).toBeNull();
    expect(ledger.estimateMicros(usage, tariff({ billingMode: "subscription", zeroMarginalFee: "true" }))).toBeNull();
    expect(ledger.estimateMicros(usage, tariff({ billingMode: "subscription", zeroMarginalFee: true }))).toBe(0);
    expect(ledger.estimateMicros(ledger.normalizeUsage({}), tariff({ billingMode: "subscription", zeroMarginalFee: true }))).toBeNull();
  });

  it("values subscription reference tokens independently of evidenced zero marginal spend", () => {
    const usage = ledger.normalizeUsage(USAGE);
    const subscription = tariff({ billingMode: "subscription", zeroMarginalFee: true });
    expect(ledger.estimateMicros(usage, subscription)).toBe(0);
    expect(ledger.estimateMicros(usage, { ...subscription, basis: "reference" })).toBe(2800);
  });

  it("keeps local infrastructure cost unknown while allowing a separate API-equivalent reference value", () => {
    const usage = ledger.normalizeUsage(USAGE);
    expect(ledger.estimateMicros(usage, tariff({ billingMode: "local" }))).toBeNull();
    expect(ledger.estimateMicros(usage, tariff({ billingMode: "local", basis: "reference" }))).toBe(2800);
  });
});

describe("additive migration and request lifecycle", () => {
  it("preserves old combos, settings, API keys and usage without importing legacy cost as spend", async () => {
    const models = JSON.stringify([{ model: "old/provider", priority: 1 }]);
    adapter.run("INSERT INTO combos(id,name,models,createdAt,updatedAt) VALUES(?,?,?,?,?)", ["old-combo", "existing", models, TIME, TIME]);
    adapter.run("INSERT INTO settings(id,data) VALUES(1,?)", ['{"existing":true}']);
    adapter.run("INSERT INTO apiKeys(id,key,createdAt) VALUES(?,?,?)", ["old-key", "old-secret", TIME]);
    adapter.run("INSERT INTO usageHistory(timestamp,provider,model,promptTokens,completionTokens,cost) VALUES(?,?,?,?,?,?)", [TIME, "old", "model", 100, 20, 42.5]);
    const tables = ["combos", "settings", "apiKeys", "usageHistory"];
    const before = Object.fromEntries(tables.map((table) => [table, adapter.all(`SELECT * FROM ${table}`)]));
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 0, attempts: 0, totals: [], priceSnapshots: [] });
    for (const table of tables) expect(adapter.all(`SELECT * FROM ${table}`)).toEqual(before[table]);
    expect(adapter.get("SELECT value FROM _meta WHERE key = ?", ["schemaVersion"])).toEqual({ value: "legacy-version" });
    expect(adapter.get("SELECT value FROM _meta WHERE key = ?", ["teleProxyLedgerSchemaVersion"])).toEqual({ value: "1" });
    vi.resetModules();
    const reloaded = await import("../../src/lib/requestLedger.js");
    expect(await reloaded.getLedgerSummary()).toMatchObject({ requests: 0, attempts: 0 });
    for (const table of tables) expect(adapter.all(`SELECT * FROM ${table}`)).toEqual(before[table]);
  });

  it("does not create storage or record anything when explicitly disabled", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    expect(await ledger.startRequest()).toBeNull();
    expect(await ledger.startAttempt("missing")).toBeNull();
    expect(await ledger.finishAttempt("missing")).toBeNull();
    expect(await ledger.finishRequest("missing")).toBeNull();
    expect(await ledger.getRequestAttempts("missing")).toEqual([]);
    expect(await ledger.getLedgerSummary()).toEqual({ enabled: false });
    expect(await ledger.recoverAbandoned()).toEqual({ requests: 0, attempts: 0 });
    expect(await ledger.pruneLedger()).toEqual({ requests: 0, attempts: 0 });
    expect(await ledger.recordDownstreamFirstContent("missing", 1)).toBeNull();
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("records only actual starts with consecutive sequences; duplicate starts and finishes are idempotent", async () => {
    const { request, attempt, price } = await startPricedRequest();
    const first = await ledger.startAttempt(request.requestId, {
      attemptId: attempt.attemptId, provider: "forged-provider", requestedModel: "forged-model", fallbackReason: "retry",
    });
    expect(first).toEqual(attempt);
    expect(await ledger.getRequestAttempts(request.requestId)).toHaveLength(1);
    const ended = await ledger.finishAttempt(attempt.attemptId, { status: "error", errorClass: "rate_limit", usage: USAGE });
    vi.setSystemTime(new Date("2026-10-27T12:00:01.000Z"));
    expect(await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: { prompt_tokens: 999999, completion_tokens: 999999 } })).toEqual(ended);
    const second = await ledger.startAttempt(request.requestId, {
      attemptId: "actual-retry", provider: "openai", requestedModel: "priced-model", fallbackReason: "rate_limit",
    });
    await ledger.finishAttempt(second.attemptId, { status: "success", usage: USAGE });
    const completed = await ledger.finishRequest(request.requestId, { status: "success" });
    expect(completed).toMatchObject({ attemptCount: 2, finalStatus: "success", accountingCompleteness: "complete", totalDurationMs: 1000 });
    vi.setSystemTime(new Date("2026-10-27T12:00:02.000Z"));
    expect(await ledger.finishRequest(request.requestId, { status: "error" })).toEqual(completed);
    expect(await ledger.startAttempt(request.requestId, { attemptId: attempt.attemptId, provider: "forged" })).toEqual(ended);
    expect(await ledger.getRequestAttempts(request.requestId)).toMatchObject([
      { sequence: 1, provider: "openai", requestedModel: "priced-model", status: "error", priceSnapshotId: price.id },
      { sequence: 2, fallbackReason: "rate_limit", status: "success", priceSnapshotId: price.id },
    ]);
    expect(await ledger.getLedgerSummary()).toMatchObject({ requests: 1, attempts: 2,
      coverage: { requestComplete: 1, requestIncomplete: 0 },
      totals: [{ currency: "USD", meteredCostEstimateMicros: 5600, providerReportedChargeMicros: null }],
    });
    await expect(ledger.startAttempt(request.requestId)).rejects.toThrow("terminal");
  });

  it("counts a sequence of concrete account fallback, auth refresh, and provider retries rather than combo candidates", async () => {
    const request = await ledger.startRequest({ resolvedCombo: "combo-with-many-candidates" });
    expect(await ledger.getRequestAttempts(request.requestId)).toEqual([]);
    const dispatches = [
      { attemptId: "dispatch-1", provider: "provider-a", connectionId: "account-a", fallbackReason: "primary" },
      { attemptId: "dispatch-2", provider: "provider-a", connectionId: "account-a", fallbackReason: "auth_refresh" },
      { attemptId: "dispatch-3", provider: "provider-a", connectionId: "account-b", fallbackReason: "account_fallback" },
      { attemptId: "dispatch-4", provider: "provider-b", connectionId: "account-c", fallbackReason: "upstream_error" },
    ];
    for (const fields of dispatches) {
      const attempt = await ledger.startAttempt(request.requestId, { ...fields, requestedModel: "model" });
      await ledger.finishAttempt(attempt.attemptId, { status: "error" });
    }
    const attempts = await ledger.getRequestAttempts(request.requestId);
    expect(attempts.map(({ sequence, provider, fallbackReason }) => ({ sequence, provider, fallbackReason }))).toEqual([
      { sequence: 1, provider: "provider-a", fallbackReason: "primary" },
      { sequence: 2, provider: "provider-a", fallbackReason: "auth_refresh" },
      { sequence: 3, provider: "provider-a", fallbackReason: "account_fallback" },
      { sequence: 4, provider: "provider-b", fallbackReason: "upstream_error" },
    ]);
    expect(attempts[0].connectionPseudonym).toMatch(/^[0-9a-f]{32}$/);
    expect(attempts[1].connectionPseudonym).toBe(attempts[0].connectionPseudonym);
    expect(attempts[2].connectionPseudonym).not.toBe(attempts[0].connectionPseudonym);
    expect(JSON.stringify(attempts)).not.toContain("account-a");
    expect(await ledger.finishRequest(request.requestId, { status: "error" })).toMatchObject({ attemptCount: 4, accountingCompleteness: "incomplete" });
  });

  it("rejects unknown request/attempt IDs and cross-request duplicate attempt IDs without creating phantom attempts", async () => {
    await expect(ledger.startAttempt("missing")).rejects.toThrow("missing or terminal");
    await expect(ledger.finishAttempt("missing")).rejects.toThrow("does not exist");
    await expect(ledger.finishRequest("missing")).rejects.toThrow("does not exist");
    const first = await ledger.startRequest();
    const second = await ledger.startRequest();
    await ledger.startAttempt(first.requestId, { attemptId: "shared-attempt" });
    await expect(ledger.startAttempt(second.requestId, { attemptId: "shared-attempt" })).rejects.toThrow("another request");
    expect(await ledger.getRequestAttempts(second.requestId)).toEqual([]);
    expect(await ledger.finishRequest(second.requestId)).toMatchObject({ attemptCount: 0, accountingCompleteness: "incomplete" });
  });

  it("recovers only older inflight work, preserves terminal evidence, and is idempotent", async () => {
    const { request, attempt } = await startPricedRequest();
    const completed = await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: USAGE });
    const pending = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    vi.setSystemTime(new Date("2026-10-27T12:00:02.000Z"));
    const fresh = await ledger.startRequest();
    const freshAttempt = await ledger.startAttempt(fresh.requestId);
    expect(await ledger.recoverAbandoned({ before: "2026-10-27T12:00:01.000Z" })).toEqual({ requests: 1, attempts: 1 });
    expect(await ledger.getRequestAttempts(request.requestId)).toMatchObject([
      { attemptId: completed.attemptId, status: "success", meteredCostEstimateMicros: 2800 },
      { attemptId: pending.attemptId, status: "abandoned", usageSource: "unknown", costStatus: "unknown", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null },
    ]);
    expect(await ledger.finishRequest(request.requestId, { status: "success" })).toMatchObject({ finalStatus: "abandoned", accountingCompleteness: "incomplete" });
    expect(await ledger.getRequestAttempts(fresh.requestId)).toMatchObject([{ attemptId: freshAttempt.attemptId, status: "inflight", endedAt: null }]);
    expect(await ledger.recoverAbandoned({ before: "2026-10-27T12:00:01.000Z" })).toEqual({ requests: 0, attempts: 0 });
    await expect(ledger.recoverAbandoned({ before: "not-a-date" })).rejects.toThrow("Invalid recovery boundary");
  });

  it("preserves partial usage as unknown and never calls a successful response complete without accounting", async () => {
    const { request, attempt } = await startPricedRequest();
    const result = await ledger.finishAttempt(attempt.attemptId, { status: "cancelled", usage: USAGE,
      usageComplete: false, cancelState: "client_cancelled", upstreamFirstContentMs: 10, downstreamFirstContentMs: -1,
    });
    expect(result).toMatchObject({ inputTokens: 1000, outputTokens: 200, usageSource: "unknown", costStatus: "unknown",
      meteredCostEstimateMicros: null, upstreamFirstContentMs: 10, downstreamFirstContentMs: null, cancelState: "client_cancelled",
    });
    expect(await ledger.finishRequest(request.requestId, { status: "cancelled" })).toMatchObject({ accountingCompleteness: "incomplete" });
  });

  it("marks accounting incomplete after unrecorded dispatch evidence without fabricating an attempt", async () => {
    const { request, attempt } = await startPricedRequest();
    await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: USAGE });
    const result = await ledger.finishRequest(request.requestId, { status: "success", accountingIncomplete: true });
    expect(result).toMatchObject({ finalStatus: "success", attemptCount: 1, accountingCompleteness: "incomplete" });
    expect(await ledger.getRequestAttempts(request.requestId)).toMatchObject([{ attemptId: attempt.attemptId, costStatus: "estimated" }]);
    expect(await ledger.getLedgerSummary()).toMatchObject({ requests: 1, attempts: 1,
      coverage: { usageKnownAttempts: 1, costKnownAttempts: 1, requestComplete: 0, requestIncomplete: 1 },
    });
    expect(await ledger.finishRequest(request.requestId, { status: "success", accountingIncomplete: false })).toEqual(result);
  });
});

describe("authenticated attribution", () => {
  it("uses the existing authenticated opaque key and approved mapping, ignoring arbitrary fields and headers", async () => {
    await attribute();
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a",
      projectId: "forged-project", approvedProjectId: "forged-project", contractId: "forged-contract",
      apiKey: "secret-key-a", sessionId: "private-session", optionalSessionId: "private-session",
      headers: { "x-project-id": "forged-project", "x-api-key": "secret-key-a", "x-session-id": "private-session" },
      clientFamily: "unapproved-client", requestedAlias: "approved-alias",
    });
    expect(request).toMatchObject({ authenticatedKeyId: "key-a", approvedProjectId: "project-a",
      optionalSessionId: null, clientFamily: "unknown", requestedAlias: "approved-alias", environment: "unit-test",
    });
    const attempt = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "model", contractId: "forged-contract" });
    expect(attempt.contractId).toBe("contract-a");
    expect(JSON.stringify(await ledger.getLedgerSummary())).not.toMatch(/forged-project|forged-contract|secret-key-a|private-session/);
  });

  it("snapshots attribution at ingress so later retries retain the original project and contract", async () => {
    await attribute();
    const price = await ledger.addTariff(tariff());
    await ledger.addTariff(tariff({ contractId: "contract-b", inputMicrosPerMillion: 9000000 }));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    expect(request).toMatchObject({ approvedProjectId: "project-a", contractId: "contract-a" });
    await ledger.setKeyAttribution({ keyId: "key-a", projectId: "project-b", contractId: "contract-b" });
    const first = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    expect(first).toMatchObject({ contractId: "contract-a", priceSnapshotId: price.id });
    await ledger.finishAttempt(first.attemptId, { usage: USAGE, status: "error" });
    const retry = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model", fallbackReason: "retry" });
    expect(retry).toMatchObject({ contractId: "contract-a", priceSnapshotId: price.id, sequence: 2 });
    expect(await ledger.startRequest({ authenticatedKeyId: "key-a" })).toMatchObject({ approvedProjectId: "project-b", contractId: "contract-b" });
  });

  it.each(["nonexistent-key", "secret-key-a", "key-a\n", "x".repeat(129), null])("does not authenticate an unrecognized or malformed key ID %j", async (authenticatedKeyId) => {
    await attribute();
    const request = await ledger.startRequest({ authenticatedKeyId, keyId: "key-a", projectId: "project-a" });
    expect(request).toMatchObject({ authenticatedKeyId: null, approvedProjectId: null });
    expect(await ledger.startAttempt(request.requestId)).toMatchObject({ contractId: "unknown" });
  });

  it("keeps keys with similar names and prefixes independently attributed", async () => {
    await attribute();
    await attribute({ keyId: "key-ab", projectId: "project-b", contractId: "contract-b" });
    const a = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const b = await ledger.startRequest({ authenticatedKeyId: "key-ab" });
    expect(a.approvedProjectId).toBe("project-a");
    expect(b.approvedProjectId).toBe("project-b");
    expect(await ledger.startAttempt(a.requestId)).toMatchObject({ contractId: "contract-a" });
    expect(await ledger.startAttempt(b.requestId)).toMatchObject({ contractId: "contract-b" });
  });

  it("validates administrative attribution instead of accepting unknown IDs or arbitrary project text", async () => {
    await expect(ledger.setKeyAttribution({ keyId: "missing", projectId: "project", contractId: "contract" })).rejects.toThrow("Attribution requires");
    await attribute();
    await expect(ledger.setKeyAttribution({ keyId: "key-a", projectId: "project with spaces", contractId: "contract-a" })).rejects.toThrow("Attribution requires");
    expect(await ledger.startRequest({ authenticatedKeyId: "key-a" })).toMatchObject({ approvedProjectId: "project-a" });
  });
});

describe("immutable exact-identity tariff evidence", () => {
  it("selects exact provider/model/contract and never applies alias, other-provider, or other-contract prices", async () => {
    await attribute();
    await ledger.addTariff(tariff());
    await ledger.addTariff(tariff({ provider: "other-provider", model: "other-model" }));
    await ledger.addTariff(tariff({ model: "contract-model", contractId: "other-contract" }));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a", requestedAlias: "priced-model" });
    for (const fields of [
      { provider: "other-provider", requestedModel: "priced-model" },
      { provider: "openai", requestedModel: "other-model" },
      { provider: "openai", requestedModel: "contract-model" },
      { provider: "openai", requestedModel: "alias-only" },
    ]) {
      const attempt = await ledger.startAttempt(request.requestId, fields);
      expect(attempt.priceSnapshotId).toBeNull();
      expect(await ledger.finishAttempt(attempt.attemptId, { usage: USAGE, status: "success" })).toMatchObject({ meteredCostEstimateMicros: null, costStatus: "unknown" });
    }
  });

  it("honors inclusive effective-from and exclusive effective-to, and uses attempt time rather than finish time", async () => {
    await attribute();
    vi.setSystemTime(new Date("2026-10-27T11:00:00.000Z"));
    const old = await ledger.addTariff(tariff({ effectiveTo: TIME }));
    const current = await ledger.addTariff(tariff({ effectiveFrom: TIME, effectiveTo: "2026-10-28T00:00:00.000Z", inputMicrosPerMillion: 3000000 }));
    const future = await ledger.addTariff(tariff({ effectiveFrom: "2026-10-28T00:00:00.000Z", inputMicrosPerMillion: 9000000 }));
    vi.setSystemTime(new Date("2026-10-27T11:59:59.000Z"));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const previous = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    expect(previous.priceSnapshotId).toBe(old.id);
    vi.setSystemTime(new Date(TIME));
    const active = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    expect(active.priceSnapshotId).toBe(current.id);
    vi.setSystemTime(new Date("2026-10-28T00:00:00.000Z"));
    expect(await ledger.finishAttempt(active.attemptId, { status: "success", usage: USAGE })).toMatchObject({ priceSnapshotId: current.id, meteredCostEstimateMicros: 3800 });
    expect(await ledger.finishAttempt(previous.attemptId, { status: "success", usage: USAGE })).toMatchObject({ priceSnapshotId: old.id, meteredCostEstimateMicros: 2800 });
    expect(await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" })).toMatchObject({ priceSnapshotId: future.id });
  });

  it("requires a returned model's own exact tariff and retains the attempt's original contract", async () => {
    const { attempt, price } = await startPricedRequest();
    await ledger.setKeyAttribution({ keyId: "key-a", projectId: "new-project", contractId: "new-contract" });
    await ledger.addTariff(tariff({ model: "returned-model", contractId: "new-contract" }));
    const result = await ledger.finishAttempt(attempt.attemptId, { responseModel: "returned-model", usage: USAGE, status: "success" });
    expect(result).toMatchObject({ contractId: "contract-a", requestedModel: price.model,
      responseModel: "returned-model", priceSnapshotId: null, meteredCostEstimateMicros: null,
    });
  });

  it("prices an explicitly returned model from its own immutable snapshot", async () => {
    await attribute();
    await ledger.addTariff(tariff());
    const returned = await ledger.addTariff(tariff({ model: "returned-model", inputMicrosPerMillion: 7000000 }));
    vi.setSystemTime(new Date("2026-10-27T12:00:01.000Z"));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const attempt = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    expect(await ledger.finishAttempt(attempt.attemptId, { responseModel: "returned-model", usage: USAGE, status: "success" })).toMatchObject({
      responseModel: "returned-model", priceSnapshotId: returned.id, meteredCostEstimateMicros: 7800,
    });
  });

  it("never fills unknown dispatch pricing from a later backdated tariff", async () => {
    await attribute();
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const original = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    const returnedModel = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "alias-model" });
    vi.setSystemTime(new Date("2026-10-27T12:00:01.000Z"));
    const added = await ledger.addTariff(tariff());
    await ledger.addTariff(tariff({ basis: "reference" }));
    expect(await ledger.finishAttempt(original.attemptId, { usage: USAGE, status: "success" })).toMatchObject({
      priceSnapshotId: null, referencePriceSnapshotId: null, meteredCostEstimateMicros: null, apiEquivalentValueMicros: null, costStatus: "unknown",
    });
    expect(await ledger.finishAttempt(returnedModel.attemptId, { responseModel: "priced-model", usage: USAGE })).toMatchObject({
      priceSnapshotId: null, referencePriceSnapshotId: null, meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
    });
    expect(await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" })).toMatchObject({ priceSnapshotId: added.id });
  });

  it("keeps the exact dispatch snapshot when a newer backdated rate is added before completion", async () => {
    const { attempt, price } = await startPricedRequest();
    vi.setSystemTime(new Date("2026-10-27T12:00:01.000Z"));
    await ledger.addTariff(tariff({ effectiveFrom: "2026-10-01T00:00:00.000Z", inputMicrosPerMillion: 9000000 }));
    expect(await ledger.finishAttempt(attempt.attemptId, { usage: USAGE })).toMatchObject({ priceSnapshotId: price.id, meteredCostEstimateMicros: 2800 });
  });

  it("rejects overwriting an existing tariff identity and leaves its original evidence unchanged", async () => {
    const original = await ledger.addTariff(tariff());
    await expect(ledger.addTariff(tariff({ inputMicrosPerMillion: 0, evidenceSource: "forged-replacement" }))).rejects.toThrow();
    const summary = await ledger.getLedgerSummary();
    expect(summary.priceSnapshots).toHaveLength(1);
    expect(summary.priceSnapshots[0]).toMatchObject({ id: original.id, evidenceSource: "contract:unit-test", snapshot: { inputMicrosPerMillion: 2000000 } });
  });

  it.each([
    { provider: "" }, { model: "" }, { contractId: "invalid contract" }, { currency: "usd" },
    { evidenceSource: "" }, { effectiveFrom: "invalid" }, { effectiveTo: "2025-01-01" },
    { inputMicrosPerMillion: -1 }, { outputMicrosPerMillion: 1.5 }, { cacheWriteMicrosPerMillion: "100" },
  ])("rejects invalid tariff evidence %j without inserting a snapshot", async (fields) => {
    await expect(ledger.addTariff(tariff(fields))).rejects.toThrow();
    expect((await ledger.getLedgerSummary()).priceSnapshots).toEqual([]);
  });

  it("does not reuse an expired tariff when no replacement is effective", async () => {
    const { attempt } = await startPricedRequest({ effectiveTo: TIME });
    expect(attempt.priceSnapshotId).toBeNull();
    expect(await ledger.finishAttempt(attempt.attemptId, { usage: USAGE })).toMatchObject({ costStatus: "unknown", meteredCostEstimateMicros: null });
  });

  it("stores local reference value separately from spend and keeps fixed fees out of per-attempt estimates", async () => {
    await attribute();
    await ledger.addTariff(tariff({ billingMode: "local" }));
    const reference = await ledger.addTariff(tariff({ basis: "reference", billingMode: "local" }));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const attempt = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    await ledger.addFixedFee({ billingMode: "local", currency: "USD", amountMicros: 123456,
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", evidenceSource: "invoice:hardware",
    });
    expect(await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: USAGE })).toMatchObject({
      billingMode: "local", meteredCostEstimateMicros: null, apiEquivalentValueMicros: 2800,
      referencePriceSnapshotId: reference.id, costStatus: "unknown",
    });
    await ledger.finishRequest(request.requestId, { status: "success" });
    expect(await ledger.getLedgerSummary()).toMatchObject({
      totals: [{ currency: "USD", meteredCostEstimateMicros: null, apiEquivalentValueMicros: 2800, localInfrastructureAllocationMicros: null }],
      fixedFees: [{ amountMicros: 123456, billingMode: "local", evidenceSource: "invoice:hardware" }],
      coverage: { requestIncomplete: 1 },
    });
  });

  it.each([false, true])("records subscription zero marginal cost only when explicitly evidenced: %s", async (zeroMarginalFee) => {
    const { attempt } = await startPricedRequest({ billingMode: "subscription", zeroMarginalFee });
    expect(await ledger.finishAttempt(attempt.attemptId, { usage: USAGE, status: "success" })).toMatchObject({
      billingMode: "subscription", meteredCostEstimateMicros: zeroMarginalFee ? 0 : null,
      costStatus: zeroMarginalFee ? "estimated" : "unknown", providerReportedChargeMicros: null,
    });
  });

  it.each([
    [{ providerReportedChargeMicros: 50, currency: "USD" }, null],
    [{ providerReportedChargeMicros: 50, currency: "EUR", chargeEvidenceSource: "receipt:a" }, 50],
    [{ providerReportedChargeMicros: -1, currency: "USD", chargeEvidenceSource: "receipt:a" }, null],
    [{ providerReportedChargeMicros: "50", currency: "USD", chargeEvidenceSource: "receipt:a" }, null],
    [{ providerReportedChargeMicros: 50, currency: "eur", chargeEvidenceSource: "receipt:a" }, null],
    [{ providerReportedChargeMicros: 50, chargeEvidenceSource: "receipt:a" }, null],
    [{ providerReportedChargeMicros: 0, currency: "USD", chargeEvidenceSource: "receipt:a" }, 0],
    [{ providerReportedChargeMicros: 50, currency: "USD", chargeEvidenceSource: "receipt:a" }, 50],
  ])("requires valid currency and evidence while preserving independently denominated reported spend", async (fields, expected) => {
    const { attempt } = await startPricedRequest();
    expect(await ledger.finishAttempt(attempt.attemptId, { ...fields, usage: USAGE })).toMatchObject({
      providerReportedChargeMicros: expected, chargeEvidenceSource: expected === null ? null : "receipt:a",
      providerReportedCurrency: expected === null ? null : fields.currency,
      meteredCostEstimateMicros: 2800, costStatus: expected === null ? "estimated" : "reported", currency: "USD",
    });
  });

  it("keeps reported, metered, and reference values in their own currency totals", async () => {
    await attribute();
    await ledger.addTariff(tariff());
    const reference = await ledger.addTariff(tariff({ basis: "reference", currency: "GBP", inputMicrosPerMillion: 3000000 }));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const attempt = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    const result = await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: USAGE,
      providerReportedChargeMicros: 50, currency: "EUR", chargeEvidenceSource: "receipt:eur",
    });
    expect(result).toMatchObject({ currency: "USD", meteredCostEstimateMicros: 2800,
      providerReportedCurrency: "EUR", providerReportedChargeMicros: 50,
      referenceCurrency: "GBP", apiEquivalentValueMicros: 3800, referencePriceSnapshotId: reference.id,
    });
    const { totals } = await ledger.getLedgerSummary();
    expect(totals).toHaveLength(3);
    expect(totals).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: "USD", meteredCostEstimateMicros: 2800, providerReportedChargeMicros: null, apiEquivalentValueMicros: null }),
      expect.objectContaining({ currency: "EUR", meteredCostEstimateMicros: null, providerReportedChargeMicros: 50, apiEquivalentValueMicros: null }),
      expect.objectContaining({ currency: "GBP", meteredCostEstimateMicros: null, providerReportedChargeMicros: null, apiEquivalentValueMicros: 3800 }),
    ]));
  });

  it("keeps invoice and allocation evidence separate, idempotent, immutable, and currency-bound", async () => {
    const { attempt } = await startPricedRequest();
    const invoice = { basis: "invoice", amountMicros: 3000, currency: "USD", evidenceSource: "invoice:123" };
    await expect(ledger.reconcileAttempt(attempt.attemptId, invoice)).rejects.toThrow("completed attempt");
    await ledger.finishAttempt(attempt.attemptId, { usage: USAGE });
    const reconciled = await ledger.reconcileAttempt(attempt.attemptId, invoice);
    expect(reconciled).toMatchObject({ invoiceReconciledSpendMicros: 3000, meteredCostEstimateMicros: 2800, invoiceEvidenceSource: "invoice:123" });
    expect(await ledger.reconcileAttempt(attempt.attemptId, invoice)).toEqual(reconciled);
    await expect(ledger.reconcileAttempt(attempt.attemptId, { ...invoice, amountMicros: 3001 })).rejects.toThrow("immutable");
    await expect(ledger.reconcileAttempt(attempt.attemptId, { ...invoice, evidenceSource: "invoice:other" })).rejects.toThrow("immutable");
    await expect(ledger.reconcileAttempt(attempt.attemptId, { ...invoice, currency: "EUR" })).rejects.toThrow("same currency");
    expect(await ledger.reconcileAttempt(attempt.attemptId, { basis: "subscription_allocation", amountMicros: 25, currency: "USD", evidenceSource: "allocation:123" })).toMatchObject({
      invoiceReconciledSpendMicros: 3000, subscriptionAllocationMicros: 25, meteredCostEstimateMicros: 2800,
      invoiceEvidenceSource: "invoice:123", subscriptionEvidenceSource: "allocation:123", localEvidenceSource: null,
    });
    const local = { basis: "local_allocation", amountMicros: 40, currency: "USD", evidenceSource: "local:hardware" };
    const allocated = await ledger.reconcileAttempt(attempt.attemptId, local);
    expect(allocated).toMatchObject({ subscriptionAllocationMicros: 25, localInfrastructureAllocationMicros: 40,
      invoiceEvidenceSource: "invoice:123", subscriptionEvidenceSource: "allocation:123", localEvidenceSource: "local:hardware",
    });
    expect(await ledger.reconcileAttempt(attempt.attemptId, local)).toEqual(allocated);
    await expect(ledger.reconcileAttempt(attempt.attemptId, { ...local, evidenceSource: "local:other" })).rejects.toThrow("immutable");
  });
});

describe("downstream first-content observations", () => {
  it("records the first downstream observation once even after attempt and request completion", async () => {
    const { request, attempt } = await startPricedRequest();
    await ledger.finishAttempt(attempt.attemptId, { usage: USAGE, status: "success", upstreamFirstContentMs: 12 });
    await ledger.finishRequest(request.requestId, { status: "success" });
    const observed = await ledger.recordDownstreamFirstContent(attempt.attemptId, 25);
    expect(observed).toMatchObject({ downstreamFirstContentMs: 25, upstreamFirstContentMs: 12,
      status: "success", meteredCostEstimateMicros: 2800,
    });
    expect(await ledger.recordDownstreamFirstContent(attempt.attemptId, 99)).toEqual(observed);
    expect(await ledger.finishAttempt(attempt.attemptId, { downstreamFirstContentMs: 999 })).toEqual(observed);
    expect(await ledger.getRequestAttempts(request.requestId)).toMatchObject([{ downstreamFirstContentMs: 25 }]);
  });

  it("preserves a recorded zero and does not replace timing already supplied at completion", async () => {
    const request = await ledger.startRequest();
    const first = await ledger.startAttempt(request.requestId);
    expect(await ledger.recordDownstreamFirstContent(first.attemptId, 0)).toMatchObject({ downstreamFirstContentMs: 0 });
    expect(await ledger.recordDownstreamFirstContent(first.attemptId, 1)).toMatchObject({ downstreamFirstContentMs: 0 });
    expect(await ledger.finishAttempt(first.attemptId, { downstreamFirstContentMs: 500 })).toMatchObject({ downstreamFirstContentMs: 0 });
    const second = await ledger.startAttempt(request.requestId);
    await ledger.finishAttempt(second.attemptId, { downstreamFirstContentMs: 20 });
    expect(await ledger.recordDownstreamFirstContent(second.attemptId, 99)).toMatchObject({ downstreamFirstContentMs: 20 });
  });

  it.each([-1, 1.5, "12", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])("rejects invalid elapsed time %s without modifying storage", async (elapsedMs) => {
    const request = await ledger.startRequest();
    const attempt = await ledger.startAttempt(request.requestId);
    await expect(ledger.recordDownstreamFirstContent(attempt.attemptId, elapsedMs)).rejects.toThrow("Invalid downstream timing observation");
    expect(await ledger.getRequestAttempts(request.requestId)).toMatchObject([{ downstreamFirstContentMs: null }]);
  });

  it.each(["invalid id", "", "id\n", "x".repeat(129), null])("rejects malformed attempt identity %j", async (attemptId) => {
    await expect(ledger.recordDownstreamFirstContent(attemptId, 10)).rejects.toThrow("Invalid downstream timing observation");
    expect(getAdapter).not.toHaveBeenCalled();
  });
});

describe("ledger retention", () => {
  it("prunes only requests terminal before the default 90-day cutoff, retaining inflight work and financial evidence", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await attribute();
    const price = await ledger.addTariff(tariff());
    await ledger.addFixedFee({ billingMode: "subscription", currency: "USD", amountMicros: 1000000,
      periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2027-01-01T00:00:00.000Z", evidenceSource: "invoice:annual",
    });
    const expired = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    for (let index = 0; index < 2; index++) {
      const attempt = await ledger.startAttempt(expired.requestId, { provider: "openai", requestedModel: "priced-model" });
      await ledger.finishAttempt(attempt.attemptId, { usage: USAGE, status: "success" });
    }
    await ledger.finishRequest(expired.requestId, { status: "success" });
    const inflight = await ledger.startRequest();
    await ledger.startAttempt(inflight.requestId);
    const terminalWithInflight = await ledger.startRequest();
    await ledger.startAttempt(terminalWithInflight.requestId);
    await ledger.finishRequest(terminalWithInflight.requestId, { status: "error" });
    const recentlyCompleted = await ledger.startRequest();
    const recentAttempt = await ledger.startAttempt(recentlyCompleted.requestId);
    await ledger.finishAttempt(recentAttempt.attemptId);

    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const boundary = await ledger.startRequest();
    await ledger.finishRequest(boundary.requestId, { status: "success" });
    vi.setSystemTime(new Date(TIME));
    await ledger.finishRequest(recentlyCompleted.requestId, { status: "success" });

    expect(await ledger.pruneLedger()).toEqual({ requests: 1, attempts: 2, cutoff: "2026-07-29T12:00:00.000Z" });
    expect(await ledger.getRequestAttempts(expired.requestId)).toEqual([]);
    expect(await ledger.getRequestAttempts(inflight.requestId)).toMatchObject([{ status: "inflight" }]);
    expect(await ledger.getRequestAttempts(terminalWithInflight.requestId)).toMatchObject([{ status: "inflight" }]);
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 4, attempts: 3,
      priceSnapshots: [{ id: price.id }], fixedFees: [{ evidenceSource: "invoice:annual", amountMicros: 1000000 }],
    });
    expect(summary.recentRequests.map(({ requestId }) => requestId)).toEqual(expect.arrayContaining([
      inflight.requestId, terminalWithInflight.requestId, recentlyCompleted.requestId, boundary.requestId,
    ]));
    expect(await ledger.pruneLedger()).toEqual({ requests: 0, attempts: 0, cutoff: "2026-07-29T12:00:00.000Z" });
    expect(await ledger.startRequest({ authenticatedKeyId: "key-a" })).toMatchObject({ approvedProjectId: "project-a", contractId: "contract-a" });
  });

  it("applies an explicit retention period to completion time rather than receipt time", async () => {
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    const expired = await ledger.startRequest();
    await ledger.finishRequest(expired.requestId);
    const recent = await ledger.startRequest();
    vi.setSystemTime(new Date(TIME));
    await ledger.finishRequest(recent.requestId);
    expect(await ledger.pruneLedger({ retentionDays: 1 })).toEqual({ requests: 1, attempts: 0, cutoff: "2026-10-26T12:00:00.000Z" });
    expect((await ledger.getLedgerSummary()).recentRequests).toMatchObject([{ requestId: recent.requestId }]);
  });

  it.each([0, -1, 1.5, "90", NaN, Infinity, 3651, null])("rejects invalid retention %s before accessing storage", async (retentionDays) => {
    await expect(ledger.pruneLedger({ retentionDays })).rejects.toThrow("Ledger retention must be");
    expect(getAdapter).not.toHaveBeenCalled();
  });
});

async function adminRoute(authenticated = false) {
  const verifyDashboardAuthToken = vi.fn(async () => authenticated);
  const cookieGet = vi.fn(() => authenticated ? { value: "dashboard-session" } : undefined);
  vi.doMock("next/headers", () => ({ cookies: async () => ({ get: cookieGet }) }));
  vi.doMock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken }));
  vi.doMock("next/server", () => ({
    NextResponse: { json: (body, init = {}) => new Response(JSON.stringify(body), {
      ...init, headers: { "content-type": "application/json", ...init.headers },
    }) },
  }));
  return { ...await import("../../src/app/api/usage/ledger/route.js"), verifyDashboardAuthToken, cookieGet };
}

function adminRequest(body, { origin = "http://localhost", headers = {} } = {}) {
  return new Request("http://localhost/api/usage/ledger", { method: "POST",
    headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body),
  });
}

describe("ledger admin route permission boundary", () => {
  it("denies unauthenticated GET and POST regardless of user-provided identity or bearer headers", async () => {
    const { GET, POST, verifyDashboardAuthToken, cookieGet } = await adminRoute();
    const headers = { authorization: "Bearer forged", "x-api-key": "forged", "x-project-id": "admin" };
    const get = await GET(new Request("http://localhost/api/usage/ledger", { headers }));
    const post = await POST(adminRequest({ action: "tariff", ...tariff() }, { headers }));
    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
    expect(await get.json()).toEqual({ error: "Unauthorized" });
    expect(await post.json()).toEqual({ error: "Unauthorized" });
    expect(cookieGet).toHaveBeenCalledWith("auth_token");
    expect(verifyDashboardAuthToken).toHaveBeenCalledWith(undefined);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("allows authenticated same-origin configuration and GET through the real ledger storage", async () => {
    const { GET, POST, verifyDashboardAuthToken } = await adminRoute(true);
    const post = await POST(adminRequest({ action: "tariff", ...tariff() }));
    expect(post.status).toBe(201);
    const saved = await post.json();
    expect(saved).toMatchObject({ provider: "openai", model: "priced-model", contractId: "contract-a", inputMicrosPerMillion: 2000000 });
    const response = await GET(new Request("http://localhost/api/usage/ledger"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ enabled: true, priceSnapshots: [{ id: saved.id, snapshot: { inputMicrosPerMillion: 2000000 } }] });
    expect(verifyDashboardAuthToken).toHaveBeenCalledWith("dashboard-session");
  });

  it.each([
    ["cached", { prompt_tokens_details: { cached_tokens: null } }],
    ["cached", { prompt_tokens_details: { cached_tokens: "400" } }],
    ["reasoning", { completion_tokens_details: { reasoning_tokens: null } }],
    ["reasoning", { completion_tokens_details: { reasoning_tokens: -1 } }],
  ])("serves valid aggregates with unknown pricing and persisted incomplete coverage for malformed %s subsets: %j", async (_category, details) => {
    await attribute();
    const price = await ledger.addTariff(tariff());
    const reference = await ledger.addTariff(tariff({ basis: "reference" }));
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a" });
    const attempt = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "priced-model" });
    await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: { ...USAGE, ...details } });
    await ledger.finishRequest(request.requestId, { status: "success" });

    const { GET } = await adminRoute(true);
    const drilldown = await GET(new Request(`http://localhost/api/usage/ledger?requestId=${request.requestId}`));
    expect(drilldown.status).toBe(200);
    const { attempts } = await drilldown.json();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptId: attempt.attemptId, status: "success",
      inputTokens: 1000, outputTokens: 200, cachedInputTokens: null, reasoningTokens: null,
      usageSource: "unknown", costStatus: "unknown", allowlistedRawUsage: USAGE,
      priceSnapshotId: price.id, referencePriceSnapshotId: reference.id,
      meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
    });

    const response = await GET(new Request("http://localhost/api/usage/ledger"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requests: 1, attempts: 1,
      coverage: { usageKnownAttempts: 0, usageUnknownAttempts: 1, costKnownAttempts: 0,
        costUnknownAttempts: 1, requestComplete: 0, requestIncomplete: 1 },
      totals: [{ currency: "USD", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null }],
      recentRequests: [{ requestId: request.requestId, finalStatus: "success", accountingCompleteness: "incomplete" }],
    });
  });

  it("rejects cross-origin writes even for an authenticated dashboard session", async () => {
    const { POST } = await adminRoute(true);
    const response = await POST(adminRequest({ action: "tariff", ...tariff() }, { origin: "https://attacker.example" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden origin" });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("returns disabled state to authenticated readers and disallows disabled writes", async () => {
    const { GET, POST } = await adminRoute(true);
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    const get = await GET(new Request("http://localhost/api/usage/ledger"));
    expect(await get.json()).toEqual({ enabled: false });
    const post = await POST(adminRequest({ action: "tariff", ...tariff() }));
    expect(post.status).toBe(404);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("serves ordered request attempts and bounds invalid date/request queries", async () => {
    const { request, attempt } = await startPricedRequest();
    await ledger.finishAttempt(attempt.attemptId, { usage: USAGE });
    const { GET } = await adminRoute(true);
    const response = await GET(new Request(`http://localhost/api/usage/ledger?requestId=${request.requestId}`));
    expect(await response.json()).toMatchObject({ attempts: [{ attemptId: attempt.attemptId, sequence: 1, meteredCostEstimateMicros: 2800 }] });
    expect((await GET(new Request("http://localhost/api/usage/ledger?requestId=invalid%20id"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/usage/ledger?from=invalid"))).status).toBe(400);
  });
});

describe("ledger token views route", () => {
  it("requires dashboard authentication before reading the ledger", async () => {
    const { GET, verifyDashboardAuthToken } = await adminRoute();
    const response = await GET(new Request("http://localhost/api/usage/ledger?view=token-views", {
      headers: { authorization: "Bearer forged", "x-api-key": "forged", "x-project-id": "project-a" },
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(verifyDashboardAuthToken).toHaveBeenCalledWith(undefined);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it("serves authenticated persisted cohort counts and token coverage with no-store", async () => {
    await attribute();
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a", resolvedCombo: "combo-a" });
    const known = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(known.attemptId, { usage: { prompt_tokens: 0, completion_tokens: 4 } });
    const unknown = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(unknown.attemptId, { usage: {} });
    await ledger.finishRequest(request.requestId, { status: "success" });
    await ledger.startRequest({ resolvedCombo: "combo-b" });
    const { GET, verifyDashboardAuthToken } = await adminRoute(true);
    const response = await GET(new Request(`http://localhost/api/usage/ledger?view=token-views&from=${TIME}&to=${TIME}&limit=1`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    const row = { requests: 1, incompleteRequests: 1, attempts: 2, reportedAttempts: 1,
      estimatedAttempts: 0, unknownAttempts: 1, inputTokens: 0, outputTokens: 4 };
    expect(result).toMatchObject({ enabled: true, from: TIME, to: TIME, limit: 1,
      combos: { rows: [{ id: "combo-a", ...row }], truncated: true },
      projects: { truncated: true } });
    expect(JSON.stringify(result)).not.toContain("secret-key-a");
    expect(verifyDashboardAuthToken).toHaveBeenCalledWith("dashboard-session");
  });

  it("rejects invalid ranges and returns disabled state without storage access", async () => {
    const { GET } = await adminRoute(true);
    const invalid = await GET(new Request("http://localhost/api/usage/ledger?view=token-views&from=invalid"));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid ledger time range" });
    expect(getAdapter).not.toHaveBeenCalled();
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    const disabled = await GET(new Request("http://localhost/api/usage/ledger?view=token-views"));
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ enabled: false });
    expect(getAdapter).not.toHaveBeenCalled();
  });
});

describe("bounded ledger token views", () => {
  it("attributes request cohorts without multiplying requests or turning unknown usage into zero", async () => {
    await attribute();
    const request = await ledger.startRequest({ authenticatedKeyId: "key-a", resolvedCombo: "combo-a" });
    const reported = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(reported.attemptId, { usage: { prompt_tokens: 10, completion_tokens: 0 } });
    const estimated = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(estimated.attemptId, { usage: { prompt_tokens: 3, completion_tokens: 2, estimated: true } });
    const unknown = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(unknown.attemptId, { usage: { prompt_tokens: 99 } });
    await ledger.finishRequest(request.requestId, { status: "success" });
    await ledger.setKeyAttribution({ keyId: "key-a", projectId: "project-b", contractId: "contract-a" });
    await ledger.startRequest({ authenticatedKeyId: "key-a", resolvedCombo: "combo-b" });
    const unassigned = await ledger.startRequest({ authenticatedKeyId: "not-an-existing-key" });
    const unassignedAttempt = await ledger.startAttempt(unassigned.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(unassignedAttempt.attemptId, { usage: { prompt_tokens: 0, completion_tokens: 0 } });

    const views = await ledger.getLedgerTokenViews({ from: TIME, to: TIME });
    const row = { requests: 1, incompleteRequests: 1, attempts: 3, reportedAttempts: 1,
      estimatedAttempts: 1, unknownAttempts: 1, inputTokens: 13, outputTokens: 2 };
    expect(views.combos.rows.find(item => item.id === "combo-a")).toEqual({ id: "combo-a", ...row });
    expect(views.projects.rows.find(item => item.id === "project-a")).toEqual({ id: "project-a", ...row });
    expect(views.projects.rows.find(item => item.id === "project-b")).toMatchObject({ requests: 1, attempts: 0, inputTokens: null, outputTokens: null });
    expect(views.projects.rows.find(item => item.id === null)).toMatchObject({ requests: 1, attempts: 1, inputTokens: 0, outputTokens: 0 });
    expect(JSON.stringify(views)).not.toContain("secret-key-a");
    expect(views.combos.truncated).toBe(false);
    expect(views.projects.truncated).toBe(false);
  });

  it("includes later attempts for in-range requests and marks limited groups as truncated", async () => {
    const first = await ledger.startRequest({ resolvedCombo: "a" });
    await ledger.startRequest({ resolvedCombo: "b" });
    vi.setSystemTime(new Date("2026-10-27T12:01:00.000Z"));
    const attempt = await ledger.startAttempt(first.requestId, { provider: "openai", requestedModel: "m" });
    await ledger.finishAttempt(attempt.attemptId, { usage: { prompt_tokens: 5, completion_tokens: 1 } });
    await ledger.startRequest({ resolvedCombo: "excluded" });
    const views = await ledger.getLedgerTokenViews({ from: TIME, to: TIME, limit: 1 });
    expect(views).toMatchObject({ from: TIME, to: TIME, limit: 1,
      combos: { truncated: true, rows: [{ id: "a", requests: 1, attempts: 1, inputTokens: 5, outputTokens: 1 }] },
      projects: { truncated: false, rows: [{ id: null, requests: 2, attempts: 1 }] } });
    await expect(ledger.getLedgerTokenViews({ from: "invalid" })).rejects.toThrow("Invalid ledger time range");
    await expect(ledger.getLedgerTokenViews({ from: TIME, to: "2026-01-01" })).rejects.toThrow("Invalid ledger time range");
  });

  it("returns null rather than an unsafe token sum and preserves feature-off behavior", async () => {
    const request = await ledger.startRequest({ resolvedCombo: "large" });
    for (const count of [Number.MAX_SAFE_INTEGER, 1]) {
      const attempt = await ledger.startAttempt(request.requestId, { provider: "openai", requestedModel: "m" });
      await ledger.finishAttempt(attempt.attemptId, { usage: { prompt_tokens: count, completion_tokens: 0 } });
    }
    const views = await ledger.getLedgerTokenViews();
    expect(views.combos.rows[0]).toMatchObject({ id: "large", inputTokens: null, outputTokens: 0, reportedAttempts: 2 });
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    expect(await ledger.getLedgerTokenViews()).toEqual({ enabled: false });
  });
});
