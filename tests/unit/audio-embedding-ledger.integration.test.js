import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the collector and native network boundary are replaced; routes and DB stay real.
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    export(_spans, callback) { callback({ code: 0 }); }
    shutdown() { return Promise.resolve(); }
  },
}));

const embeddingUrl = "http://127.0.0.1:18881/v1/embeddings";
const transcriptionUrl = "http://127.0.0.1:18882/v1/audio/transcriptions";
const embeddingModel = "selfhosted-embedding/embedding";
const transcriptionModel = "selfhosted-stt/whisper-1";
const input = "Synthetic embedding input, not ledger metadata.";
const prompt = "Synthetic transcription prompt, not ledger metadata.";
const audio = new Uint8Array([82, 73, 70, 70, 7, 8, 9, 10]);
const embeddingResult = {
  object: "list",
  model: "embedding",
  data: [{ object: "embedding", index: 0, embedding: [0.125, -0.25] }],
  usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
};
const transcriptionResult = { text: "Synthetic transcript, not ledger metadata." };
let directory, database, repositories, ledger, telemetry, routes, network, key;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tele-audio-embedding-ingress-"));
  vi.stubEnv("DATA_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
  vi.stubEnv("TELE_PROXY_ENABLED", "1");
  vi.stubEnv("TELE_PROXY_ENVIRONMENT", "test");
  vi.stubEnv("TELE_PROXY_PSEUDONYM_SECRET", "synthetic-audio-embedding-pseudonym-secret");
  vi.stubEnv("TELE_PROXY_LOG_FILE", "");
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:4318/v1/traces");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("no_proxy", "*");
  vi.resetModules();
  delete globalThis._dbAdapter;
  delete globalThis[Symbol.for("tele-proxy.initialization")];
  network = vi.fn(async (url) => {
    if (String(url) === embeddingUrl) return Response.json(embeddingResult);
    if (String(url) === transcriptionUrl) return Response.json(transcriptionResult);
    throw new Error(`Unexpected network request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", network);
  await import("../../open-sse/utils/proxyFetch.js");
  repositories = await import("@/lib/db/index.js");
  await repositories.updateSettings({ requireApiKey: true, comboStrategy: "fallback", comboStrategies: {} });
  await repositories.createProviderConnection({
    provider: "selfhosted-embedding", authType: "apikey", name: "synthetic embedding upstream", apiKey: "synthetic-embedding-key",
    // The embeddings adapter appends /embeddings to the OpenAI base URL.
    providerSpecificData: { baseUrl: "http://127.0.0.1:18881/v1" },
  });
  await repositories.createProviderConnection({
    provider: "selfhosted-stt", authType: "apikey", name: "synthetic transcription upstream", apiKey: "synthetic-stt-key",
    // STT instead takes the full multipart transcription endpoint.
    providerSpecificData: { baseUrl: transcriptionUrl },
  });
  key = await repositories.createApiKey("audio embedding ingress fixture", "synthetic-audio-embedding-machine");
  ledger = await import("@/lib/requestLedger.js");
  telemetry = await import("@/lib/gatewayTelemetry.js");
  database = await (await import("@/lib/db/driver.js")).getAdapter();
  routes = {
    embeddings: await import("../../src/app/api/v1/embeddings/route.js"),
    stt: await import("../../src/app/api/v1/audio/transcriptions/route.js"),
  };
});

afterEach(async () => {
  await telemetry?.shutdownTelemetry({ reset: true });
  database?.close?.();
  delete globalThis._dbAdapter;
  delete globalThis[Symbol.for("tele-proxy.initialization")];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = database = repositories = ledger = telemetry = routes = network = key = undefined;
});

function embeddingRequest(model = embeddingModel, value = input) {
  return new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model, input: value }),
  });
}

function transcriptionRequest(model = transcriptionModel, includeFile = true) {
  const body = new FormData();
  body.append("model", model);
  if (includeFile) body.append("file", new Blob([audio], { type: "audio/wav" }), "synthetic.wav");
  body.append("language", "en");
  body.append("prompt", prompt);
  body.append("response_format", "json");
  body.append("temperature", "0");
  return new Request("http://localhost/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key.key}` }, body,
  });
}

async function assertWire(kind) {
  expect(network).toHaveBeenCalledTimes(1);
  const [url, options] = network.mock.calls[0];
  expect(String(url)).toBe(kind === "embeddings" ? embeddingUrl : transcriptionUrl);
  expect(options.method).toBe("POST");
  expect(new Headers(options.headers).get("authorization")).toBe(
    kind === "embeddings" ? "Bearer synthetic-embedding-key" : "Bearer synthetic-stt-key",
  );
  if (kind === "embeddings") {
    expect(JSON.parse(options.body)).toEqual({ model: "embedding", input, encoding_format: "float" });
  } else {
    expect(options.body).toBeInstanceOf(FormData);
    expect([...options.body.keys()]).toEqual(["file", "model", "language", "prompt", "response_format", "temperature"]);
    expect(options.body.get("model")).toBe("whisper-1");
    expect(options.body.get("language")).toBe("en");
    expect(options.body.get("prompt")).toBe(prompt);
    expect(options.body.get("response_format")).toBe("json");
    expect(options.body.get("temperature")).toBe("0");
    const file = options.body.get("file");
    expect(file.name).toBe("synthetic.wav");
    expect(file.type).toBe("audio/wav");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  }
}

describe.sequential("real direct audio and embedding route accounting", () => {
  it("records one actual embedding inference send with explicit upstream token usage", async () => {
    const response = await routes.embeddings.POST(embeddingRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(embeddingResult);
    await assertWire("embeddings");
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: {
      usageKnownAttempts: 1, usageUnknownAttempts: 0, costKnownAttempts: 0, costUnknownAttempts: 1,
      requestComplete: 0, requestIncomplete: 1,
    } });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({
      authenticatedKeyId: key.id, requestedAlias: embeddingModel, resolvedCombo: null,
      policyAppliedStatus: "off", finalStatus: "success", attemptCount: 1, accountingCompleteness: "incomplete",
    });
    expect(entry.completedAt).toEqual(expect.any(String));
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sequence: 1, provider: "selfhosted-embedding", requestedModel: "embedding", status: "success",
      usageSource: "reported", inputTokens: 7, outputTokens: 0,
      allowlistedRawUsage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
      costStatus: "unknown", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
      providerReportedChargeMicros: null,
    });
    expect(attempts[0].endedAt).toEqual(expect.any(String));
    expect(JSON.stringify({ summary, attempts })).not.toContain(input);
  });

  it("recognizes protocol-complete embedding prompt and total usage without output fields", async () => {
    const result = { ...embeddingResult, usage: { prompt_tokens: 100, total_tokens: 100 } };
    network.mockImplementation(async (url) => {
      if (String(url) !== embeddingUrl) throw new Error(`Unexpected network request: ${String(url)}`);
      return Response.json(result);
    });
    const response = await routes.embeddings.POST(embeddingRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    await assertWire("embeddings");
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: {
      usageKnownAttempts: 1, usageUnknownAttempts: 0, costKnownAttempts: 0, costUnknownAttempts: 1,
    } });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ requestedAlias: embeddingModel, resolvedCombo: null, finalStatus: "success", attemptCount: 1 });
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: "selfhosted-embedding", requestedModel: "embedding", status: "success",
      usageSource: "reported", inputTokens: 100, outputTokens: 0,
      allowlistedRawUsage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
      costStatus: "unknown", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
      providerReportedChargeMicros: null,
    });
  });

  it.each([
    ["missing", undefined, null, {}],
    ["inconsistent total", { prompt_tokens: 100, total_tokens: 101 }, 100, { prompt_tokens: 100, total_tokens: 101 }],
  ])("keeps %s embedding usage unknown without inventing output tokens", async (_label, usage, inputTokens, rawUsage) => {
    const { usage: _originalUsage, ...result } = embeddingResult;
    if (usage !== undefined) result.usage = usage;
    network.mockImplementation(async (url) => {
      if (String(url) !== embeddingUrl) throw new Error(`Unexpected network request: ${String(url)}`);
      return Response.json(result);
    });
    const response = await routes.embeddings.POST(embeddingRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    await assertWire("embeddings");
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: {
      usageKnownAttempts: 0, usageUnknownAttempts: 1, costKnownAttempts: 0, costUnknownAttempts: 1,
    } });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ requestedAlias: embeddingModel, resolvedCombo: null, finalStatus: "success", attemptCount: 1 });
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: "selfhosted-embedding", requestedModel: "embedding", status: "success",
      usageSource: "unknown", inputTokens, outputTokens: null,
      costStatus: "unknown", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
      providerReportedChargeMicros: null,
    });
    expect(attempts[0].allowlistedRawUsage).toEqual(rawUsage);
  });

  it("preserves multipart STT and records one actual inference send with unknown usage and cost", async () => {
    const response = await routes.stt.POST(transcriptionRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(transcriptionResult);
    await assertWire("stt");
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: {
      usageKnownAttempts: 0, usageUnknownAttempts: 1, costKnownAttempts: 0, costUnknownAttempts: 1,
      requestComplete: 0, requestIncomplete: 1,
    } });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({
      authenticatedKeyId: key.id, requestedAlias: transcriptionModel, resolvedCombo: null,
      policyAppliedStatus: "off", finalStatus: "success", attemptCount: 1, accountingCompleteness: "incomplete",
    });
    expect(entry.completedAt).toEqual(expect.any(String));
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sequence: 1, provider: "selfhosted-stt", requestedModel: "whisper-1", status: "success",
      usageSource: "unknown", inputTokens: null, outputTokens: null, allowlistedRawUsage: {},
      costStatus: "unknown", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
      providerReportedChargeMicros: null,
    });
    expect(attempts[0].endedAt).toEqual(expect.any(String));
    const persisted = JSON.stringify({ summary, attempts });
    expect(persisted).not.toContain(prompt);
    expect(persisted).not.toContain(transcriptionResult.text);
    expect(persisted).not.toContain("synthetic.wav");
  });

  it("does not count rejected embedding input as a physical send", async () => {
    const response = await routes.embeddings.POST(embeddingRequest(embeddingModel, 3));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("input must be a string or array of strings");
    expect(network).not.toHaveBeenCalled();
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 0 });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ requestedAlias: embeddingModel, finalStatus: "error", attemptCount: 0 });
    expect(await ledger.getRequestAttempts(entry.requestId)).toEqual([]);
  });

  it.each(["embeddings", "stt"])("rejects missing %s input without sending upstream", async (kind) => {
    const request = kind === "embeddings" ? embeddingRequest(embeddingModel, null) : transcriptionRequest(transcriptionModel, false);
    const response = await routes[kind].POST(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(`Missing required field: ${kind === "embeddings" ? "input" : "file"}`);
    expect(network).not.toHaveBeenCalled();
    expect(await ledger.getLedgerSummary()).toMatchObject({ requests: 0, attempts: 0 });
  });

  it.each(["embeddings", "stt"])("keeps combo expansion unsupported for %s with zero sends", async (kind) => {
    const combo = await repositories.createCombo({
      name: `unsupported-${kind}-combo`, models: [kind === "embeddings" ? embeddingModel : transcriptionModel],
    });
    const response = await routes[kind].POST(kind === "embeddings" ? embeddingRequest(combo.name) : transcriptionRequest(combo.name));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Invalid model format");
    expect(network).not.toHaveBeenCalled();
    expect(await ledger.getLedgerSummary()).toMatchObject({ requests: 0, attempts: 0 });
  });

  it.each(["embeddings", "stt"])("preserves the direct %s response and wire request when accounting is off", async (kind) => {
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    const response = await routes[kind].POST(kind === "embeddings" ? embeddingRequest() : transcriptionRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(kind === "embeddings" ? embeddingResult : transcriptionResult);
    await assertWire(kind);
    expect(await ledger.getLedgerSummary()).toEqual({ enabled: false });
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    expect(await ledger.getLedgerSummary()).toMatchObject({ requests: 0, attempts: 0 });
  });
});
