import { timingSafeEqual } from "node:crypto";
import { appendFile, stat, rename, unlink, chmod } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

// Mapping revision: Langfuse v4 documented OTLP attributes; no auto-instrumentation.
const enabled = () => process.env.TELE_PROXY_ENABLED === "1";
const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const boundedInt = (name, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(process.env[name], 10) || fallback));
const environment = ["canary", "development", "test", "production", "staging"].includes(process.env.TELE_PROXY_ENVIRONMENT) ? process.env.TELE_PROXY_ENVIRONMENT : "unknown";
const reasons = new Set(["rate_limit", "upstream_error", "network", "timeout", "auth", "policy", "cancelled", "unknown"]);
const events = new Set(["policy_applied", "policy_application_failure", "route_selected", "fallback", "ledger_write_failure", "tool_call_requested", "unsupported_accounting_transport", "client_first_content"]);
const providers = new Set((process.env.TELE_PROXY_METRIC_PROVIDERS || "openai,anthropic,gemini,ollama,openrouter,codex,claude,antigravity,gemini-cli,local,canary").split(",").filter((s) => /^[a-z0-9-]{1,32}$/.test(s)).slice(0, 32));
const combos = new Set((process.env.TELE_PROXY_METRIC_COMBOS || "quality,balanced,fast,cheap,free,vision,quality-engineering").split(",").filter((s) => /^[a-z0-9-]{1,40}$/.test(s)).slice(0, 16));
const id = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(s) ? s : undefined;
const catalogId = (s) => typeof s === "string" && /^[a-zA-Z0-9._:/-]{1,120}$/.test(s) ? s : "unknown";
const reason = (fields = {}) => fields.status === 429 || fields.httpStatus === 429 ? "rate_limit" : reasons.has(fields.errorClass) ? fields.errorClass : reasons.has(fields.reason) ? fields.reason : reasons.has(fields.fallbackReason) ? fields.fallbackReason : "unknown";
const outcome = (fields = {}) => fields.cancelState === "client_cancelled" || fields.cancelState === "cancelled" || fields.status === "cancelled" ? "cancelled" : ["incomplete", "abandoned"].includes(fields.status) ? "incomplete" : ["error", "failed", "policy_failed"].includes(fields.status) || fields.errorClass || Number(fields.status) >= 400 ? "error" : "success";
const labelProvider = (s) => providers.has(s) ? s : "other";
const labelCombo = (s) => combos.has(s) ? s : "other";
const buckets = [.05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];
// Next may evaluate this module in multiple route bundles in the same process.
// Keep one SDK/export queue and one metric/log state, not one copy per bundle.
const state = globalThis[Symbol.for("tele-proxy.gatewayTelemetry.v1")] ||= {
  counters: new Map(), histograms: new Map(), inflight: 0,
  processor: undefined, provider: undefined, tracer: undefined, initFailed: false,
  eventLoop: undefined, logQueue: [], logWriting: false, shutdown: undefined,
  processStartTime: Date.now() / 1000 - process.uptime(),
};
const counters = state.counters;
const histograms = state.histograms;
const logQueue = state.logQueue;

function inc(name, labels = {}, amount = 1) {
  if (!enabled() || !finite(amount)) return;
  const key = `${name}|${JSON.stringify({ environment, ...labels })}`;
  counters.set(key, (counters.get(key) || 0) + amount);
}
function observe(name, labels, seconds) {
  if (!finite(seconds)) return;
  const key = `${name}|${JSON.stringify({ environment, ...labels })}`;
  let h = histograms.get(key);
  if (!h) { h = { count: 0, sum: 0, buckets: buckets.map(() => 0) }; histograms.set(key, h); }
  h.count++; h.sum += seconds;
  buckets.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
}
export function recordDrop(value = "export_failed", amount = 1) {
  const allowed = ["queue_full", "export_failed", "init_failed", "log_queue_full", "log_write_failed", "diagnostic_failed"];
  inc("telemetry_dropped_total", { reason: allowed.includes(value) ? value : "export_failed" }, amount);
}
export function ledgerFailure() { inc("ledger_write_failures_total"); }

// SDK SpanProcessor interface. At most one export is active; no disk spool or unbounded retries.
export class BoundedSpanProcessor {
  constructor(exporter, options = {}) {
    this.exporter = exporter;
    this.capacity = options.capacity || boundedInt("TELE_PROXY_TELEMETRY_QUEUE_SIZE", 256, 1, 4096);
    this.batchSize = Math.min(this.capacity, options.batchSize || boundedInt("TELE_PROXY_TELEMETRY_BATCH_SIZE", 32, 1, 128));
    this.timeout = options.timeout || boundedInt("TELE_PROXY_TELEMETRY_TIMEOUT_MS", 2000, 50, 10000);
    this.queue = []; this.active = null; this.closed = false; this.timer = null;
  }
  onStart() {}
  onEnd(span) {
    if (this.closed || this.queue.length + (this.active?.length || 0) >= this.capacity) { recordDrop("queue_full"); return; }
    this.queue.push(span);
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 20); this.timer.unref?.(); }
  }
  pump() {
    if (this.active || !this.queue.length || this.closed) return;
    const batch = this.queue.splice(0, this.batchSize); this.active = batch;
    // Exporter owns a finite HTTP timeout and finite SDK transport retries. Do not start a
    // replacement export until its callback: a stalled exporter cannot grow in-flight work.
    try {
      this.exporter.export(batch, (result) => {
        if (result?.code !== 0) recordDrop("export_failed", batch.length);
        this.active = null;
        if (this.queue.length && !this.closed) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 20); this.timer.unref?.(); }
      });
    } catch { recordDrop("export_failed", batch.length); this.active = null; }
  }
  async forceFlush() {
    const deadline = Date.now() + this.timeout + 100;
    while ((this.queue.length || this.active) && Date.now() < deadline) {
      this.pump(); await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async shutdown() {
    await this.forceFlush(); this.closed = true; clearTimeout(this.timer);
    if (this.queue.length) recordDrop("export_failed", this.queue.length);
    this.queue.length = 0;
    await Promise.race([Promise.resolve(this.exporter.shutdown()), new Promise((resolve) => { const timer = setTimeout(resolve, this.timeout); timer.unref?.(); })]);
  }
  get size() { return this.queue.length + (this.active?.length || 0); }
}

export function assertCollectorHeaderIsolation(env = process.env) {
  // OTel merges generic/signal env headers into explicit constructor headers.
  // Reject them rather than risk forwarding a direct-backend credential to Alloy.
  if (env.OTEL_EXPORTER_OTLP_HEADERS || env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) {
    throw new Error("Inherited OTLP headers are prohibited; use TELE_PROXY_ALLOY_TOKEN");
  }
}

function getTracer() {
  if (state.tracer || state.initFailed || !enabled()) return state.tracer;
  try {
    assertCollectorHeaderIsolation();
    const endpoint = new URL(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://127.0.0.1:4318/v1/traces");
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/v1/traces") throw new Error("invalid collector endpoint");
    // Explicit headers only; never forward client authentication, baggage or Langfuse keys.
    const headers = {};
    if (process.env.TELE_PROXY_ALLOY_TOKEN) headers.Authorization = `Bearer ${process.env.TELE_PROXY_ALLOY_TOKEN}`;
    const exporter = new OTLPTraceExporter({ url: endpoint.href, headers, timeoutMillis: boundedInt("TELE_PROXY_TELEMETRY_TIMEOUT_MS", 2000, 50, 10000), concurrencyLimit: 1 });
    state.processor = new BoundedSpanProcessor(exporter);
    state.provider = new BasicTracerProvider({ resource: resourceFromAttributes({ "service.name": "tele-proxy", "service.version": "0.5.111-tele-proxy", "deployment.environment.name": environment }), spanProcessors: [state.processor], spanLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 1024, eventCountLimit: 16, linkCountLimit: 0 } });
    state.tracer = state.provider.getTracer("tele-proxy.gateway", "1.0.0");
  } catch { state.initFailed = true; recordDrop("init_failed"); }
  return state.tracer;
}

function metadata(fields = {}) {
  const attrs = { "langfuse.trace.name": "gateway.request", "langfuse.environment": environment, "langfuse.trace.public": false };
  const values = {
    request_id: id(fields.requestId), combo: catalogId(fields.resolvedCombo || fields.combo || fields.requestedAlias),
    policy_id: id(fields.policyId), policy_version: Number.isSafeInteger(fields.policyVersion) && fields.policyVersion > 0 ? fields.policyVersion : undefined,
    policy_hash: typeof fields.policyHash === "string" && /^[a-f0-9]{64}$/.test(fields.policyHash) ? fields.policyHash : undefined,
  };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) attrs[`langfuse.trace.metadata.${key}`] = value;
  return attrs;
}

// Actual model remains queryable; a namespaced display model deliberately cannot match
// Langfuse's shipped reference price patterns. No real model is disguised as cash spend.
export function generationAttributes(fields = {}) {
  const attrs = { "langfuse.observation.type": "generation", "gen_ai.operation.name": "chat", "gen_ai.provider.name": catalogId(fields.provider) };
  const model = catalogId(fields.responseModel || fields.requestedModel || fields.model);
  attrs["langfuse.observation.model.name"] = `tele-proxy-unpriced::${catalogId(fields.provider)}::${model}`;
  attrs["langfuse.observation.metadata.actual_model"] = model;
  attrs["gen_ai.request.model"] = catalogId(fields.requestedModel || fields.model);
  if (fields.responseModel) attrs["gen_ai.response.model"] = model;
  if (id(fields.attemptId)) attrs["langfuse.observation.metadata.attempt_id"] = fields.attemptId;
  const u = fields.usage || fields;
  const usage = {};
  for (const [key, names] of Object.entries({ input: ["inputTokens", "input_tokens", "prompt_tokens"], output: ["outputTokens", "output_tokens", "completion_tokens"], cached_input: ["cachedInputTokens", "cached_input_tokens"], cache_write: ["cacheWriteTokens", "cache_write_tokens"], reasoning: ["reasoningTokens", "reasoning_tokens"] })) {
    const value = names.map((name) => u?.[name]).find(finite);
    if (value !== undefined) usage[key] = value;
  }
  if (finite(usage.input) && finite(usage.output)) usage.total = usage.input + usage.output;
  if (Object.keys(usage).length) attrs["langfuse.observation.usage_details"] = JSON.stringify(usage);
  let amount; let basis = "unknown";
  const reported = finite(fields.providerReportedChargeMicros) ? fields.providerReportedChargeMicros / 1e6 : fields.providerReportedCharge;
  const estimate = finite(fields.meteredCostEstimateMicros) ? fields.meteredCostEstimateMicros / 1e6 : fields.meteredCostEstimate;
  if ((fields.providerReportedCurrency || fields.currency) === "USD" && finite(reported)) {
    amount = reported; basis = "provider_reported_charge";
  } else if (fields.currency === "USD" && finite(estimate) && !["unknown", "incomplete"].includes(fields.costStatus)) {
    amount = estimate; basis = "metered_estimate";
  }
  if (amount !== undefined) attrs["langfuse.observation.cost_details"] = JSON.stringify({ total: amount });
  attrs["langfuse.observation.metadata.cost_basis"] = basis;
  attrs["langfuse.observation.metadata.cost_status"] = amount === undefined ? "unknown" : "known";
  attrs["langfuse.observation.metadata.billing_mode"] = ["metered", "subscription", "local", "free"].includes(fields.billingMode) ? fields.billingMode : "unknown";
  return attrs;
}

function log(severity, eventName, handle, fields = {}) {
  const record = { severity, timestamp: new Date().toISOString(), service: "tele-proxy", environment, event: eventName };
  if (id(handle?.fields?.requestId)) record.request_id = handle.fields.requestId;
  const spanContext = handle?.span?.spanContext();
  if (spanContext) { record.trace_id = spanContext.traceId; record.span_id = spanContext.spanId; }
  if (fields.outcome) record.outcome = fields.outcome;
  if (fields.reason) record.reason = fields.reason;
  const line = JSON.stringify(record) + "\n";
  if (!process.env.TELE_PROXY_LOG_FILE) { console.log(line.trimEnd()); return; }
  if (logQueue.length >= 256) { recordDrop("log_queue_full"); return; }
  logQueue.push(line);
  if (!state.logWriting) void drainLogs();
}
async function drainLogs() {
  state.logWriting = true;
  try {
    while (logQueue.length) {
      const line = logQueue.shift();
      const file = process.env.TELE_PROXY_LOG_FILE;
      try {
        const size = await stat(file).then((s) => s.size).catch(() => 0);
        if (size >= 5 * 1024 * 1024) {
          await unlink(`${file}.2`).catch(() => {});
          await rename(`${file}.1`, `${file}.2`).catch(() => {});
          await rename(file, `${file}.1`);
        }
        await appendFile(file, line, { mode: 0o644 });
        await chmod(file, 0o644);
      } catch { recordDrop("log_write_failed"); }
    }
  } finally { state.logWriting = false; }
}

export function startRequest(fields = {}) {
  if (!enabled()) return null;
  try {
    const span = getTracer()?.startSpan("gateway.request", { attributes: { ...metadata(fields), "langfuse.observation.type": "span" } });
    const handle = { span, traceId: span?.spanContext().traceId, fields: { ...fields }, started: performance.now(), ended: false };
    state.inflight++; log("INFO", "request_started", handle); return handle;
  } catch { recordDrop("init_failed"); return null; }
}
export function attachRequestIdentity(handle, fields = {}) {
  if (!handle || handle.ended) return;
  try {
    if (id(fields.requestId)) handle.fields.requestId = fields.requestId;
    if (id(fields.approvedProjectId)) handle.fields.approvedProjectId = fields.approvedProjectId;
    handle.span?.setAttributes(metadata(handle.fields));
  } catch { recordDrop("export_failed"); }
}
export function startAttempt(root, fields = {}) {
  if (!enabled() || !root) return null;
  try {
    const combined = { ...root.fields, ...fields };
    if (fields.fallbackReason && fields.fallbackReason !== "primary") inc("fallbacks_total", { reason: reason(fields) });
    const ctx = root.span ? trace.setSpan(context.active(), root.span) : context.active();
    const span = getTracer()?.startSpan("gateway.generation", { attributes: { ...metadata(combined), ...generationAttributes(combined) } }, ctx);
    return { span, fields: combined, started: performance.now(), ended: false, root };
  } catch { recordDrop("init_failed"); return null; }
}
export function endAttempt(handle, fields = {}) {
  if (!handle || handle.ended) return;
  handle.ended = true;
  try {
    const combined = { ...handle.fields, ...fields };
    const state = outcome(combined); const p = labelProvider(combined.provider);
    const attrs = generationAttributes(combined);
    handle.span?.setAttributes({ ...attrs, "gateway.outcome": state, "gateway.error_class": reason(combined) });
    if (state === "error") handle.span?.setStatus({ code: SpanStatusCode.ERROR });
    inc("attempts_total", { provider: p, outcome: state, reason: state === "success" ? "unknown" : reason(combined) });
    if (Number.isInteger(combined.observedUpstreamHttpStatus) && combined.observedUpstreamHttpStatus >= 500 && combined.observedUpstreamHttpStatus <= 599) inc("upstream_http_5xx_attempts_total", { provider: p });
    const usage = attrs["langfuse.observation.usage_details"] ? JSON.parse(attrs["langfuse.observation.usage_details"]) : {};
    if (combined.usageComplete === false || !finite(usage.input) || !finite(usage.output)) inc("usage_unknown_total", { provider: p });
    for (const type of ["input", "output", "cached_input", "cache_write", "reasoning"]) if (finite(usage[type])) inc("tokens_total", { provider: p, type }, usage[type]);
    if (finite(combined.upstreamFirstContentMs)) {
      observe("upstream_first_content_seconds", { provider: p }, combined.upstreamFirstContentMs / 1000);
      handle.span?.setAttribute("langfuse.observation.completion_start_time", new Date(Date.now() - (performance.now() - handle.started) + combined.upstreamFirstContentMs).toISOString());
    }
    handle.span?.end(); log(state === "error" ? "ERROR" : "INFO", "attempt_completed", handle, { outcome: state, reason: reason(combined) });
  } catch { recordDrop("export_failed"); }
}
export function endRequest(handle, fields = {}) {
  if (!handle || handle.ended) return;
  handle.ended = true; state.inflight = Math.max(0, state.inflight - 1);
  try {
    const combined = { ...handle.fields, ...fields }; const state = outcome(combined); const combo = labelCombo(combined.resolvedCombo || combined.combo || combined.requestedAlias);
    handle.fields = combined;
    inc("requests_total", { combo, outcome: state });
    observe("request_duration_seconds", { combo, outcome: state }, (performance.now() - handle.started) / 1000);
    const first = combined.clientFirstContentMs ?? combined.downstreamFirstContentMs;
    if (finite(first) && !handle.clientFirstRecorded) observe("client_first_content_seconds", { combo }, first / 1000);
    handle.span?.setAttributes({ ...metadata(combined), "gateway.outcome": state });
    if (state === "error") handle.span?.setStatus({ code: SpanStatusCode.ERROR });
    handle.span?.end(); log(state === "error" ? "ERROR" : "INFO", "request_completed", handle, { outcome: state });
  } catch { recordDrop("export_failed"); }
}
export function confirmedEmptyStream(handle) {
  if (!handle?.ended || outcome(handle.fields) !== "success" || handle.confirmedEmptyRecorded) return;
  handle.confirmedEmptyRecorded = true;
  try { inc("confirmed_empty_streams_total", { combo: labelCombo(handle.fields.resolvedCombo || handle.fields.combo || handle.fields.requestedAlias) }); }
  catch { recordDrop("export_failed"); }
}
export function event(root, name, fields = {}) {
  if (!enabled() || !events.has(name)) return;
  try {
    if (name === "ledger_write_failure") ledgerFailure();
    if (name === "fallback") inc("fallbacks_total", { reason: reason(fields) });
    if (name === "policy_application_failure") inc("policy_application_failures_total", { reason: "policy" });
    if (name === "unsupported_accounting_transport") inc("unsupported_accounting_transport_total", { transport: ["fetch", "native", "undici", "websocket", "http2"].includes(fields.transport) ? fields.transport : "other" });
    if (name === "client_first_content" && root && !root.clientFirstRecorded && finite(fields.durationMs)) {
      root.clientFirstRecorded = true;
      observe("client_first_content_seconds", { combo: labelCombo(root.fields.resolvedCombo || root.fields.combo || root.fields.requestedAlias) }, fields.durationMs / 1000);
    }
    root?.span?.addEvent(name, { "gateway.reason": reason(fields) });
    log(name.includes("failure") ? "ERROR" : "INFO", name, root, { reason: reason(fields) });
  } catch { recordDrop("export_failed"); }
}

function labelsText(labels) { return `{${Object.entries(labels).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(",")}}`; }
export function metricsText() {
  const lines = [];
  const counterNames = ["requests_total", "attempts_total", "upstream_http_5xx_attempts_total", "confirmed_empty_streams_total", "tokens_total", "fallbacks_total", "policy_application_failures_total", "usage_unknown_total", "ledger_write_failures_total", "telemetry_dropped_total", "unsupported_accounting_transport_total"];
  for (const name of counterNames) lines.push(`# TYPE nine_router_${name} counter`);
  for (const [key, value] of counters) { const sep = key.indexOf("|"); lines.push(`nine_router_${key.slice(0, sep)}${labelsText(JSON.parse(key.slice(sep + 1)))} ${value}`); }
  for (const name of ["request_duration_seconds", "upstream_first_content_seconds", "client_first_content_seconds"]) lines.push(`# TYPE nine_router_${name} histogram`);
  for (const [key, h] of histograms) {
    const sep = key.indexOf("|"); const name = `nine_router_${key.slice(0, sep)}`; const labels = JSON.parse(key.slice(sep + 1));
    buckets.forEach((b, i) => lines.push(`${name}_bucket${labelsText({ ...labels, le: b })} ${h.buckets[i]}`));
    lines.push(`${name}_bucket${labelsText({ ...labels, le: "+Inf" })} ${h.count}`, `${name}_sum${labelsText(labels)} ${h.sum}`, `${name}_count${labelsText(labels)} ${h.count}`);
  }
  const cpu = process.cpuUsage();
  const gauges = { inflight_requests: state.inflight, export_queue_size: state.processor?.size || 0, process_resident_memory_bytes: process.memoryUsage().rss, process_start_time_seconds: state.processStartTime, event_loop_delay_seconds: state.eventLoop && Number.isFinite(state.eventLoop.mean) ? state.eventLoop.mean / 1e9 : 0 };
  for (const [name, value] of Object.entries(gauges)) lines.push(`# TYPE nine_router_${name} gauge`, `nine_router_${name}${labelsText({ environment })} ${value}`);
  lines.push("# TYPE nine_router_process_cpu_seconds_total counter", `nine_router_process_cpu_seconds_total${labelsText({ environment })} ${(cpu.user + cpu.system) / 1e6}`);
  return lines.join("\n") + "\n";
}
export async function metricsResponse(request) {
  if (!enabled()) return new Response(null, { status: 404 });
  const expected = process.env.TELE_PROXY_METRICS_TOKEN;
  const supplied = request.headers.get("authorization") || "";
  const a = Buffer.from(supplied); const b = Buffer.from(`Bearer ${expected || ""}`);
  if (!expected || expected.length < 16 || a.length !== b.length || !timingSafeEqual(a, b)) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!state.eventLoop) { state.eventLoop = monitorEventLoopDelay({ resolution: 20 }); state.eventLoop.enable(); }
  return new Response(metricsText(), { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
}
export async function flushTelemetry() { await state.processor?.forceFlush(); const deadline = Date.now() + 2100; while ((state.logWriting || logQueue.length) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10)); }
export async function shutdownTelemetry({ reset = false } = {}) {
  if (!state.shutdown) state.shutdown = (async () => {
    await flushTelemetry(); await state.provider?.shutdown(); state.eventLoop?.disable();
    state.processor = undefined; state.provider = undefined; state.tracer = undefined;
    state.eventLoop = undefined; state.initFailed = false;
  })();
  try { await state.shutdown; } finally { state.shutdown = undefined; }
  // Explicit isolation for module-reset tests; production shutdown preserves counters.
  if (reset) { counters.clear(); histograms.clear(); logQueue.length = 0; state.inflight = 0; }
}
