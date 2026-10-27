import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { BoundedSpanProcessor, assertCollectorHeaderIsolation, generationAttributes, startRequest, startAttempt, endAttempt, endRequest, attachRequestIdentity, event, metricsText, metricsResponse, flushTelemetry, shutdownTelemetry } from "../../src/lib/gatewayTelemetry.js";
import { sanitizeDiagnostic } from "../../src/lib/privacyDiagnostics.js";
import { createRequestLogger } from "../../open-sse/utils/requestLogger.js";
import * as legacyLogger from "../../src/sse/utils/logger.js";

const secret = "proprietary_source_BEARER_secret_sentinel";
const original = { enabled: process.env.TELE_PROXY_ENABLED, endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, metrics: process.env.TELE_PROXY_METRICS_TOKEN };
beforeAll(async () => {
  await shutdownTelemetry({ reset: true });
  process.env.TELE_PROXY_ENABLED = "1";
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://127.0.0.1:1/v1/traces";
  process.env.TELE_PROXY_TELEMETRY_TIMEOUT_MS = "50";
  process.env.TELE_PROXY_METRICS_TOKEN = "synthetic_metrics_token_1234";
});
afterAll(async () => {
  await shutdownTelemetry({ reset: true });
  for (const [name, value] of Object.entries({ TELE_PROXY_ENABLED: original.enabled, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: original.endpoint, TELE_PROXY_METRICS_TOKEN: original.metrics })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe("metadata-only telemetry", () => {
  it("rejects SDK-inherited headers before exporter creation without exposing their values", () => {
    for (const name of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"]) {
      let rejected;
      try { assertCollectorHeaderIsolation({ [name]: `Authorization=Basic ${secret}` }); } catch (error) { rejected = error; }
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected.message).toContain("Inherited OTLP headers are prohibited");
      expect(rejected.message).not.toContain(secret);
    }
    expect(() => assertCollectorHeaderIsolation({ TELE_PROXY_ALLOY_TOKEN: secret })).not.toThrow();
    expect(() => assertCollectorHeaderIsolation({ OTEL_EXPORTER_OTLP_HEADERS: "", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "" })).not.toThrow();
  });
  it("maps only generation metadata and preserves zero versus unknown costs", () => {
    const unknown = generationAttributes({ provider: "openai", model: "gpt-4o", usage: { inputTokens: 20, outputTokens: 10, cachedInputTokens: 5, reasoningTokens: 3 }, prompt: secret, error: new Error(secret), apiKey: secret });
    expect(JSON.stringify(unknown)).not.toContain(secret);
    expect(unknown["langfuse.observation.type"]).toBe("generation");
    expect(unknown["langfuse.observation.model.name"]).toBe("tele-proxy-unpriced::openai::gpt-4o");
    expect(unknown["langfuse.observation.metadata.actual_model"]).toBe("gpt-4o");
    expect(JSON.parse(unknown["langfuse.observation.usage_details"])).toMatchObject({ input: 20, output: 10, total: 30, cached_input: 5, reasoning: 3 });
    expect(unknown).not.toHaveProperty("langfuse.observation.cost_details");
    expect(unknown["langfuse.observation.metadata.cost_basis"]).toBe("unknown");
    const zero = generationAttributes({ provider: "openai", model: "gpt-4o", providerReportedChargeMicros: 0, providerReportedCurrency: "USD" });
    expect(JSON.parse(zero["langfuse.observation.cost_details"])).toEqual({ total: 0 });
    expect(zero["langfuse.observation.metadata.cost_basis"]).toBe("provider_reported_charge");
    const estimate = generationAttributes({ currency: "USD", meteredCostEstimateMicros: 125000, costStatus: "estimated" });
    expect(JSON.parse(estimate["langfuse.observation.cost_details"])).toEqual({ total: .125 });
    expect(generationAttributes({ currency: "EUR", meteredCostEstimateMicros: 125000 })).not.toHaveProperty("langfuse.observation.cost_details");
  });
  it("never emits arbitrary events, errors or legacy logger messages", async () => {
    const output = []; const spy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      const root = startRequest({ requestId: "synthetic-request", combo: "quality", body: secret, apiKey: secret });
      attachRequestIdentity(root, { requestId: "synthetic-request", approvedProjectId: "project-a" });
      event(root, secret, { error: secret });
      event(root, "fallback", { error: secret });
      const first = startAttempt(root, { attemptId: "attempt-1", provider: "openai", model: "gpt-4o" });
      endAttempt(first, { status: "error", errorClass: "unknown", usageComplete: false, body: secret });
      endAttempt(first, { status: "success" });
      const second = startAttempt(root, { attemptId: "attempt-2", provider: "openai", model: "gpt-4o", fallbackReason: "upstream_error" });
      endAttempt(second, { status: "success", usage: { inputTokens: 1, outputTokens: 2 }, usageComplete: true });
      endRequest(root, { status: "success", clientFirstContentMs: 1 }); endRequest(root, { status: "success" });
      legacyLogger.error(secret, secret, { key: secret }); legacyLogger.line(secret, secret, secret);
      expect(root.span.attributes["langfuse.observation.type"]).toBe("span");
      expect(root.span.attributes).not.toHaveProperty("langfuse.observation.cost_details");
      expect(root.span.attributes).not.toHaveProperty("langfuse.observation.usage_details");
      expect(first.span.spanContext().traceId).toBe(root.traceId);
      expect(second.span.spanContext().traceId).toBe(root.traceId);
      expect(legacyLogger.maskKey(secret)).toBe("[redacted]");
      const capture = await createRequestLogger("openai", "openai", secret);
      capture.logRawRequest({ content: secret }, { Authorization: secret });
      expect(capture.sessionPath).toBeNull();
      expect(output.join("\n")).not.toContain(secret);
      expect(metricsText()).not.toContain(secret);
      expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    } finally { spy.mockRestore(); }
    await flushTelemetry();
  });
  it("requires a configured strong bearer credential for metrics", async () => {
    expect((await metricsResponse(new Request("http://localhost/api/metrics"))).status).toBe(401);
    const response = await metricsResponse(new Request("http://localhost/api/metrics", { headers: { authorization: "Bearer synthetic_metrics_token_1234" } }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("nine_router_export_queue_size");
  });
  it("shares SDK, inflight, counters and histograms across duplicate route modules", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = startRequest({ requestId: "bundle-one", combo: "quality" });
      const singleton = globalThis[Symbol.for("tele-proxy.gatewayTelemetry.v1")];
      const provider = singleton.provider;
      const processor = singleton.processor;
      vi.resetModules();
      const duplicate = await import("../../src/lib/gatewayTelemetry.js");
      const second = duplicate.startRequest({ requestId: "bundle-two", combo: "quality" });
      expect(singleton.provider).toBe(provider);
      expect(singleton.processor).toBe(processor);
      expect(duplicate.metricsText()).toMatch(/nine_router_inflight_requests\{environment="[a-z]+"\} 2/);
      duplicate.endRequest(first, { status: "success", clientFirstContentMs: 1 });
      endRequest(second, { status: "success", clientFirstContentMs: 2 });
      const requestCounters = (text) => text.split("\n").filter((line) => line.startsWith("nine_router_requests_total{"));
      expect(requestCounters(duplicate.metricsText())).toEqual(requestCounters(metricsText()));
      expect(metricsText()).toContain("nine_router_request_duration_seconds_count");
      await duplicate.flushTelemetry();
    } finally { spy.mockRestore(); }
  });
  it("rejects proprietary diagnostic bodies rather than regex redacting them", () => {
    expect(() => sanitizeDiagnostic({ event: "request", outcome: "success", content: secret })).toThrow("content capture is prohibited");
    expect(sanitizeDiagnostic({ event: "attempt", outcome: "error", durationMs: 25 })).toEqual({ event: "attempt", outcome: "error", durationMs: 25 });
    expect(() => sanitizeDiagnostic({ event: secret, outcome: "success" })).toThrow();
  });
});

describe("bounded asynchronous outage queue", () => {
  it("caps both queued and in-flight spans when the exporter never returns", async () => {
    const exporter = { export: vi.fn(), shutdown: vi.fn(() => Promise.resolve()) };
    const p = new BoundedSpanProcessor(exporter, { capacity: 8, batchSize: 2, timeout: 50 });
    for (let i = 0; i < 8; i++) p.onEnd({ name: "generation" });
    p.pump();
    for (let i = 0; i < 100; i++) p.onEnd({ name: "generation" });
    expect(p.size).toBe(8);
    expect(exporter.export).toHaveBeenCalledTimes(1);
    expect(metricsText()).toContain('reason="queue_full"');
    await p.shutdown();
    expect(p.queue).toHaveLength(0);
  });
  it("counts failed batches once without retrying authoritative accounting", async () => {
    const exporter = { export: vi.fn((_spans, callback) => callback({ code: 1 })), shutdown: vi.fn(() => Promise.resolve()) };
    const p = new BoundedSpanProcessor(exporter, { capacity: 4, batchSize: 2, timeout: 50 });
    p.onEnd({}); p.onEnd({}); p.pump();
    expect(p.size).toBe(0);
    expect(exporter.export).toHaveBeenCalledTimes(1);
    expect(metricsText()).toContain('reason="export_failed"');
    await p.shutdown();
  });
});
