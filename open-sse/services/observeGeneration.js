// Side parsing only: bytes are never retained beyond the current bounded message,
// changed, logged, or consumed ahead of the caller.
const MESSAGE_LIMIT = 64 * 1024;
const JSON_LIMIT = 1024 * 1024;
const DECODE_SLICE = 8192;

const nonempty = (value) => typeof value === "string" && value.length > 0;
const numeric = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function hasContent(value, depth = 0) {
  if (depth > 16) return false;
  if (nonempty(value)) return true;
  const nested = (entry) => hasContent(entry, depth + 1);
  if (Array.isArray(value)) return value.some(nested);
  if (!object(value)) return false;
  return [value.text, value.thinking, value.reasoning, value.reasoning_content,
    value.content, value.summary, value.output_text, value.partial_json].some(nested)
    || (object(value.function) && (nonempty(value.function.name) || nested(value.function)))
    || (object(value.function_call) && (nonempty(value.function_call.name) || nested(value.function_call)))
    || (object(value.functionCall) && (nonempty(value.functionCall.name) || nested(value.functionCall)))
    || (Array.isArray(value.tool_calls) && value.tool_calls.some(nested))
    || (Array.isArray(value.parts) && value.parts.some(nested))
    || ((value.type === "function_call" || value.type === "tool_use"
      || "arguments" in value || "args" in value)
      && (nonempty(value.name) || nonempty(value.arguments)
        || (object(value.args) && Object.keys(value.args).length > 0)
        || (object(value.input) && Object.keys(value.input).length > 0)));
}

// Copy numeric usage and explicitly allowlisted provenance only. Arbitrary
// upstream strings or content inside `usage` never reach accounting callbacks.
function numericUsage(value, depth = 0) {
  if (!object(value) || depth > 3) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (numeric(entry)) Object.defineProperty(result, key, { value: entry, enumerable: true, writable: true, configurable: true });
    else if (depth === 0 && key === "estimated" && entry === true) result.estimated = true;
    else if (depth === 0 && key === "source" && ["estimated", "reported"].includes(entry)) result.source = entry;
    else if (object(entry)) {
      const nested = numericUsage(entry, depth + 1);
      if (Object.keys(nested).length) Object.defineProperty(result, key, { value: nested, enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

function completeUsage(usage) {
  return (numeric(usage.prompt_tokens) && numeric(usage.completion_tokens))
    || (numeric(usage.input_tokens) && numeric(usage.output_tokens))
    || (numeric(usage.promptTokenCount) && numeric(usage.candidatesTokenCount));
}

/**
 * Transparent, demand-driven observation of a physical or final client Response.
 * Callbacks are optional, awaited, and isolated from inference failures.
 * onUsage(numericUsageWithOptionalEstimateProvenance, responseModel?) runs at most once, before onEnd.
 * onEnd({status, errorClass, cancelState, usageComplete, responseModel}) runs once
 * on EOF, read failure, cancellation, or signal abort, never merely on headers.
 * Status: completed | error | cancelled. Missing stream terminal is an error.
 * SSE/NDJSON side messages are capped at 64 Ki code units; JSON at 1 MiB.
 * Oversized/malformed observation drops usage certainty, never forwarded bytes;
 * later complete usage can recover it. Unknown/binary media remain unparsed.
 * Anthropic message_delta totals replace earlier totals, never accumulate.
 * usageComplete is false for missing/partial/oversized/unparseable usage.
 */
export function observeGeneration(response, { signal, usageKind, onFirstContent, onUsage, onEnd } = {}) {
  const headers = new Headers(response.headers || undefined);
  const status = response.status ?? 200;
  const httpError = status >= 400;
  const type = (headers.get("content-type") || "").toLowerCase().split(";", 1)[0].trim();
  const format = type === "text/event-stream" ? "sse"
    : type === "application/x-ndjson" || type === "application/ndjson" ? "ndjson"
      : type === "application/json" || type.endsWith("+json") ? "json" : "unknown";
  const normalized = response instanceof Response ? response : new Response(response.body ?? null, {
    status, statusText: response.statusText || "", headers,
  });
  const reader = normalized.body?.getReader();
  const decoder = new TextDecoder();
  let responseModel = null;
  let usage = null;
  let usageIsComplete = false;
  let terminal = false;
  let providerError = false;
  let incomplete = false;
  let anthropic = false;
  let anthropicOutputUsage = false;
  let firstContent = false;
  let finished = false;
  let finishPromise;
  let controller;
  let line = "";
  let eventData = [];
  let eventSize = 0;
  let eventName = "";
  let discardLine = false;
  let discardEvent = false;
  let pendingCR = false;
  let json = "";
  let jsonSize = 0;
  let jsonOversized = false;
  let sawJson = false;
  let firstPending = false;

  async function safeCall(callback, ...args) {
    if (typeof callback !== "function") return;
    try { await callback(...args); } catch { /* Observation must not fail inference. */ }
  }

  function loseObservation() {
    usageIsComplete = false;
    // A later complete usage message can restore certainty after a dropped event.
    usage = null;
  }

  function observeUsage(raw, merge = false) {
    if (!object(raw)) return;
    const next = numericUsage(raw);
    // Embedding protocols report only consumed tokens; equal totals prove no generated tokens.
    if (usageKind === "embedding" && Number.isSafeInteger(raw.prompt_tokens) && raw.prompt_tokens >= 0
      && raw.total_tokens === raw.prompt_tokens && !Object.hasOwn(raw, "completion_tokens") && !Object.hasOwn(raw, "output_tokens")) {
      next.completion_tokens = 0;
    }
    if (!Object.keys(next).length) return;
    usage = merge ? { ...usage, ...next } : next;
    usageIsComplete = completeUsage(usage);
  }

  function content(value) {
    if (!firstContent && hasContent(value)) {
      firstContent = true;
      firstPending = true;
    }
  }

  function observeValue(value, depth = 0) {
    if (depth > 16) { loseObservation(); return; }
    if (Array.isArray(value)) {
      for (const entry of value) observeValue(entry, depth + 1);
      return;
    }
    if (!object(value)) return;
    sawJson = true;
    if (nonempty(value.model)) responseModel = value.model;
    // System One classifier answers use a distinct envelope, not chat choices.
    if (object(value.answers?.route) && nonempty(value.answers.route.choice)) content(value.answers.route.choice);
    if (value.error || value.type === "error" || value.type === "response.failed") {
      providerError = true;
      terminal = true;
    }
    if (value.type === "response.incomplete") {
      incomplete = true;
      terminal = true;
    }
    if (value.type === "response.completed" || value.type === "response.failed" || value.type === "response.incomplete") {
      terminal = true;
      observeValue(value.response, depth + 1);
    }
    else if (object(value.response) && (Array.isArray(value.response.candidates)
      || object(value.response.usageMetadata) || nonempty(value.response.modelVersion))) {
      observeValue(value.response, depth + 1);
    }
    if (value.object === "response" || Array.isArray(value.output)) {
      content(value.output);
      if (value.status === "completed") terminal = true;
      if (value.status === "failed") { terminal = true; providerError = true; }
      if (value.status === "incomplete") incomplete = true;
      if (format === "json" && (value.status === "in_progress" || value.status === "queued")) incomplete = true;
    }
    if (/^response\.(?:output_text|reasoning_text|reasoning_summary_text|function_call_arguments)\.delta$/.test(value.type || "")) content(value.delta);
    if (value.type === "response.output_item.added" || value.type === "response.output_item.done") content(value.item);
    if (value.type === "response.content_part.added" || value.type === "response.content_part.done") content(value.part);
    if (Array.isArray(value.choices)) {
      for (const choice of value.choices) {
        content(choice?.delta);
        content(choice?.message);
        content(choice?.text);
        if (choice?.finish_reason != null) terminal = true;
      }
    }
    if (value.type === "message_start") {
      anthropic = true;
      if (nonempty(value.message?.model)) responseModel = value.message.model;
      observeUsage(value.message?.usage, true);
      content(value.message?.content);
    }
    if (value.type === "content_block_start") content(value.content_block);
    if (value.type === "content_block_delta") {
      content(value.delta);
    }
    if (value.type === "message_delta") {
      anthropicOutputUsage ||= numeric(value.usage?.output_tokens);
      observeUsage(value.usage, true);
    }
    if (value.type === "message_stop") terminal = true;
    if (value.type === "message" || Array.isArray(value.content)) content(value.content);
    if (Array.isArray(value.candidates)) {
      for (const candidate of value.candidates) {
        content(candidate?.content);
        if (nonempty(candidate?.finishReason)) terminal = true;
      }
    }
    if (nonempty(value.modelVersion)) responseModel = value.modelVersion;
    if (value.type !== "message_delta") observeUsage(value.usage);
    observeUsage(value.usageMetadata);
  }

  function parseMessage(text, name = "") {
    if (text.trim() === "[DONE]") { terminal = true; return; }
    if (!text.trim()) return;
    try {
      const value = JSON.parse(text);
      if (name && object(value) && !value.type) value.type = name;
      observeValue(value);
    } catch { loseObservation(); }
  }

  function endLine() {
    if (format === "ndjson") {
      if (!discardLine) parseMessage(line);
      line = "";
      discardLine = false;
      return;
    }
    if (!line && !discardLine) {
      if (!discardEvent && eventData.length) parseMessage(eventData.join("\n"), eventName);
      eventData = [];
      eventSize = 0;
      eventName = "";
      discardEvent = false;
    } else if (!discardLine && !discardEvent && (line === "data" || line.startsWith("data:"))) {
      const data = line === "data" ? "" : line.slice(line[5] === " " ? 6 : 5);
      eventSize += data.length + 1;
      if (eventSize > MESSAGE_LIMIT) { discardEvent = true; eventData = []; loseObservation(); }
      else eventData.push(data);
    } else if (!discardLine && !discardEvent && line.startsWith("event:")) {
      eventName = line.slice(line[6] === " " ? 7 : 6);
    }
    line = "";
    discardLine = false;
  }

  function parseText(text) {
    if (format === "json") {
      if (!jsonOversized) json += text;
      return;
    }
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (pendingCR) {
        pendingCR = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        endLine();
        pendingCR = char === "\r";
      } else if (!discardLine && !discardEvent) {
        if (line.length + eventSize >= MESSAGE_LIMIT) {
          line = "";
          discardLine = true;
          if (format === "sse") { discardEvent = true; eventData = []; }
          loseObservation();
        } else line += char;
      } else if (discardEvent) {
        // Remember only whether the discarded SSE line is empty, to resync at
        // the next event boundary without retaining any of its payload.
        discardLine = true;
      }
    }
  }

  async function feed(bytes) {
    if (httpError || format === "unknown") return;
    if (format === "json") {
      jsonSize += bytes.byteLength;
      if (jsonSize > JSON_LIMIT) { jsonOversized = true; json = ""; loseObservation(); return; }
    }
    for (let offset = 0; offset < bytes.byteLength; offset += DECODE_SLICE) {
      parseText(decoder.decode(bytes.subarray(offset, offset + DECODE_SLICE), { stream: true }));
    }
    if (firstPending) { firstPending = false; await safeCall(onFirstContent); }
  }

  async function finish(kind, errorClass = null, cancelState = "none") {
    if (finished) return finishPromise;
    finished = true;
    signal?.removeEventListener("abort", abort);
    finishPromise = (async () => {
      if (kind === "completed" && !httpError && format !== "unknown") {
        parseText(decoder.decode());
        if (format === "json") {
          if (!jsonOversized) parseMessage(json);
          json = "";
          if (!sawJson || jsonOversized) incomplete = true;
        } else {
          if (line || discardLine) endLine();
          if (format === "sse" && eventData.length && !discardEvent) parseMessage(eventData.join("\n"), eventName);
          if (!terminal) incomplete = true;
        }
      }
      if (firstPending) { firstPending = false; await safeCall(onFirstContent); }
      if (httpError && kind !== "cancelled") { kind = "error"; errorClass = "http_error"; }
      else if (kind === "completed" && providerError) { kind = "error"; errorClass = "provider_error"; }
      else if (kind === "completed" && incomplete) { kind = "error"; errorClass = "incomplete_stream"; }
      if (usage && !httpError) await safeCall(onUsage, usage, responseModel || undefined);
      await safeCall(onEnd, {
        status: kind, errorClass, cancelState,
        usageComplete: !httpError && usageIsComplete && (format === "json" || terminal)
          && (!anthropic || anthropicOutputUsage),
        responseModel,
      });
      line = "";
      eventData = [];
      json = "";
    })();
    return finishPromise;
  }

  function abort() {
    const reason = signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    // Cancel the reader even before the downstream caller starts reading.
    const cancellation = reader ? reader.cancel(reason) : Promise.resolve();
    cancellation.catch(() => {});
    void finish("cancelled", "aborted", "aborted").then(() => {
      try { controller?.error(reason); } catch { /* Already closed/cancelled. */ }
    });
  }

  const body = reader ? new ReadableStream({
    start(streamController) {
      controller = streamController;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(streamController) {
      if (finished) return;
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) {
          await finish("completed");
          streamController.close();
        } else {
          try { await feed(result.value); } catch { loseObservation(); }
          if (!finished) streamController.enqueue(result.value);
        }
      } catch (error) {
        await finish("error", "stream_error");
        try { streamController.error(error); } catch { /* Cancelled concurrently. */ }
      }
    },
    async cancel(reason) {
      const cancellation = reader.cancel(reason);
      cancellation.catch(() => {});
      await finish("cancelled", "cancelled", "cancelled");
      await cancellation;
    },
  }, { highWaterMark: 0 }) : null;

  if (!reader) {
    if (signal?.aborted) void finish("cancelled", "aborted", "aborted");
    else void finish("completed");
  }
  return new Response(body, { status, statusText: response.statusText || "", headers });
}
