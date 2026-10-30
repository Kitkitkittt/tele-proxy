import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

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

// Transform the route graph before Vitest starts the per-test hook timer. The
// warmed modules are discarded; each test still gets its own database and env.
const warmDirectory = await mkdtemp(join(tmpdir(), "tele-audio-route-warm-"));
try {
  vi.stubEnv("DATA_DIR", join(warmDirectory, "state"));
  vi.stubEnv("HOME", join(warmDirectory, "home"));
  vi.stubEnv("TELE_PROXY_ENABLED", "0");
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network request during route import"); });
  await import("../../src/app/api/v1/embeddings/route.js");
  await import("../../src/app/api/v1/audio/transcriptions/route.js");
} finally {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  delete globalThis._dbAdapter;
  delete globalThis[Symbol.for("tele-proxy.initialization")];
  await rm(warmDirectory, { recursive: true, force: true });
}

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

  it("persists the failed proxy dispatch and successful direct retry as separate attempts", async () => {
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:18883");
    network.mockImplementation(async (url, options) => {
      if (String(url) !== embeddingUrl) throw new Error(`Unexpected network request: ${String(url)}`);
      if (options.dispatcher) throw new Error("synthetic proxy failure");
      return Response.json(embeddingResult);
    });

    const response = await routes.embeddings.POST(embeddingRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(embeddingResult);
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([embeddingUrl, embeddingUrl]);
    expect(network.mock.calls[0][1].dispatcher).toBeDefined();
    expect(network.mock.calls[1][1].dispatcher).toBeUndefined();

    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 2 });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ requestedAlias: embeddingModel, finalStatus: "success", attemptCount: 2 });
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(network.mock.calls.length);
    expect(attempts).toMatchObject([
      { sequence: 1, provider: "selfhosted-embedding", requestedModel: "embedding", status: "error", fallbackReason: "primary" },
      { sequence: 2, provider: "selfhosted-embedding", requestedModel: "embedding", status: "success", fallbackReason: "upstream_error", inputTokens: 7 },
    ]);
    expect(attempts.every((attempt) => typeof attempt.endedAt === "string")).toBe(true);
  });

  it("persists separate direct and TLS retry attempts", async () => {
    vi.stubEnv("STRICT_SSL", "");
    network.mockImplementation(async (url, options) => {
      if (String(url) !== embeddingUrl) throw new Error(`Unexpected network request: ${String(url)}`);
      if (!options.dispatcher) throw Object.assign(new Error("synthetic certificate failure"), { code: "CERT_HAS_EXPIRED" });
      return Response.json(embeddingResult);
    });
    const response = await routes.embeddings.POST(embeddingRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(embeddingResult);
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][1].dispatcher).toBeUndefined();
    expect(network.mock.calls[1][1].dispatcher).toBeDefined();
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 2 });
    expect(await ledger.getRequestAttempts(summary.recentRequests[0].requestId)).toMatchObject([
      { sequence: 1, status: "error" }, { sequence: 2, status: "success" },
    ]);
  });
  it.each([401, 403])("records embedding %i refresh redispatch separately from refresh traffic", async (status) => {
    await repositories.createProviderConnection({
      provider: "openrouter", authType: "oauth", name: "synthetic refresh embedding", accessToken: "synthetic-old-token",
      refreshToken: "synthetic-refresh-token", providerSpecificData: { baseUrl: "http://127.0.0.1:18881/v1" },
    });
    const { getExecutor } = await import("../../open-sse/executors/index.js");
    const executor = getExecutor("openrouter");
    const refresh = vi.spyOn(executor, "refreshCredentials").mockResolvedValue({ accessToken: "synthetic-new-token" });
    const sends = [];
    network.mockImplementation(async (url, options) => {
      sends.push({ url: String(url), authorization: options.headers.Authorization });
      return sends.length === 1 ? Response.json({ error: "expired" }, { status }) : Response.json(embeddingResult);
    });
    const response = await routes.embeddings.POST(embeddingRequest("openrouter/embedding"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(embeddingResult);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sends).toEqual([
      { url: "https://openrouter.ai/api/v1/embeddings", authorization: "Bearer synthetic-old-token" },
      { url: "https://openrouter.ai/api/v1/embeddings", authorization: "Bearer synthetic-new-token" },
    ]);
    const summary = await ledger.getLedgerSummary();
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ finalStatus: "success", attemptCount: 2 });
    expect(await ledger.getRequestAttempts(entry.requestId)).toMatchObject([
      { sequence: 1, provider: "openrouter", status: "error" },
      { sequence: 2, provider: "openrouter", status: "success", inputTokens: 7 },
    ]);
  });

  it("records active embedding cancellation without a post-cancellation retry", async () => {
    let onAbort;
    network.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      options.signal.addEventListener("abort", onAbort, { once: true });
    }));
    const controller = new AbortController();
    const pending = routes.embeddings.POST(new Request(embeddingRequest(), { signal: controller.signal }));
    while (!onAbort) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const response = await pending;
    expect(response.ok).toBe(false);
    expect(network).toHaveBeenCalledTimes(1);
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1 });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ finalStatus: "cancelled", attemptCount: 1 });
    expect(await ledger.getRequestAttempts(entry.requestId)).toMatchObject([
      { sequence: 1, status: "cancelled" },
    ]);
  });

  it("persists both physical video creation dispatches after proxy failure", async () => {
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:18883");
    network.mockImplementation(async (url, options) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/videos");
      if (options.dispatcher) throw new Error("synthetic proxy failure");
      return Response.json({ id: "job-1", status: "pending" });
    });
    const { withGatewayRequest, executeGatewayProvider } = await import("@/lib/teleProxy.js");
    const { handleVideoProxyCore } = await import("../../open-sse/handlers/videoCore.js");
    const request = new Request("http://localhost/v1/videos/generations", { method: "POST" });
    const response = await withGatewayRequest({ request, body: {}, target: "openrouter/google/veo-3.1", requestedAlias: "openrouter/google/veo-3.1", authenticatedKey: key.key }, async () => {
      const result = await executeGatewayProvider({ provider: "openrouter", model: "google/veo-3.1" }, () => handleVideoProxyCore({
        provider: "openrouter", action: "generations", rawBody: '{"model":"google/veo-3.1","prompt":"a paper boat"}',
        contentType: "application/json", credentials: { apiKey: "synthetic-video-key" },
      }));
      return result.response;
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "job-1", status: "pending" });
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][1].dispatcher).toBeDefined();
    expect(network.mock.calls[1][1].dispatcher).toBeUndefined();
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 2 });
    expect(await ledger.getRequestAttempts(summary.recentRequests[0].requestId)).toMatchObject([
      { sequence: 1, provider: "openrouter", requestedModel: "google/veo-3.1", status: "error" },
      { sequence: 2, provider: "openrouter", requestedModel: "google/veo-3.1", status: "success" },
    ]);
  });

  it("persists no attempt for an embedding request cancelled before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request(embeddingRequest(), { signal: controller.signal });
    const response = await routes.embeddings.POST(request);
    expect(response.ok).toBe(false);
    await response.text();
    expect(network).not.toHaveBeenCalled();
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 0 });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ requestedAlias: embeddingModel, attemptCount: 0 });
    expect(await ledger.getRequestAttempts(entry.requestId)).toEqual([]);
  });

  it("counts transcription submission but not upload or polling", async () => {
    const { withGatewayRequest, executeGatewayProvider } = await import("@/lib/teleProxy.js");
    const { handleSttCore } = await import("../../open-sse/handlers/sttCore.js");
    const calls = [];
    network.mockImplementation(async (url) => {
      calls.push(String(url));
      if (String(url) === "https://api.assemblyai.com/v2/upload") return Response.json({ upload_url: "https://upload.invalid/audio" });
      if (String(url) === "http://127.0.0.1:18884/transcript") return Response.json({ id: "job-1" });
      if (String(url) === "http://127.0.0.1:18884/transcript/job-1") return Response.json({ status: "completed", text: "hello" });
      throw new Error(`Unexpected network request: ${String(url)}`);
    });
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => { queueMicrotask(callback); return 0; });
    try {
      const formData = new FormData();
      formData.append("file", new Blob([audio], { type: "audio/wav" }), "synthetic.wav");
      const request = new Request("http://localhost/v1/audio/transcriptions", { method: "POST" });
      const response = await withGatewayRequest({ request, body: {}, target: "synthetic/stt", requestedAlias: "synthetic/stt", authenticatedKey: key.key }, async () => {
        const result = await executeGatewayProvider({ provider: "synthetic", model: "stt" }, () => handleSttCore({
          provider: "synthetic", model: "stt", formData, credentials: {},
          sttConfig: { format: "assemblyai", authType: "none", baseUrl: "http://127.0.0.1:18884/transcript" },
        }));
        return result.response;
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "hello" });
      expect(calls).toEqual([
        "https://api.assemblyai.com/v2/upload", "http://127.0.0.1:18884/transcript", "http://127.0.0.1:18884/transcript/job-1",
      ]);
      const summary = await ledger.getLedgerSummary();
      expect(summary).toMatchObject({ requests: 1, attempts: 1 });
      expect(await ledger.getRequestAttempts(summary.recentRequests[0].requestId)).toMatchObject([
        { sequence: 1, provider: "synthetic", requestedModel: "stt", status: "success" },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("records the Codex HTTPS direct fallback after a failed proxy dispatch", async () => {
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:18883");
    const url = "https://stt.invalid/v1/audio/transcriptions";
    network.mockImplementation(async (target, options) => {
      expect(String(target)).toBe(url);
      expect(options.dispatcher).toBeDefined();
      throw new Error("synthetic proxy failure");
    });
    const sends = [];
    vi.spyOn(https, "request").mockImplementation((target, options, callback) => {
      sends.push({ target: String(target), method: options.method });
      const req = new EventEmitter();
      req.end = () => {
        const res = Readable.from([Buffer.from('{"text":"hello"}')]);
        res.headers = { "content-type": "application/json" };
        res.statusCode = 200;
        queueMicrotask(() => callback(res));
      };
      return req;
    });
    try {
      const { withGatewayRequest, executeGatewayProvider } = await import("@/lib/teleProxy.js");
      const { withGenerationDispatch } = await import("../../open-sse/services/dispatchContext.js");
      const { codexHttpFetch } = await import("../../open-sse/handlers/codexStt.js");
      const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
      const request = new Request("http://localhost/v1/audio/transcriptions", { method: "POST" });
      const response = await withGatewayRequest({ request, body: {}, target: "codex/transcribe", requestedAlias: "codex/transcribe", authenticatedKey: key.key }, () =>
        executeGatewayProvider({ provider: "codex", model: "transcribe" }, () =>
          withGenerationDispatch({ requestedModel: "transcribe", policySupported: false }, () =>
            proxyAwareFetch(url, { method: "POST", headers: {}, body: "audio", directFetch: codexHttpFetch }))));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "hello" });
      expect(network).toHaveBeenCalledTimes(1);
      expect(sends).toEqual([{ target: url, method: "POST" }]);
      const summary = await ledger.getLedgerSummary();
      expect(summary).toMatchObject({ requests: 1, attempts: 2 });
      expect(await ledger.getRequestAttempts(summary.recentRequests[0].requestId)).toMatchObject([
        { sequence: 1, provider: "codex", requestedModel: "transcribe", status: "error" },
        { sequence: 2, provider: "codex", requestedModel: "transcribe", status: "success" },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
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
