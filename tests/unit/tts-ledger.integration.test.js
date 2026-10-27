import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the collector and native network boundary are replaced; ingress and ledger stay real.
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    export(_spans, callback) { callback({ code: 0 }); }
    shutdown() { return Promise.resolve(); }
  },
}));

const wireUrl = "http://127.0.0.1:18880/v1/audio/speech";
const wireModel = "selfhosted-tts/kokoro/af_heart";
const input = "Read this synthetic sentence aloud.";
const policyText = "Preserve the caller's instructions. Inspect evidence before answering.";
const audio = new Uint8Array(128).fill(42);
let directory, database, repositories, policies, ledger, route, telemetry, network, key;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tele-tts-ingress-"));
  vi.stubEnv("DATA_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
  vi.stubEnv("TELE_PROXY_ENABLED", "1");
  vi.stubEnv("TELE_PROXY_ENVIRONMENT", "test");
  vi.stubEnv("TELE_PROXY_PSEUDONYM_SECRET", "synthetic-tts-ingress-pseudonym-secret");
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
  // Real proxyFetch retains physical retry instrumentation and captures this mock fetch.
  network = vi.fn(async (url) => {
    if (String(url) !== wireUrl) throw new Error(`Unexpected network request: ${String(url)}`);
    return new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
  });
  vi.stubGlobal("fetch", network);
  await import("../../open-sse/utils/proxyFetch.js");
  repositories = await import("@/lib/db/index.js");
  await repositories.updateSettings({ requireApiKey: true, comboStrategy: "fallback", comboStrategies: {} });
  await repositories.createProviderConnection({
    provider: "selfhosted-tts", authType: "apikey", name: "synthetic speech upstream", apiKey: "synthetic-upstream-key",
    providerSpecificData: { baseUrl: "http://127.0.0.1:18880" },
  });
  key = await repositories.createApiKey("speech ingress fixture", "synthetic-speech-machine");
  policies = await import("@/lib/comboPolicy.js");
  ledger = await import("@/lib/requestLedger.js");
  telemetry = await import("@/lib/gatewayTelemetry.js");
  database = await (await import("@/lib/db/driver.js")).getAdapter();
  route = await import("../../src/app/api/v1/audio/speech/route.js");
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
  directory = database = repositories = policies = ledger = route = telemetry = network = key = undefined;
});

async function createCombo(name, policy) {
  const combo = await repositories.createCombo({ name, models: [wireModel] });
  if (policy) await policies.saveComboPolicy(combo.id, {
    policyId: "speech-policy", text: policyText, enabled: true, required: true,
    mergeMode: "append_preserve_client", maxInjectedTokens: 600, expectedVersion: null,
    ...policy,
  });
  return combo.name;
}

function request(model) {
  return new Request("http://localhost/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model, input }),
  });
}

describe.sequential("real /v1/audio/speech policy and accounting", () => {
  it("rejects unsupported required speech policy with 422 and zero upstream sends", async () => {
    const model = await createCombo("speech-required", {});
    const response = await route.POST(request(model));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: {
      message: "Required combo policy could not be applied", type: "gateway_error",
    } });
    expect(network).not.toHaveBeenCalled();
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 0 });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({
      authenticatedKeyId: key.id, requestedAlias: model, resolvedCombo: model,
      policyId: "speech-policy", policyVersion: 1, policyAppliedStatus: "failed",
      finalStatus: "policy_failed", attemptCount: 0, accountingCompleteness: "incomplete",
    });
    expect(entry.completedAt).toEqual(expect.any(String));
    expect(await ledger.getRequestAttempts(entry.requestId)).toEqual([]);
  });

  it.each([
    ["cartesia", "sonic-2", "https://api.cartesia.ai/tts/bytes", "model_id"],
    ["playht", "PlayDialog", "https://api.play.ht/api/v2/tts/stream", "voice_engine"],
    ["inworld", "inworld-tts-1.5-mini", "https://api.inworld.ai/tts/v1/voice", "modelId"],
    ["gemini", "gemini-2.5-flash-preview-tts", null, null],
  ])("records the wire model instead of the model/voice selector for %s", async (provider, model, url, field) => {
    await repositories.createProviderConnection({ provider, authType: "apikey", apiKey: "synthetic-model-key", name: "synthetic model fixture" });
    network.mockImplementation(async (wire) => {
      if (provider === "gemini") {
        expect(String(wire)).toContain(`/${model}:generateContent?`);
        return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from(audio).toString("base64") } }] } }] });
      }
      expect(String(wire)).toBe(url);
      return provider === "inworld" ? Response.json({ audioContent: Buffer.from(audio).toString("base64") })
        : new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
    });
    const response = await route.POST(request(`${provider}/${model}/Zephyr`));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(network).toHaveBeenCalledTimes(1);
    if (field) expect(JSON.parse(network.mock.calls[0][1].body)[field]).toBe(model);
    const summary = await ledger.getLedgerSummary();
    const attempts = await ledger.getRequestAttempts(summary.recentRequests[0].requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider, requestedModel: model, status: "success", usageSource: "unknown", costStatus: "unknown" });
  });


  it("counts Edge synthesis retry sends but not token bootstrap requests", async () => {
    let synthesis = 0;
    network.mockImplementation(async (url) => {
      if (String(url) === "https://www.bing.com/translator") {
        return new Response('params_AbusePreventionHelper = [123,"synthetic-token",');
      }
      if (String(url).startsWith("https://www.bing.com/tfettts?")) {
        synthesis++;
        return synthesis === 1 ? new Response("expired", { status: 403 })
          : new Response(new Uint8Array(2048).fill(7), { headers: { "Content-Type": "audio/mpeg" } });
      }
      throw new Error(`Unexpected network request: ${String(url)}`);
    });
    const response = await route.POST(request("edge-tts/en-US-AriaNeural"));
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(2048);
    expect(network).toHaveBeenCalledTimes(4);
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 2 });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({ finalStatus: "success", attemptCount: 2, accountingCompleteness: "incomplete" });
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts.map(({ provider, status, usageSource, costStatus }) => ({ provider, status, usageSource, costStatus }))).toEqual([
      { provider: "edge-tts", status: "error", usageSource: "unknown", costStatus: "unknown" },
      { provider: "edge-tts", status: "success", usageSource: "unknown", costStatus: "unknown" },
    ]);
  });
  it.each([
    ["direct model", null],
    ["combo without policy", "absent"],
    ["disabled combo policy", "disabled"],
    ["required combo policy with merge mode off", "off"],
    ["optional unsupported policy", "optional"],
  ])("preserves audio and records one physical send with unknown usage/cost for %s", async (_label, mode) => {
    const policy = mode === "absent" ? null : mode === "disabled" ? { enabled: false }
      : mode === "optional" ? { required: false } : { mergeMode: "off" };
    const model = mode === null ? wireModel : await createCombo(`speech-${mode}`, policy);
    const response = await route.POST(request(model));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/mp3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    expect(network).toHaveBeenCalledTimes(1);
    const [url, options] = network.mock.calls[0];
    expect(String(url)).toBe(wireUrl);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ model: "kokoro", voice: "af_heart", input, response_format: "mp3" });
    expect(options.body).not.toContain(policyText);
    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: {
      usageKnownAttempts: 0, usageUnknownAttempts: 1, costKnownAttempts: 0, costUnknownAttempts: 1,
      requestComplete: 0, requestIncomplete: 1,
    } });
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({
      authenticatedKeyId: key.id, requestedAlias: model, resolvedCombo: mode === null ? null : model,
      policyAppliedStatus: mode === "optional" ? "unsupported" : "off",
      finalStatus: "success", attemptCount: 1, accountingCompleteness: "incomplete",
    });
    expect(entry.completedAt).toEqual(expect.any(String));
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sequence: 1, provider: "selfhosted-tts", requestedModel: "kokoro", status: "success",
      usageSource: "unknown", inputTokens: null, outputTokens: null, allowlistedRawUsage: {},
      costStatus: "unknown", meteredCostEstimateMicros: null, apiEquivalentValueMicros: null,
      providerReportedChargeMicros: null,
    });
    expect(attempts[0].endedAt).toEqual(expect.any(String));
  });
});
