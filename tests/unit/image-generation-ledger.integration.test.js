import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The collector is an external boundary; routing, policy, dispatch and persistence stay real.
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    export(_spans, callback) { callback({ code: 0 }); }
    shutdown() { return Promise.resolve(); }
  },
}));

const wireUrl = "http://localhost:7860/sdapi/v1/txt2img";
const wireModel = "sdwebui/stable-diffusion-v1-5";
const image = "c3ludGhldGljLWltYWdlLWJ5dGVz";
const prompt = "Draw a small blue square.";
const policyText = "Preserve the caller's instructions. Inspect evidence before answering.";
let directory, database, repositories, policies, ledger, route, telemetry, network, key;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tele-image-ingress-"));
  vi.stubEnv("DATA_DIR", join(directory, "state"));
  vi.stubEnv("HOME", join(directory, "home"));
  vi.stubEnv("TELE_PROXY_ENABLED", "1");
  vi.stubEnv("TELE_PROXY_ENVIRONMENT", "test");
  vi.stubEnv("TELE_PROXY_PSEUDONYM_SECRET", "synthetic-image-ingress-pseudonym-secret");
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

  // proxyFetch captures native fetch on import. Stub that physical boundary first,
  // then retain its real global wrapper so missing generation markers cannot pass.
  network = vi.fn(async (url) => {
    if (String(url) !== wireUrl) throw new Error(`Unexpected network request: ${String(url)}`);
    return Response.json({ images: [image] });
  });
  vi.stubGlobal("fetch", network);
  await import("../../open-sse/utils/proxyFetch.js");
  repositories = await import("@/lib/db/index.js");
  await repositories.updateSettings({ requireApiKey: true, comboStrategy: "fallback", comboStrategies: {} });
  key = await repositories.createApiKey("image ingress fixture", "synthetic-image-machine");
  policies = await import("@/lib/comboPolicy.js");
  ledger = await import("@/lib/requestLedger.js");
  telemetry = await import("@/lib/gatewayTelemetry.js");
  database = await (await import("@/lib/db/driver.js")).getAdapter();
  route = await import("../../src/app/api/v1/images/generations/route.js");
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
    policyId: "image-policy", text: policyText, enabled: true, required: true,
    mergeMode: "append_preserve_client", maxInjectedTokens: 600, expectedVersion: null,
    ...policy,
  });
  return combo.name;
}

function request(model) {
  return new Request("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model, prompt, n: 1, size: "512x768" }),
  });
}

describe.sequential("real /v1/images/generations policy and accounting", () => {
  it("rejects a required combo policy with 422 before any upstream generation send", async () => {
    const model = await createCombo("images-required", {});
    const response = await route.POST(request(model));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: {
      message: "Required combo policy could not be applied", type: "gateway_error",
    } });
    expect(network).not.toHaveBeenCalled();

    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 0 });
    expect(summary.recentRequests).toHaveLength(1);
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({
      authenticatedKeyId: key.id, requestedAlias: model, resolvedCombo: model,
      policyId: "image-policy", policyVersion: 1, policyAppliedStatus: "failed",
      finalStatus: "policy_failed", attemptCount: 0, accountingCompleteness: "incomplete",
    });
    expect(entry.completedAt).toEqual(expect.any(String));
    expect(await ledger.getRequestAttempts(entry.requestId)).toEqual([]);
  });

  it.each([
    ["direct model", null],
    ["combo without policy", "absent"],
    ["disabled combo policy", "disabled"],
    ["required combo policy with merge mode off", "off"],
  ])("returns the real adapter image and records one unknown-usage send for %s", async (_label, mode) => {
    const model = mode === null ? wireModel : await createCombo(`images-${mode}`,
      mode === "absent" ? null : mode === "disabled" ? { enabled: false } : { mergeMode: "off" });
    const response = await route.POST(request(model));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Drain the actual client response: request finalization must follow consumption.
    expect(await response.json()).toEqual({ created: expect.any(Number), data: [{ b64_json: image }] });
    expect(network).toHaveBeenCalledTimes(1);
    const [url, options] = network.mock.calls[0];
    expect(String(url)).toBe(wireUrl);
    expect(options.method).toBe("POST");
    expect(new Headers(options.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual({
      prompt, width: 512, height: 768, steps: 20, batch_size: 1,
    });
    expect(options.body).not.toContain(policyText);

    const summary = await ledger.getLedgerSummary();
    expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: {
      usageKnownAttempts: 0, usageUnknownAttempts: 1,
      costKnownAttempts: 0, costUnknownAttempts: 1, requestComplete: 0, requestIncomplete: 1,
    } });
    expect(summary.recentRequests).toHaveLength(1);
    const entry = summary.recentRequests[0];
    expect(entry).toMatchObject({
      authenticatedKeyId: key.id, requestedAlias: model, resolvedCombo: mode === null ? null : model,
      policyAppliedStatus: "off", finalStatus: "success", attemptCount: 1, accountingCompleteness: "incomplete",
    });
    expect(entry.completedAt).toEqual(expect.any(String));
    const attempts = await ledger.getRequestAttempts(entry.requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      sequence: 1, provider: "sdwebui", requestedModel: "stable-diffusion-v1-5", status: "success",
      usageSource: "unknown", inputTokens: null, outputTokens: null,
      cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      allowlistedRawUsage: {}, costStatus: "unknown", meteredCostEstimateMicros: null,
      apiEquivalentValueMicros: null, providerReportedChargeMicros: null,
    });
    expect(attempts[0].endedAt).toEqual(expect.any(String));
  });
});
