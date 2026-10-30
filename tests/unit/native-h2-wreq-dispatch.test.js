import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("http2", () => ({ connect: vi.fn() }));
vi.mock("../../open-sse/services/lazyRuntime.js", () => ({ loadRuntimeDep: vi.fn() }));

import * as http2 from "http2";
import { loadRuntimeDep } from "../../open-sse/services/lazyRuntime.js";
import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { grokTlsFetch } from "../../open-sse/services/grokTlsClient.js";
import { encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";
import { withDispatchContext, withDispatchMetadata } from "../../open-sse/services/dispatchContext.js";

const credentials = { accessToken: "test", providerSpecificData: { machineId: "a".repeat(64) } };
const record = (events, requiredPolicy = false) => ({
  requiredPolicy,
  execute: async (details, send) => { events.push(details); return send(); },
});
const frame = (field, value) => Buffer.from(wrapConnectRPCFrame(encodeField(field, 2, value)));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("native HTTP/2 and wreq generation boundaries", () => {
  it("counts the legacy Cursor physical HTTP/2 POST once with inherited metadata", async () => {
    const client = new EventEmitter();
    client.close = vi.fn();
    const req = new EventEmitter();
    req.write = vi.fn();
    req.end = () => queueMicrotask(() => {
      req.emit("response", { ":status": 200 });
      req.emit("data", Buffer.from("wire"));
      req.emit("end");
    });
    client.request = vi.fn(() => req);
    http2.connect.mockReturnValue(client);
    const events = [];
    const result = await withDispatchContext(record(events), () => withDispatchMetadata({ provider: "cursor", model: "m" }, () =>
      new CursorExecutor().makeHttp2Request("https://cursor.invalid/chat", {}, Buffer.from("request"))));
    expect(result.body.toString()).toBe("wire");
    expect(events).toEqual([expect.objectContaining({ provider: "cursor", model: "m", transport: "cursor-http2" })]);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(req.write).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("counts an AgentService session, not its subsequent protocol acknowledgements", async () => {
    const executor = new CursorExecutor();
    const writes = [];
    const frames = [
      frame(2, encodeField(10, 2, new Uint8Array())),
      frame(1, encodeField(1, 2, encodeField(1, 2, "hello"))),
      frame(1, encodeField(14, 2, new Uint8Array())),
    ];
    executor.openAgentHttp2Stream = vi.fn(() => ({
      responseHeaders: Promise.resolve({ ":status": 200 }),
      write: (value) => writes.push(value), end() {}, close() {},
      async read() { return frames.length ? { value: frames.shift(), done: false } : { done: true }; },
    }));
    const events = [];
    const result = await withDispatchContext(record(events), () => executor.executeAgent({
      model: "gpt-5.2", body: { messages: [{ role: "user", content: "hi" }] }, stream: false, credentials,
    }));
    expect((await result.response.json()).choices[0].message.content).toBe("hello");
    expect(events).toHaveLength(1);
    expect(writes).toHaveLength(2);
  });

  it("counts a new physical AgentService session for an empty-turn retry", async () => {
    vi.useFakeTimers();
    const executor = new CursorExecutor();
    let attempt = 0;
    executor.openAgentHttp2Stream = vi.fn(() => {
      const frames = attempt++ === 0 ? [] : [
        frame(1, encodeField(1, 2, encodeField(1, 2, "recovered"))),
        frame(1, encodeField(14, 2, new Uint8Array())),
      ];
      return {
        responseHeaders: Promise.resolve({ ":status": 200 }),
        write() {}, end() {}, close() {},
        async read() { return frames.length ? { value: frames.shift(), done: false } : { done: true }; },
      };
    });
    const events = [];
    const pending = withDispatchContext(record(events), () => executor.executeAgent({
      model: "gpt-5.2", body: { messages: Array.from({ length: 100 }, () => ({ role: "user", content: "hi" })) },
      stream: false, credentials,
    }));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect((await result.response.json()).choices[0].message.content).toBe("recovered");
    expect(events).toHaveLength(2);
    expect(executor.openAgentHttp2Stream).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("attributes delayed Cursor recovery to separate native sessions (stream=%s)", async (stream) => {
    vi.useFakeTimers();
    const executor = new CursorExecutor();
    let releaseEmpty;
    const empty = new Promise(resolve => { releaseEmpty = resolve; });
    let sessionIndex = 0;
    executor.openAgentHttp2Stream = vi.fn(() => {
      const index = sessionIndex++;
      const frames = index === 0 ? [] : [
        frame(1, encodeField(1, 2, encodeField(1, 2, "private recovered output"))),
        frame(1, encodeField(14, 2, new Uint8Array())),
      ];
      return {
        responseHeaders: Promise.resolve({ ":status": 200 }),
        write() {}, end() {}, close() {},
        async read() {
          if (index === 0) await empty;
          return frames.length ? { value: frames.shift(), done: false } : { done: true };
        },
      };
    });
    const attempts = [];
    const context = { execute: async (details, send) => {
      const attempt = { firstContent: [], usage: [], endings: [], started: Date.now() };
      attempts.push(attempt);
      details.observeNative({
        onFirstContent() { attempt.firstContent.push(Date.now() - attempt.started); },
        onUsage(usage, model) { attempt.usage.push({ usage, model }); },
        onEnd(result) { attempt.endings.push(result); },
      });
      return send();
    } };
    const pending = withDispatchContext(context, () => executor.executeAgent({
      model: "gpt-5.2", body: { messages: Array.from({ length: 100 }, () => ({ role: "user", content: "hi" })) },
      stream, credentials,
    }));
    // Streaming headers return before the empty upstream turn is discovered.
    const result = stream ? await pending : null;
    expect(attempts).toHaveLength(1);
    expect(attempts[0].endings).toEqual([]);
    await vi.advanceTimersByTimeAsync(75);
    releaseEmpty();
    await vi.runAllTimersAsync();
    const response = (result || await pending).response;
    expect(await response.text()).toContain("private recovered output");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].started - attempts[0].started).toBeGreaterThanOrEqual(75);
    expect(attempts[0]).toMatchObject({ firstContent: [], usage: [], endings: [{ status: "error", usageComplete: false }] });
    expect(attempts[1].firstContent).toHaveLength(1);
    expect(attempts[1].usage).toEqual([{ usage: expect.objectContaining({ estimated: true, completion_tokens: expect.any(Number) }), model: "gpt-5.2" }]);
    expect(attempts[1].usage[0].usage.completion_tokens).toBeGreaterThan(0);
    expect(attempts[1].endings).toEqual([{ status: "success", usageComplete: true, responseModel: "gpt-5.2", httpStatus: 200 }]);
    expect(JSON.stringify(attempts)).not.toContain("private recovered output");
  });

  it("cancels only the active recovered native session once without inventing usage", async () => {
    vi.useFakeTimers();
    const executor = new CursorExecutor();
    let releaseEmpty;
    const empty = new Promise(resolve => { releaseEmpty = resolve; });
    let index = 0;
    executor.openAgentHttp2Stream = vi.fn((_url, _headers, signal) => {
      const first = index++ === 0;
      return {
        responseHeaders: Promise.resolve({ ":status": 200 }), write() {}, end() {}, close() {},
        async read() {
          if (first) { await empty; return { done: true }; }
          return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        },
      };
    });
    const attempts = [];
    const context = { execute: async (details, send) => {
      const attempt = { onFirstContent: vi.fn(), onUsage: vi.fn(), onEnd: vi.fn() };
      attempts.push(attempt);
      details.observeNative(attempt);
      return send();
    } };
    const { response } = await withDispatchContext(context, () => executor.executeAgent({
      model: "gpt-5.2", body: { messages: Array.from({ length: 100 }, () => ({ role: "user", content: "hi" })) },
      stream: true, credentials,
    }));
    releaseEmpty();
    await vi.runAllTimersAsync();
    expect(attempts).toHaveLength(2);
    await response.body.cancel();
    await vi.runAllTimersAsync();
    expect(attempts[0].onEnd).toHaveBeenCalledTimes(1);
    expect(attempts[0].onEnd).toHaveBeenCalledWith(expect.objectContaining({ status: "error", usageComplete: false }));
    expect(attempts[1].onEnd).toHaveBeenCalledTimes(1);
    expect(attempts[1].onEnd).toHaveBeenCalledWith({ status: "cancelled", usageComplete: false, responseModel: "gpt-5.2", httpStatus: 200 });
    for (const attempt of attempts) {
      expect(attempt.onUsage).not.toHaveBeenCalled();
      expect(attempt.onFirstContent).not.toHaveBeenCalled();
    }
  });

  it("closes an AgentService session when response headers fail", async () => {
    const executor = new CursorExecutor();
    const close = vi.fn();
    executor.openAgentHttp2Stream = vi.fn(() => ({
      responseHeaders: Promise.reject(new Error("header failure")), write() {}, close,
    }));
    const events = [];
    await expect(withDispatchContext(record(events), () => executor.executeAgent({
      model: "gpt-5.2", body: { messages: [{ role: "user", content: "hi" }] }, credentials,
    }))).rejects.toThrow("header failure");
    expect(events).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects required policy before Cursor send or Grok dependency loading", async () => {
    const executor = new CursorExecutor();
    executor.openAgentHttp2Stream = vi.fn();
    const events = [];
    await expect(withDispatchContext(record(events, true), () => executor.execute({
      model: "gpt-5.2", body: { messages: [{ role: "user", content: "hi" }] }, credentials,
    }))).rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
    await expect(withDispatchContext(record(events, true), () => grokTlsFetch("https://grok.invalid/chat", { method: "POST" })))
      .rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED" });
    expect(executor.openAgentHttp2Stream).not.toHaveBeenCalled();
    expect(loadRuntimeDep).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("dispatches Grok POST responses but excludes binary GET downloads and auth", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x80]);
    const fetch = vi.fn(async () => new Response(bytes, { status: 429, headers: { "x-native": "yes" } }));
    loadRuntimeDep.mockResolvedValue({ createSession: () => ({ fetch }) });
    const events = [];
    const response = await withDispatchContext(record(events), () => grokTlsFetch("https://grok.invalid/chat", { method: "post", body: "{}" }));
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-native")).toBe("yes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await withDispatchContext(record(events, true), async () => {
      await grokTlsFetch("https://grok.invalid/auth", { method: "GET" });
      const download = await grokTlsFetch("https://assets.grok.invalid/image");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    });
    expect(events).toEqual([expect.objectContaining({ transport: "grok-wreq" })]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
