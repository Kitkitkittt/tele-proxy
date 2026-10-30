// Actual Gemini route -> handleChat -> chatCore -> combo/response adapters.
// Only external state, request logging and provider I/O are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const fx = vi.hoisted(() => ({ execute: vi.fn(), combos: [] }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async name => fx.combos.find(combo => combo.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({
  getCombos: async () => fx.combos,
  getComboByName: async name => fx.combos.find(combo => combo.name === name) || null,
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ apiKey: "synthetic-key", connectionId: "synthetic-connection" }),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute: fx.execute, refreshCredentials: async () => null }),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(() => { throw new Error("Unexpected network access"); }),
  proxyAwareFetch: vi.fn(() => { throw new Error("Unexpected network access"); }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=";
const inlineImage = { inlineData: { mimeType: "image/png", data: PNG } };
const fileImage = { fileData: { mimeType: "image/png", fileUri: "https://example.invalid/synthetic.png" } };
const native = part => ({ candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
const sse = frame => `data: ${JSON.stringify(frame)}\r\n\r\n`;
function upstream(frame, format = "gemini", streaming = true, eventName = null) {
  const wire = streaming ? `${eventName ? `event: ${eventName}\r\n` : ""}${sse(frame)}` : JSON.stringify(frame);
  const bytes = new TextEncoder().encode(wire);
  return {
    response: new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 31));
      controller.enqueue(bytes.slice(31));
      controller.close();
    } }), { headers: { "Content-Type": streaming ? "text/event-stream" : "application/json" } }),
    responseFormat: format, url: "https://synthetic.invalid/generate", headers: {}, transformedBody: {},
  };
}
async function generate(model, stream = false, extra = {}) {
  const action = stream ? "streamGenerateContent" : "generateContent";
  return POST(new Request(`https://router.test/v1beta/models/${model}:${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Inspect the synthetic fixture" }] }], ...extra }),
  }), { params: Promise.resolve({ path: [...model.split("/").slice(0, -1), `${model.split("/").at(-1)}:${action}`] }) });
}

beforeEach(() => {
  vi.stubEnv("TELE_PROXY_ENABLED", "0");
  fx.execute.mockReset();
  fx.combos = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("Gemini actual chat wire", () => {
  it.each([null, "response.completed"])("returns native Gemini tool output after a Responses SSE switch (event=%s)", async eventName => {
    const terminal = { type: "response.completed", response: {
      id: "resp_synthetic", status: "completed",
      output: [{ type: "function_call", id: "fc_synthetic", call_id: "call_synthetic", name: "inspect", arguments: '{"path":"src","recursive":false}' }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    } };
    fx.execute.mockResolvedValueOnce(upstream(terminal, "openai-responses", true, eventName));
    const response = await generate("openai/gpt-4.1", false, {
      tools: [{ functionDeclarations: [{ name: "inspect", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } } }] }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const result = await response.json();
    expect(result.candidates[0].content.parts).toEqual([{ functionCall: { id: "call_synthetic", name: "inspect", args: { path: "src", recursive: false } } }]);
    expect(result.usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 });
    expect(fx.execute).toHaveBeenCalledTimes(1);
    expect(fx.execute.mock.calls[0][0]).toMatchObject({ stream: true, body: { stream: true } });
  });

  it.each([inlineImage, fileImage])("preserves image-only native JSON parts %j", async part => {
    const frame = native(part);
    fx.execute.mockResolvedValueOnce(upstream(frame, "gemini", false));
    const response = await generate("gemini/gemini-2.5-flash");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject(frame);
    expect(result).not.toHaveProperty("choices");
    expect(fx.execute).toHaveBeenCalledTimes(1);
    expect(fx.execute.mock.calls[0][0]).toMatchObject({ stream: false });
    expect(fx.execute.mock.calls[0][0].body).not.toHaveProperty("stream");
  });

  it.each([
    ["bare inline image", inlineImage, false], ["enveloped inline image", inlineImage, true],
    ["bare file image", fileImage, false], ["enveloped file image", fileImage, true],
  ])("keeps %s SSE instead of falling through the combo", async (_label, part, enveloped) => {
    const frame = native(part);
    fx.combos = [{ id: "synthetic-combo", name: "synthetic-images", models: ["gemini/gemini-2.5-flash", "gemini/gemini-2.5-pro"] }];
    fx.execute.mockImplementation(async () => upstream(enveloped ? { response: frame } : frame));
    const response = await generate("synthetic-images", true);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sse(frame));
    expect(fx.execute).toHaveBeenCalledTimes(1);
    expect(fx.execute.mock.calls[0][0].body).not.toHaveProperty("stream");
  });

  it("delivers a cross-format image-only OpenAI chunk to a Gemini combo client", async () => {
    fx.combos = [{ id: "synthetic-combo", name: "synthetic-cross-image", models: ["openai/gpt-4.1", "gemini/gemini-2.5-pro"] }];
    const chunk = { id: "synthetic", choices: [{ index: 0, delta: { images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] }, finish_reason: null }] };
    fx.execute.mockImplementation(async () => upstream(chunk, "openai"));
    const response = await generate("synthetic-cross-image", true);
    expect(response.status).toBe(200);
    const frames = (await response.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
    expect(frames.flatMap(frame => frame.candidates?.[0]?.content?.parts || [])).toContainEqual(inlineImage);
    expect(fx.execute).toHaveBeenCalledTimes(1);
  });

  it("falls through an OpenAI image URL that cannot be represented as Gemini inline data", async () => {
    fx.combos = [{ id: "synthetic-combo", name: "synthetic-remote-image", models: ["openai/gpt-4.1", "gemini/gemini-2.5-pro"] }];
    const chunk = { choices: [{ delta: { images: [{ type: "image_url", image_url: { url: "https://example.invalid/synthetic.png" } }] }, finish_reason: null }] };
    fx.execute.mockResolvedValueOnce(upstream(chunk, "openai")).mockResolvedValueOnce(upstream(native(inlineImage)));
    const response = await generate("synthetic-remote-image", true);
    expect(await response.text()).toBe(sse(native(inlineImage)));
    expect(fx.execute).toHaveBeenCalledTimes(2);
  });

  it("still falls through a thought-only native SSE response", async () => {
    fx.combos = [{ id: "synthetic-combo", name: "synthetic-thoughts", models: ["gemini/gemini-2.5-flash", "gemini/gemini-2.5-pro"] }];
    fx.execute.mockResolvedValueOnce(upstream(native({ thought: true, text: "Private synthetic reasoning" })))
      .mockResolvedValueOnce(upstream(native(inlineImage)));
    const response = await generate("synthetic-thoughts", true);
    expect(await response.text()).toBe(sse(native(inlineImage)));
    expect(fx.execute).toHaveBeenCalledTimes(2);
  });

});
