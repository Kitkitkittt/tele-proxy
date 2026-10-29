import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getComboByName } from "./db/repos/combosRepo.js";
import { getApiKeyByKey } from "./db/repos/apiKeysRepo.js";
import { snapshotComboPolicy } from "./comboPolicy.js";
import * as ledger from "./requestLedger.js";
import * as telemetry from "./gatewayTelemetry.js";
import { captureProjectDiagnostic } from "./privacyDiagnostics.js";
import { applyComboPolicy } from "../../open-sse/services/comboPolicy.js";
import { withDispatchContext, withDispatchMetadata } from "../../open-sse/services/dispatchContext.js";
import { observeGeneration } from "../../open-sse/services/observeGeneration.js";
import { parseSuffix, extractThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const storageKey = Symbol.for("tele-proxy.requestStorage");
const storage = globalThis[storageKey] ||= new AsyncLocalStorage();
const enabled = () => process.env.TELE_PROXY_ENABLED === "1";
const policyActive = (policy) => policy?.enabled === true && policy?.mergeMode !== "off";
const elapsed = (started) => Math.max(0, Math.round(performance.now() - started));
const initializationKey = Symbol.for("tele-proxy.initialization");

function safeTelemetry(name, ...args) {
  try { return telemetry[name](...args); } catch { return null; }
}
async function persist(callback) {
  try { return await callback(); }
  catch { safeTelemetry("ledgerFailure"); return null; }
}
function errorResponse(status, message) {
  return Response.json({ error: { message, type: "gateway_error" } }, { status });
}
function policyError(error) {
  return ["COMBO_POLICY_REQUIRED", "COMBO_POLICY_INVALID", "COMBO_POLICY_UNSUPPORTED", "REQUIRED_POLICY_UNSUPPORTED"].includes(error?.code);
}

/** Optional feature state never shares the installed gateway's startup or data path. */
export function initializeTeleProxy() {
  if (!enabled()) return Promise.resolve();
  if (!globalThis[initializationKey]) globalThis[initializationKey] = (async () => {
    await ledger.recoverAbandoned();
    await ledger.pruneLedger({ retentionDays: 90 });
    const timer = setInterval(() => persist(() => ledger.pruneLedger({ retentionDays: 90 })), 86_400_000);
    timer.unref();
  })();
  return globalThis[initializationKey];
}

/** Interpret a suffix only when its base really is a stored combo, never for provider model IDs. */
export async function resolveGatewayTarget(body, target) {
  if (!enabled() || typeof target !== "string" || target.includes("/") || await getComboByName(target)) return target;
  let parsed = parseSuffix(target);
  if (parsed.cleanModel === target) {
    const colon = target.match(/^(.*):(none|off|auto|minimal|low|medium|high|xhigh|max|ultra)$/);
    if (colon) parsed = parseSuffix(`${colon[1]}(${colon[2]})`);
  }
  if (!parsed.override || !await getComboByName(parsed.cleanModel)) return target;
  if (!extractThinking(body)) {
    const intent = parsed.override;
    if (intent.mode === "level") body.reasoning_effort = intent.level;
    else if (intent.mode === "budget") body.thinking = { type: "enabled", budget_tokens: intent.budget };
    else if (intent.mode === "none") body.reasoning_effort = "none";
    else body.reasoning = { ...(body.reasoning || {}), effort: "auto" };
  }
  body.model = parsed.cleanModel;
  return parsed.cleanModel;
}

const clientFamilies = ["codex", "opencode", "claude", "omp", "pi"].map(family =>
  [family, new RegExp(`(?:^|[ /;-])${family}(?:[ /;.-]|$)`)]);
function clientFamily(request) {
  const agent = request.headers.get("user-agent")?.toLowerCase() || "";
  for (const [family, pattern] of clientFamilies) {
    if (pattern.test(agent)) return family;
  }
  return "unknown";
}
function classifyHttp(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return status >= 400 ? "upstream" : null;
}
function fallbackReason(root, role = "generation") {
  const previous = root.attempts.filter((attempt) => attempt.role === role);
  if (!previous.length) return "primary";
  const lastError = previous[previous.length - 1].errorClass;
  if (lastError === "auth") return "auth_refresh";
  if (lastError === "rate_limit") return "rate_limit";
  return lastError ? "upstream_error" : "retry";
}

async function dispatch(root, details, send) {
  const wireModel = typeof details.body?.model === "string" ? details.body.model
    : typeof details.body?.request?.model === "string" ? details.body.request.model
    : details.requestedModel || details.model;
  const role = details.dispatchRole === "classifier" ? "classifier" : "generation";
  const started = performance.now();
  let row = root.row ? await persist(() => ledger.startAttempt(root.row.requestId, {
    provider: details.provider, requestedModel: wireModel, connectionId: details.connectionId,
    fallbackReason: fallbackReason(root, role),
  })) : null;
  if (!row) root.accountingIncomplete = true;
  const span = safeTelemetry("startAttempt", root.span, {
    provider: details.provider, model: wireModel, attemptId: row?.attemptId,
    fallbackReason: fallbackReason(root, role), policyId: root.policy?.policyId,
    policyVersion: root.policy?.version, policyHash: root.policy?.hash,
  });
  const attempt = { row, span, started, role, executionId: details.executionId, firstContent: null, usage: null, model: null, settled: false };
  root.attempts.push(attempt);
  const settle = async (result) => {
    if (attempt.settled) return;
    attempt.settled = true;
    if (Number.isInteger(result.httpStatus)) attempt.httpStatus = result.httpStatus;
    const timedOut = details.signal?.aborted && details.signal.reason?.name === "TimeoutError";
    const cancelled = result.status === "cancelled" && !timedOut;
    const status = cancelled ? "cancelled" : timedOut || result.status === "error" ? "error" : "success";
    const errorClass = cancelled ? "cancelled" : timedOut ? "timeout" : result.errorClass === "http_error" ? classifyHttp(attempt.httpStatus) || "upstream" : result.errorClass ? "upstream" : null;
    attempt.errorClass = errorClass;
    const fields = {
      status, errorClass, cancelState: cancelled ? "client_cancelled" : "none",
      usage: attempt.usage, format: details.format, usageComplete: result.usageComplete,
      usageSource: attempt.usage?.estimated === true || attempt.usage?.source === "estimated" ? "estimated" : undefined,
      responseModel: result.responseModel || attempt.model,
      upstreamFirstContentMs: attempt.firstContent,
      downstreamFirstContentMs: root.firstContent === null ? null : Math.max(0, Math.round(root.firstContent - started)),
    };
    if (row) {
      const saved = await persist(() => ledger.finishAttempt(row.attemptId, fields));
      if (!saved) root.accountingIncomplete = true;
      row = saved;
    }
    safeTelemetry("endAttempt", span, { ...fields, httpStatus: attempt.httpStatus, durationMs: elapsed(started), ...(row || {}), usage: ledger.normalizeUsage(attempt.usage, details.format) });
  };
  attempt.settle = settle;
  attempt.observe = (response) => {
    attempt.httpStatus = response.status;
    return observeGeneration(response, {
      signal: details.signal,
      usageKind: details.usageKind,
      onFirstContent() { attempt.firstContent ??= elapsed(started); },
      onUsage(usage, model) { attempt.usage = usage; attempt.model = model; },
      onEnd: settle,
    });
  };
  if (typeof details.observeNative === "function") {
    attempt.nativeManaged = true;
    details.observeNative({
      onFirstContent() { attempt.firstContent ??= elapsed(started); },
      onUsage(usage, model) { attempt.usage = usage; attempt.model = model; },
      onEnd: settle,
    });
  }
  try {
    const result = await send();
    if (attempt.nativeManaged) return result;
    const response = result instanceof Response ? result : result?.response;
    if (!response?.body?.getReader || (details.nativeResponse === true && response.status < 400)) {
      attempt.nativePending = true;
      return result;
    }
    attempt.httpStatus = response.status;
    if (response.status >= 400) {
      await settle({ status: "error", errorClass: "http_error", usageComplete: false });
      return result;
    }
    const observed = attempt.observe(response);
    return result instanceof Response ? observed : { ...result, response: observed };
  } catch (error) {
    await settle({ status: error?.name === "AbortError" ? "cancelled" : "error", errorClass: "stream_error", usageComplete: false });
    throw error;
  }
}

/** Called after auth/model access checks. Arbitrary project/policy headers are never read. */
export async function withGatewayRequest({ request, body, target, requestedAlias, authenticatedKey }, callback) {
  if (!enabled()) return callback();
  try { await initializeTeleProxy(); }
  catch { safeTelemetry("ledgerFailure"); return errorResponse(503, "Gateway accounting initialization failed"); }
  const combo = await getComboByName(target);
  let policy;
  let invalidPolicy = false;
  try { policy = combo ? await snapshotComboPolicy(combo.name) : null; }
  catch { invalidPolicy = true; }
  const identity = authenticatedKey ? await getApiKeyByKey(authenticatedKey) : null;
  const family = clientFamily(request);
  const span = safeTelemetry("startRequest", {
    combo: combo?.name || "direct", requestedAlias, clientFamily: family,
    traceparent: request.headers.get("traceparent"), policyId: policy?.policyId,
    policyVersion: policy?.version, policyHash: policy?.hash,
  });
  const row = await persist(() => ledger.startRequest({
    traceId: span?.traceId, authenticatedKeyId: identity?.isActive ? identity.id : null,
    clientFamily: family, requestedAlias, resolvedCombo: combo?.name,
    reasoningEffort: extractThinking(body)?.level || null,
    policyId: policy?.policyId, policyVersion: policy?.version, policyHash: policy?.hash,
    policyAppliedStatus: invalidPolicy ? "failed" : policyActive(policy) ? "pending" : "off",
  }));
  safeTelemetry("attachRequestIdentity", span, { requestId: row?.requestId, approvedProjectId: row?.approvedProjectId });
  const root = { row, span, policy, request, attempts: [], started: performance.now(), firstContent: null, policyStatus: policyActive(policy) ? "pending" : "off", done: false, accountingIncomplete: false };
  const finish = async (finalStatus) => {
    if (root.done) return;
    root.done = true;
    for (const attempt of root.attempts) {
      if (!attempt.settled) await attempt.settle({ status: finalStatus === "cancelled" ? "cancelled" : "error", errorClass: "incomplete_stream", usageComplete: false });
    }
    if (row) await persist(() => ledger.finishRequest(row.requestId, { finalStatus, policyAppliedStatus: root.policyStatus, accountingIncomplete: root.accountingIncomplete }));
    safeTelemetry("endRequest", span, { status: finalStatus, durationMs: elapsed(root.started), clientFirstContentMs: root.firstContent === null ? null : Math.max(0, Math.round(root.firstContent - root.started)), policyAppliedStatus: root.policyStatus });
    if (row?.approvedProjectId) {
      const outcome = finalStatus === "success" || finalStatus === "cancelled" ? finalStatus : "error";
      const diagnostic = { event: "request", outcome, durationMs: elapsed(root.started) };
      if (root.firstContent !== null) diagnostic.clientFirstContentMs = Math.max(0, Math.round(root.firstContent - root.started));
      void captureProjectDiagnostic(row.approvedProjectId, diagnostic, row.requestId).catch((error) => {
        if (error?.status !== 403) safeTelemetry("recordDrop", "diagnostic_failed");
      });
    }
  };
  if (invalidPolicy) {
    root.policyStatus = "failed";
    safeTelemetry("event", span, "policy_application_failure", { reason: "policy" });
    await finish("policy_failed");
    return errorResponse(400, "Combo policy validation failed");
  }
  const context = {
    signal: request.signal,
    requiredPolicy: policyActive(policy) && policy.required === true,
    policyTokenEstimate: policy?.estimatedTokens || 0,
    execute: (details, send) => dispatch(root, details, send),
    markPolicyUnsupported() {
      if (!policyActive(policy)) return;
      root.policyStatus = "unsupported";
      safeTelemetry("event", span, "policy_unsupported", { reason: "transport" });
    },
    markDispatchUnsupported(details) {
      root.accountingIncomplete = true;
      safeTelemetry("event", span, "unsupported_accounting_transport", { reason: details.reason, transport: details.transport });
    },
  };
  try {
    const response = await storage.run(root, () => withDispatchContext(context, callback));
    if (!(response instanceof Response)) { await finish("error"); return response; }
    if (!response.body || response.status >= 400) { await finish(response.status >= 400 ? "error" : "success"); return response; }
    return observeGeneration(response, {
      signal: request.signal,
      async onFirstContent() {
        root.firstContent = performance.now();
        safeTelemetry("event", span, "client_first_content", { durationMs: elapsed(root.started) });
        const attempt = root.attempts.at(-1);
        if (attempt?.row) await persist(() => ledger.recordDownstreamFirstContent(attempt.row.attemptId, elapsed(attempt.started)));
      },
      onEnd: (result) => finish(result.status === "cancelled" ? "cancelled" : result.status === "error" ? "error" : "success"),
    });
  } catch (error) {
    if (policyError(error)) {
      root.policyStatus = "failed";
      safeTelemetry("event", span, "policy_application_failure", { reason: "policy" });
      await finish("policy_failed");
      return errorResponse(error.status || 400, "Required combo policy could not be applied");
    }
    await finish(request.signal.aborted ? "cancelled" : "error");
    return errorResponse(request.signal.aborted ? 499 : 502, "Gateway request failed");
  }
}

/** Transform a fresh native payload. Client text is not a deduplication authority. */
export function applyGatewayPolicy(body, format) {
  const root = storage.getStore();
  if (!policyActive(root?.policy)) return body;
  try {
    const result = applyComboPolicy(body, format, root.policy);
    root.policyStatus = "applied";
    safeTelemetry("event", root.span, "policy_applied", { policyVersion: root.policy.version, policyHash: root.policy.hash });
    return result;
  } catch (error) {
    root.policyStatus = "failed";
    throw error;
  }
}

export async function executeGatewayProvider(details, callback) {
  const root = storage.getStore();
  if (!root) return callback();
  const executionId = randomUUID();
  try {
    const result = await withDispatchMetadata({ ...details, executionId }, callback);
    const pending = root.attempts.filter((attempt) => attempt.executionId === executionId && attempt.nativePending && !attempt.settled);
    const response = result instanceof Response ? result : result?.response;
    if (pending.length && response?.body?.getReader) {
      const active = pending.pop();
      for (const prior of pending) await prior.settle({ status: "error", errorClass: "incomplete_stream", usageComplete: false });
      const observed = active.observe(response);
      return result instanceof Response ? observed : { ...result, response: observed };
    }
    return result;
  } catch (error) {
    for (const attempt of root.attempts) {
      if (attempt.executionId === executionId && !attempt.settled) {
        await attempt.settle({ status: error?.name === "AbortError" ? "cancelled" : "error", errorClass: "stream_error", usageComplete: false });
      }
    }
    throw error;
  }
}
export function gatewaySignal() { return storage.getStore()?.request.signal; }
export function isGatewayPolicyError(error) { return policyError(error); }
export function gatewayPolicyRequired() { const policy = storage.getStore()?.policy; return policyActive(policy) && policy.required === true; }
