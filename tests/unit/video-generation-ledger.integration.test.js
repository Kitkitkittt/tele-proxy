import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    export(_spans, callback) { callback({ code: 0 }); }
    shutdown() { return Promise.resolve(); }
  },
}));
let directory, database, telemetry;
afterEach(async () => {
  await telemetry?.shutdownTelemetry({ reset: true });
  database?.close?.();
  delete globalThis._dbAdapter;
  delete globalThis[Symbol.for("tele-proxy.initialization")];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("records one real video creation and no attempts for subsequent polls", async () => {
  directory = await mkdtemp(join(tmpdir(), "tele-video-ingress-"));
  for (const [name, value] of Object.entries({
    DATA_DIR: join(directory, "state"), HOME: join(directory, "home"),
    TELE_PROXY_ENABLED: "1", TELE_PROXY_ENVIRONMENT: "test",
    TELE_PROXY_PSEUDONYM_SECRET: "synthetic-video-pseudonym-secret",
    TELE_PROXY_LOG_FILE: "", OTEL_EXPORTER_OTLP_HEADERS: "",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*",
  })) vi.stubEnv(name, value);
  vi.resetModules();
  delete globalThis._dbAdapter;
  delete globalThis[Symbol.for("tele-proxy.initialization")];
  const network = vi.fn(async (url, options) => {
    expect(String(url)).toMatch(/^https:\/\/api\.x\.ai\/v1\/videos\/(generations|synthetic-job)$/);
    return Response.json(options.method === "POST" ? { request_id: "synthetic-job" } : { status: "pending" });
  });
  vi.stubGlobal("fetch", network);
  await import("../../open-sse/utils/proxyFetch.js");
  const repositories = await import("@/lib/db/index.js");
  await repositories.updateSettings({ requireApiKey: true });
  await repositories.createProviderConnection({ provider: "xai", authType: "apikey", apiKey: "synthetic-video-upstream", name: "video fixture" });
  const key = await repositories.createApiKey("video fixture", "synthetic-video-machine");
  const ledger = await import("@/lib/requestLedger.js");
  telemetry = await import("@/lib/gatewayTelemetry.js");
  database = await (await import("@/lib/db/driver.js")).getAdapter();
  const create = await import("../../src/app/api/v1/videos/generations/route.js");
  const poll = await import("../../src/app/api/v1/videos/[id]/route.js");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` };
  const response = await create.POST(new Request("http://localhost/v1/videos/generations", {
    method: "POST", headers, body: JSON.stringify({ model: "xai/grok-imagine-video", prompt: "Synthetic square" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ request_id: "synthetic-job" });
  for (let i = 0; i < 2; i++) {
    const result = await poll.GET(new Request("http://localhost/v1/videos/synthetic-job", { headers }), { params: Promise.resolve({ id: "synthetic-job" }) });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: "pending" });
  }
  expect(network.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "GET", "GET"]);
  const summary = await ledger.getLedgerSummary();
  expect(summary).toMatchObject({ requests: 1, attempts: 1, coverage: { usageKnownAttempts: 0, usageUnknownAttempts: 1, costKnownAttempts: 0, costUnknownAttempts: 1 } });
  const entry = summary.recentRequests[0];
  expect(entry).toMatchObject({ authenticatedKeyId: key.id, resolvedCombo: null, finalStatus: "success", attemptCount: 1, accountingCompleteness: "incomplete" });
  expect(await ledger.getRequestAttempts(entry.requestId)).toMatchObject([{ provider: "xai", requestedModel: "grok-imagine-video", status: "success", usageSource: "unknown", inputTokens: null, outputTokens: null, costStatus: "unknown", meteredCostEstimateMicros: null }]);
});
