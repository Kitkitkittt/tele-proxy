import { describe, it, expect } from "vitest";
import { observeGeneration } from "../../open-sse/services/observeGeneration.js";

const encoder = new TextEncoder();
const frame = (value, newline = "\n") => `data: ${typeof value === "string" ? value : JSON.stringify(value)}${newline}${newline}`;
const tick = () => new Promise((resolve) => queueMicrotask(resolve));

function source(chunks, type = "text/event-stream", options = {}) {
  let pulls = 0;
  let cancelled;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      if (chunks.length) controller.enqueue(typeof chunks[0] === "string" ? encoder.encode(chunks.shift()) : chunks.shift());
      else controller.close();
    },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers: { "content-type": type, "x-preserved": "yes" }, ...options }),
    pulls: () => pulls, cancelled: () => cancelled };
}

function observed(response, options = {}) {
  const first = [];
  const usage = [];
  const ends = [];
  const wrapped = observeGeneration(response, {
    onFirstContent: () => first.push(true),
    onUsage: (...args) => usage.push(args),
    onEnd: (end) => ends.push(end),
    ...options,
  });
  return { wrapped, first, usage, ends };
}

const chatUsage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const chatEnd = frame({ model: "real-model", choices: [], usage: chatUsage }) + frame("[DONE]");

describe("observeGeneration transparent consumer semantics", () => {
  it("does not pull before demand or consume ahead; preserves bytes, headers and status", async () => {
    const first = frame({ choices: [{ delta: { content: "one" } }] });
    const input = source([first, chatEnd], "text/event-stream", { status: 201, statusText: "Created" });
    const result = observed(input.response);
    await tick();
    expect(input.pulls()).toBe(0);
    expect(result.wrapped.status).toBe(201);
    expect(result.wrapped.statusText).toBe("Created");
    expect(result.wrapped.headers.get("x-preserved")).toBe("yes");
    const reader = result.wrapped.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
    await tick();
    expect(input.pulls()).toBe(1);
    expect(result.first).toHaveLength(1);
    expect(result.ends).toHaveLength(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(chatEnd);
    expect(result.ends).toHaveLength(0);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(result.usage).toEqual([[chatUsage, "real-model"]]);
    expect(result.ends).toEqual([{ status: "completed", errorClass: null, cancelState: "none", usageComplete: true, responseModel: "real-model" }]);
  });

  it("awaits accounting callbacks before EOF and isolates thrown/rejected callbacks", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const order = [];
    const input = source([frame({ choices: [{ delta: { content: "x" } }] }) + chatEnd]);
    const result = observed(input.response, {
      onFirstContent: () => { throw new Error("first callback failure"); },
      onUsage: async () => { order.push("usage"); throw new Error("usage callback failure"); },
      onEnd: async () => { order.push("end"); await gate; throw new Error("end callback failure"); },
    });
    let complete = false;
    const consumed = result.wrapped.text().then((text) => { complete = true; return text; });
    while (!order.includes("end")) await tick();
    expect(complete).toBe(false);
    expect(order).toEqual(["usage", "end"]);
    release();
    expect(await consumed).toContain("[DONE]");
  });

  it("propagates consumer cancellation without draining or completing successfully", async () => {
    const input = source([frame({ choices: [{ delta: { content: "x" } }] }), chatEnd]);
    const result = observed(input.response);
    const reader = result.wrapped.body.getReader();
    await reader.read();
    await reader.cancel("client left");
    expect(input.cancelled()).toBe("client left");
    expect(input.pulls()).toBe(1);
    expect(result.ends).toEqual([expect.objectContaining({ status: "cancelled", cancelState: "cancelled", usageComplete: false })]);
    expect(result.usage).toHaveLength(0);
  });

  it("aborts before any body consumer, cancels upstream and ends once", async () => {
    const input = source([chatEnd]);
    const signal = new AbortController();
    const result = observed(input.response, { signal: signal.signal });
    const reason = new DOMException("disconnect", "AbortError");
    signal.abort(reason);
    await expect(result.wrapped.text()).rejects.toBe(reason);
    expect(input.pulls()).toBe(0);
    expect(input.cancelled()).toBe(reason);
    expect(result.ends).toEqual([expect.objectContaining({ status: "cancelled", errorClass: "aborted", cancelState: "aborted" })]);
  });

  it("aborts pending reads rather than hanging or presenting a successful EOF", async () => {
    let cancelled;
    const pending = new Response(new ReadableStream({ cancel(reason) { cancelled = reason; } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    const signal = new AbortController();
    const result = observed(pending, { signal: signal.signal });
    const consumed = result.wrapped.text();
    await tick();
    signal.abort(new DOMException("gone", "AbortError"));
    await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(signal.signal.reason);
    expect(result.ends).toHaveLength(1);
    expect(result.ends[0].status).toBe("cancelled");
  });

  it("preserves read errors and does not reclassify a terminal-looking prefix as success", async () => {
    const failure = new Error("wire broke");
    let count = 0;
    const response = new Response(new ReadableStream({ pull(controller) {
      if (!count++) controller.enqueue(encoder.encode(chatEnd));
      else controller.error(failure);
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    const result = observed(response);
    await expect(result.wrapped.text()).rejects.toBe(failure);
    expect(result.ends).toEqual([expect.objectContaining({ status: "error", errorClass: "stream_error" })]);
  });

  it("normalizes Map headers on physical wrappers and retains native json/text methods", async () => {
    const input = source([JSON.stringify({ model: "m", choices: [{ message: { content: "json" } }], usage: chatUsage })], "application/json");
    const result = observed({ body: input.response.body, status: 202, statusText: "Accepted", headers: new Map(input.response.headers) });
    expect(await result.wrapped.json()).toMatchObject({ model: "m", usage: chatUsage });
    expect(result.wrapped.status).toBe(202);
    expect(result.first).toHaveLength(1);
    expect(result.usage).toEqual([[chatUsage, "m"]]);
    expect(result.ends[0]).toMatchObject({ status: "completed", usageComplete: true });
  });
});

describe("observeGeneration format accounting", () => {
  it("ignores headers, comments, role-only and empty deltas, then notices reasoning and tool content", async () => {
    const prefix = ": keepalive\n\n" + frame({ choices: [{ delta: { role: "assistant", content: "" } }] });
    const input = source([prefix, frame({ choices: [{ delta: { reasoning_content: "thought" } }] }), frame({ choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] }), chatEnd]);
    const result = observed(input.response);
    const reader = result.wrapped.body.getReader();
    await reader.read();
    expect(result.first).toHaveLength(0);
    await reader.read();
    expect(result.first).toHaveLength(1);
    while (!(await reader.read()).done) { /* Consume remaining physical chunks. */ }
    expect(result.first).toHaveLength(1);
  });

  it("handles split UTF-8, CRLF/CR frames, multiline data and unterminated final event", async () => {
    const multiline = 'event: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"猫"}}]}\r\n\r\n';
    const raw = multiline + frame({ choices: [{ finish_reason: "stop" }], usage: chatUsage }, "\r").trimEnd();
    const bytes = encoder.encode(raw);
    const input = source(Array.from(bytes, (byte) => new Uint8Array([byte])));
    const result = observed(input.response);
    expect(new Uint8Array(await result.wrapped.arrayBuffer())).toEqual(bytes);
    expect(result.first).toHaveLength(1);
    expect(result.usage[0][0]).toEqual(chatUsage);
    expect(result.ends[0].usageComplete).toBe(true);
  });

  it("uses Responses terminal usage and real output instead of lifecycle metadata", async () => {
    const usage = { input_tokens: 9, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } };
    const raw = frame({ type: "response.created", response: { id: "id", status: "in_progress" } })
      + frame({ type: "response.output_text.delta", delta: "answer" })
      + frame({ type: "response.completed", response: { object: "response", status: "completed", model: "response-model", usage } });
    const result = observed(source([raw]).response);
    await result.wrapped.text();
    expect(result.first).toHaveLength(1);
    expect(result.usage).toEqual([[usage, "response-model"]]);
    expect(result.ends[0]).toMatchObject({ status: "completed", usageComplete: true });
  });

  it("merges Anthropic input and cumulative output without addition or start usage certainty", async () => {
    const start = frame({ type: "message_start", message: { model: "claude", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 6 } } });
    const raw = start + frame({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reason" } })
      + frame({ type: "message_delta", usage: { output_tokens: 4 } })
      + frame({ type: "message_delta", usage: { output_tokens: 7 } })
      + frame({ type: "message_stop" });
    const result = observed(source([raw]).response);
    await result.wrapped.text();
    expect(result.first).toHaveLength(1);
    expect(result.usage).toEqual([[{ input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 6 }, "claude"]]);
    expect(result.ends[0].usageComplete).toBe(true);
    const missingDelta = observed(source([start + frame({ type: "message_stop" })]).response);
    await missingDelta.wrapped.text();
    expect(missingDelta.ends[0].usageComplete).toBe(false);
  });

  it("observes Gemini tool calls, finishReason and usageMetadata in NDJSON", async () => {
    const usage = { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 18, thoughtsTokenCount: 4 };
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: {} } }] } }] }) + "\n"
      + JSON.stringify({ modelVersion: "gemini", candidates: [{ finishReason: "STOP" }], usageMetadata: usage });
    const result = observed(source([raw], "application/x-ndjson").response);
    expect(await result.wrapped.text()).toBe(raw);
    expect(result.first).toHaveLength(1);
    expect(result.usage).toEqual([[usage, "gemini"]]);
    expect(result.ends[0].usageComplete).toBe(true);
  });

  it("observes the Antigravity Gemini response envelope for SSE and JSON", async () => {
    const usage = { promptTokenCount: 1234, candidatesTokenCount: 56, cachedContentTokenCount: 78, thoughtsTokenCount: 90 };
    const envelope = { response: { modelVersion: "gemini-real", candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: usage } };
    for (const [type, raw] of [["text/event-stream", frame(envelope)], ["application/json", JSON.stringify(envelope)]]) {
      const result = observed(source([raw], type).response);
      expect(await result.wrapped.text()).toBe(raw);
      expect(result.first).toHaveLength(1);
      expect(result.usage).toEqual([[usage, "gemini-real"]]);
      expect(result.ends[0]).toMatchObject({ status: "completed", usageComplete: true, responseModel: "gemini-real" });
    }
  });

  it("retains Cursor estimated provenance without leaking arbitrary metadata", async () => {
    const usage = { ...chatUsage, estimated: true, source: "estimated", secret: "do not expose" };
    const raw = frame({ choices: [{ finish_reason: "stop" }], usage });
    const result = observed(source([raw]).response);
    await result.wrapped.text();
    expect(result.usage).toEqual([[{ ...chatUsage, estimated: true, source: "estimated" }, undefined]]);
    expect(result.ends[0].usageComplete).toBe(true);
  });

  it("observes System One route answers but not arbitrary choice metadata", async () => {
    const usage = { input_tokens: 12, output_tokens: 2 };
    const classifier = observed(source([JSON.stringify({ answers: { route: { choice: "fast", confidence: 0.9 } }, usage })], "application/json").response);
    await classifier.wrapped.text();
    expect(classifier.first).toHaveLength(1);
    expect(classifier.usage).toEqual([[usage, undefined]]);
    const unrelated = observed(source([JSON.stringify({ choice: "not content", answers: { other: { choice: "not route" } }, usage })], "application/json").response);
    await unrelated.wrapped.text();
    expect(unrelated.first).toHaveLength(0);
  });

  it.each([
    [{ type: "response.failed", response: { status: "failed" } }, "provider_error"],
    [{ type: "error", error: { type: "overloaded_error" } }, "provider_error"],
    [{ type: "response.incomplete", response: { status: "incomplete" } }, "incomplete_stream"],
    [{ choices: [{ delta: { content: "truncated" } }] }, "incomplete_stream"],
  ])("does not report failed/truncated protocol as successful completion: %j", async (event, errorClass) => {
    const result = observed(source([frame(event)]).response);
    await result.wrapped.text();
    expect(result.ends).toEqual([expect.objectContaining({ status: "error", errorClass, usageComplete: false })]);
  });

  it("ignores physical retry HTTP error bodies including misleading usage and content", async () => {
    const raw = JSON.stringify({ model: "not-an-inference", choices: [{ message: { content: "error page" } }], usage: chatUsage });
    const result = observed(source([raw], "application/json", { status: 429 }).response);
    expect(await result.wrapped.text()).toBe(raw);
    expect(result.first).toHaveLength(0);
    expect(result.usage).toHaveLength(0);
    expect(result.ends[0]).toMatchObject({ status: "error", errorClass: "http_error", usageComplete: false, responseModel: null });
  });

  it("passes binary through and records unknown usage without inventing content", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const result = observed(source([bytes], "application/octet-stream").response);
    expect(new Uint8Array(await result.wrapped.arrayBuffer())).toEqual(bytes);
    expect(result.first).toHaveLength(0);
    expect(result.usage).toHaveLength(0);
    expect(result.ends[0]).toMatchObject({ status: "completed", usageComplete: false });
  });

  it("drops oversized event observation, forwards every byte, then recovers on terminal usage", async () => {
    const oversized = frame({ choices: [{ delta: { content: "x".repeat(70 * 1024) } }] });
    const raw = oversized + chatEnd;
    const result = observed(source([raw.slice(0, 100), raw.slice(100)]).response);
    expect(await result.wrapped.text()).toBe(raw);
    expect(result.first).toHaveLength(0);
    expect(result.usage).toEqual([[chatUsage, "real-model"]]);
    expect(result.ends[0]).toMatchObject({ status: "completed", usageComplete: true });
  });

  it("bounds accumulated multiline events as well as individual lines", async () => {
    const oversized = Array.from({ length: 90 }, () => `data: ${"x".repeat(1000)}\n`).join("") + "\n";
    const raw = oversized + frame("[DONE]");
    const result = observed(source([raw]).response);
    expect(await result.wrapped.text()).toBe(raw);
    expect(result.usage).toHaveLength(0);
    expect(result.ends[0].usageComplete).toBe(false);
  });

  it("does not retain certainty after corrupt or oversized usage and never loses JSON body", async () => {
    const broken = observed(source([chatEnd + "data: invalid-json\n\n"]).response);
    await broken.wrapped.text();
    expect(broken.ends[0].usageComplete).toBe(false);
    expect(broken.usage).toHaveLength(0);
    const raw = JSON.stringify({ choices: [{ message: { content: "x".repeat(1024 * 1024) } }], usage: chatUsage });
    const large = observed(source([raw], "application/json").response);
    expect(await large.wrapped.text()).toBe(raw);
    expect(large.first).toHaveLength(0);
    expect(large.usage).toHaveLength(0);
    expect(large.ends[0]).toMatchObject({ status: "error", errorClass: "incomplete_stream", usageComplete: false });
  });

  it("does not count empty tool metadata/signatures or trust nonnumeric usage", async () => {
    const raw = frame({ type: "content_block_delta", delta: { type: "signature_delta", signature: "signature" } })
      + frame({ choices: [{ delta: { tool_calls: [{ id: "id", type: "function", function: { name: "", arguments: "" } }] }, finish_reason: "stop" }],
        usage: { prompt_tokens: "10", completion_tokens: -1, total_tokens: null, secret: "must not escape" } });
    const result = observed(source([raw]).response);
    await result.wrapped.text();
    expect(result.first).toHaveLength(0);
    expect(result.usage).toHaveLength(0);
    expect(result.ends[0].usageComplete).toBe(false);
  });

  it("uses SSE event names when native payload omits its type", async () => {
    const raw = 'event: response.completed\ndata: {"response":{"model":"named","usage":{"input_tokens":2,"output_tokens":1}}}\n\n';
    const result = observed(source([raw]).response);
    await result.wrapped.text();
    expect(result.usage).toEqual([[{ input_tokens: 2, output_tokens: 1 }, "named"]]);
    expect(result.ends[0]).toMatchObject({ status: "completed", usageComplete: true });
  });

  it("recovers oversized NDJSON at the next line and strips arbitrary usage strings", async () => {
    const oversized = JSON.stringify({ choices: [{ delta: { content: "x".repeat(70 * 1024) } }] });
    const terminal = { choices: [{ finish_reason: "stop" }], usage: { ...chatUsage, secret: "must not escape", prompt_tokens_details: { cached_tokens: 2, secret: "not metadata" } } };
    const raw = oversized + "\n" + JSON.stringify(terminal) + "\n";
    const result = observed(source([raw], "application/x-ndjson").response);
    expect(await result.wrapped.text()).toBe(raw);
    expect(result.first).toHaveLength(0);
    expect(result.usage).toEqual([[{ ...chatUsage, prompt_tokens_details: { cached_tokens: 2 } }, undefined]]);
    expect(result.ends[0].usageComplete).toBe(true);
  });

  it("handles an already aborted signal and cancelled HTTP errors without duplicate end", async () => {
    const signal = new AbortController();
    signal.abort(new DOMException("already gone", "AbortError"));
    const input = source([chatEnd], "text/event-stream", { status: 503 });
    const result = observed(input.response, { signal: signal.signal });
    await expect(result.wrapped.text()).rejects.toBe(signal.signal.reason);
    expect(input.pulls()).toBe(0);
    expect(result.ends).toEqual([expect.objectContaining({ status: "cancelled", errorClass: "aborted", usageComplete: false })]);
  });

  it("runs end for a bodyless Response once and retains null-body HTTP semantics", async () => {
    const result = observed(new Response(null, { status: 204 }));
    expect(result.wrapped.body).toBeNull();
    expect(await result.wrapped.text()).toBe("");
    expect(result.ends).toEqual([expect.objectContaining({ status: "completed", usageComplete: false })]);
  });
});
