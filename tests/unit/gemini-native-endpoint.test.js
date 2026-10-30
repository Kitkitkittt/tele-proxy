import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: mocks.handleChat,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");
const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const { detectFormatByEndpoint, FORMATS } = await import("../../open-sse/translator/formats.js");
const { initState, translateResponse } = await import("../../open-sse/translator/index.js");

function makeGeminiRequest(path, body, headers = {}, signal) {
  return new Request(`https://router.test/v1beta/models/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function audioBody() {
  return {
    contents: [{ parts: [{ text: "Speak naturally: hello" }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
      temperature: 0.01,
      seed: 123,
    },
  };
}

describe("Gemini native v1beta endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "real-gemini-key",
      connectionId: "gemini-conn",
      connectionName: "Gemini Test",
      providerSpecificData: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.handleChat.mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: "chat" }] } }] })
    );
  });

  it("lists Gemini TTS models using standard Google model names", async () => {
    const response = await GET();
    const body = await response.json();
    const names = body.models.map((model) => model.name);

    expect(names).toContain("models/gemini-3.1-flash-tts-preview");
    expect(names).toContain("models/gemini-2.5-flash-preview-tts");
    expect(names).toContain("models/gemini-2.5-pro-preview-tts");
  });

  it("passes Gemini AUDIO generateContent requests through to Google's native endpoint", async () => {
    const body = audioBody();
    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent"
    );

    const options = global.fetch.mock.calls[0][1];
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(body);
    expect(options.headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("accepts Google-style client keys without forwarding them upstream", async () => {
    const request = makeGeminiRequest(
      "gemini-2.5-flash-preview-tts:generateContent?key=query-router-key",
      audioBody(),
      {
        Authorization: "",
        "x-goog-api-key": "client-router-key",
      }
    );
    await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }),
    });

    expect(mocks.isValidApiKey).toHaveBeenCalledWith("client-router-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).not.toBe("client-router-key");
  });

  it("does not forward stale compression headers from native upstream responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": "123",
        },
      })
    );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("falls back to the next Gemini credential when native fetch times out before headers", async () => {
    const timeoutError = new TypeError("fetch failed");
    timeoutError.cause = { code: "UND_ERR_HEADERS_TIMEOUT", name: "HeadersTimeoutError" };

    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        apiKey: "first-gemini-key",
        connectionId: "first-conn",
        connectionName: "First Gemini",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        apiKey: "second-gemini-key",
        connectionId: "second-conn",
        connectionName: "Second Gemini",
        providerSpecificData: {},
      });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "pcm" } }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("first-gemini-key");
    expect(global.fetch.mock.calls[1][1].headers["x-goog-api-key"]).toBe("second-gemini-key");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "first-conn",
      504,
      expect.stringContaining("UND_ERR_HEADERS_TIMEOUT"),
      "gemini",
      "gemini-3.1-flash-tts-preview"
    );
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "second-conn",
      expect.objectContaining({ apiKey: "second-gemini-key" }),
      "gemini-3.1-flash-tts-preview"
    );
  });

  it("returns 502 for native fetch failures when credential fallback is not allowed", async () => {
    const networkError = new TypeError("fetch failed");
    networkError.cause = { code: "ECONNRESET" };
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    global.fetch.mockRejectedValueOnce(networkError);

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toContain("ECONNRESET");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringContaining("ECONNRESET"),
      "gemini",
      "gemini-3.1-flash-tts-preview"
    );
  });

  it("does not mark Gemini credentials unavailable when the native client aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const response = await POST(
      makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody(), {}, controller.signal),
      {
        params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
      }
    );

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("retains native instructions, tool turns, cache, schema and cancellation through chat ingress", async () => {
    const controller = new AbortController();
    const body = {
      systemInstruction: { role: "system", parts: [{ text: "First instruction" }, { text: "Second instruction" }] },
      contents: [
        { role: "model", parts: [{ functionCall: { id: "call-1", name: "inspect", args: { path: "." } }, thoughtSignature: "synthetic-signature" }] },
        { role: "user", parts: [{ functionResponse: { id: "call-1", name: "inspect", response: { result: "synthetic" } } }, { inlineData: { mimeType: "image/png", data: "synthetic" } }] },
      ],
      tools: [{ functionDeclarations: [{ name: "inspect", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } } }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } }, cachedContent: "opaque-cache",
      generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: { type: "OBJECT" }, thinkingConfig: { thinkingBudget: 32 } },
    };
    await POST(makeGeminiRequest("quality:generateContent", body, {}, controller.signal), {
      params: Promise.resolve({ path: ["quality:generateContent"] }),
    });
    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(await forwarded.json()).toEqual({ ...body, model: "quality", stream: false });
    expect(detectFormatByEndpoint(new URL(forwarded.url).pathname, { ...body, input: "spoofed format" })).toBe(FORMATS.GEMINI);
    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preserves native streaming parts across split SSE frames without double translation", async () => {
    const native = { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "inspect", args: { path: "." } }, thoughtSignature: "synthetic-signature" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
    const wire = `data: ${JSON.stringify(native)}\r\n\r\n`;
    const encoder = new TextEncoder();
    mocks.handleChat.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(wire.slice(0, 23)));
      controller.enqueue(encoder.encode(wire.slice(23)));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } }));
    const response = await POST(makeGeminiRequest("quality:streamGenerateContent", { contents: [{ parts: [{ text: "hello" }] }] }), {
      params: Promise.resolve({ path: ["quality:streamGenerateContent"] }),
    });
    expect(await response.text()).toBe(wire);
    expect((await mocks.handleChat.mock.calls[0][0].json()).stream).toBe(true);
  });

  it.each([{ promptFeedback: { blockReason: "SAFETY" } }, { usageMetadata: { totalTokenCount: 12 } }])("retains Gemini metadata-only streaming frames %j", async (frame) => {
    mocks.handleChat.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ response: frame })}\n\n`));
    const response = await POST(makeGeminiRequest("quality:streamGenerateContent", { contents: [] }), { params: Promise.resolve({ path: ["quality:streamGenerateContent"] }) });
    expect(await response.text()).toBe(`data: ${JSON.stringify(frame)}\r\n\r\n`);
  });

  it("retains translated tool call IDs and arguments in Gemini streaming output", async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "inspect", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
    mocks.handleChat.mockResolvedValueOnce(new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"));
    const response = await POST(makeGeminiRequest("quality:streamGenerateContent", { contents: [] }), {
      params: Promise.resolve({ path: ["quality:streamGenerateContent"] }),
    });
    const frame = JSON.parse((await response.text()).split("\r\n")[0].slice(6));
    expect(frame.candidates[0].content.parts).toEqual([{ functionCall: { id: "call-1", name: "inspect", args: { path: "." } } }]);
    expect(frame.usageMetadata.totalTokenCount).toBe(12);
  });

  it.each([
    { input: {}, fragments: [], args: {} },
    { input: { path: "." }, fragments: [], args: { path: "." } },
    { input: {}, fragments: ['{"path":', '"."}'], args: { path: "." } },
  ])("preserves Claude tool input through the real translator and Gemini stream: %j", async ({ input, fragments, args }) => {
    const state = initState(FORMATS.OPENAI);
    const events = [
      { type: "message_start", message: { id: "msg-synthetic", model: "claude-synthetic" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "inspect", input } },
      ...fragments.map(partial_json => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const wire = events.map(event => (translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, event, state) || [])
      .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")).join("");
    mocks.handleChat.mockResolvedValueOnce(new Response(wire));
    const response = await POST(makeGeminiRequest("quality:streamGenerateContent", { contents: [] }), { params: Promise.resolve({ path: ["quality:streamGenerateContent"] }) });
    const frames = (await response.text()).split("\r\n\r\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
    expect(frames.flatMap(frame => frame.candidates?.[0]?.content?.parts || [])).toEqual([
      { functionCall: { id: "call-1", name: "inspect", args } },
    ]);
  });

  it("rejects truncated Claude argument deltas instead of falling back to the initial empty input", async () => {
    const state = initState(FORMATS.OPENAI);
    const events = [
      { type: "message_start", message: { id: "msg-synthetic", model: "claude-synthetic" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "inspect", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      { type: "message_stop" },
    ];
    const wire = events.map(event => (translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, event, state) || [])
      .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")).join("");
    mocks.handleChat.mockResolvedValueOnce(new Response(wire));
    const response = await POST(makeGeminiRequest("quality:streamGenerateContent", { contents: [] }), { params: Promise.resolve({ path: ["quality:streamGenerateContent"] }) });
    await expect(response.text()).rejects.toThrow("Upstream returned invalid tool arguments");
  });

  it("retains translated nonstream tool calls in Gemini output", async () => {
    mocks.handleChat.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call-1", function: { name: "inspect", arguments: '{"path":"."}' } }] }, finish_reason: "tool_calls" }] }));
    const response = await POST(makeGeminiRequest("quality:generateContent", { contents: [] }), { params: Promise.resolve({ path: ["quality:generateContent"] }) });
    const result = await response.json();

    expect(result.candidates[0].content.parts).toContainEqual({ functionCall: { id: "call-1", name: "inspect", args: { path: "." } } });
  });
  it("fails the stream rather than emitting fabricated arguments for an incomplete tool call", async () => {
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "inspect", arguments: '{"path":' } }] }, finish_reason: "length" }] };
    mocks.handleChat.mockResolvedValueOnce(new Response(`data: ${JSON.stringify(chunk)}\n\n`));
    const response = await POST(makeGeminiRequest("quality:streamGenerateContent", { contents: [] }), { params: Promise.resolve({ path: ["quality:streamGenerateContent"] }) });
    await expect(response.text()).rejects.toThrow("Upstream returned invalid tool arguments");
  });

  it("unwraps native nonstream response envelopes without dropping tool parts", async () => {
    const native = { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "inspect", args: {} } }] } }] };
    mocks.handleChat.mockResolvedValueOnce(Response.json({ response: native }));
    const response = await POST(makeGeminiRequest("quality:generateContent", { contents: [] }), { params: Promise.resolve({ path: ["quality:generateContent"] }) });
    expect(await response.json()).toEqual(native);
  });

  it("does not hijack provider-prefixed non-Gemini audio requests", async () => {
    await POST(makeGeminiRequest("openai/gpt-4o-mini-tts:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["openai", "gpt-4o-mini-tts:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
