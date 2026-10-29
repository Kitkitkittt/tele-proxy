import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import { assertPolicyEligibility, policyRequestRequirements } from "../../open-sse/services/policyEligibility.js";
import { withDispatchContext } from "../../open-sse/services/dispatchContext.js";
import { stripHistoryForContext, withCapacityAdapterStripping } from "../../open-sse/services/capacityAdapter.js";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { anchorClaudeCache, normalizeClaudePassthrough, prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const provider = "policy-eligibility-fixture";
const model = "fixture";
const log = { info() {}, warn() {} };
const required = (callback, overrides = {}) => withDispatchContext({
  requiredPolicy: true, policyTokenEstimate: 7, execute: (_details, send) => send(), ...overrides,
}, callback);
const gate = (body, source = "openai", target = source) => assertPolicyEligibility(body, provider, model, source, target);
afterEach(() => { delete PROVIDER_CAPABILITIES[provider]; });

describe("required-policy eligibility", () => {
  it("leaves disabled requests unchanged even for unsupported capabilities", () => {
    PROVIDER_CAPABILITIES[provider] = { [model]: { tools: false, vision: false, contextWindow: 1 } };
    const body = { tools: [{ type: "function" }], messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "image" } }] }] };
    const original = structuredClone(body);
    expect(() => gate(body)).not.toThrow();
    expect(body).toEqual(original);
  });

  it("scans older media and nested tool results, not only the trailing user turn", () => {
    const body = { messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "old" } }] },
      { role: "assistant", content: "seen" },
      { role: "user", content: [{ type: "tool_result", content: [{ type: "document", source: { media_type: "application/pdf" } }] }] },
    ] };
    expect([...policyRequestRequirements(body)].sort()).toEqual(["pdf", "tools", "vision"]);
    const original = structuredClone(body);
    expect(() => required(() => gate(body))).toThrow("vision");
    expect(body).toEqual(original);
  });

  it("rejects declared tool incompatibility but admits unknown custom text/tool routes", () => {
    const body = { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }], messages: [{ role: "user", content: "hello" }] };
    expect(() => required(() => gate(body))).not.toThrow();
    PROVIDER_CAPABILITIES[provider] = { [model]: { tools: false } };
    expect(() => required(() => gate(body))).toThrow("tools");
  });

  it("uses an explicit conservative context estimate at the exact boundary without truncation", () => {
    const body = { messages: [{ role: "user", content: "boundary é" }] };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    PROVIDER_CAPABILITIES[provider] = { [model]: { contextWindow: bytes + 7 } };
    expect(() => required(() => gate(body))).not.toThrow();
    PROVIDER_CAPABILITIES[provider][model].contextWindow--;
    expect(() => required(() => gate(body))).toThrow("context estimate");
    expect(body.messages[0].content).toBe("boundary é");
  });

  it("preserves the complete original adapter history only under required policy", async () => {
    const body = { messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "history" })) };
    expect(stripHistoryForContext(body, 1).messages.length).toBeLessThan(body.messages.length);
    required(() => expect(stripHistoryForContext(body, 1)).toBe(body));
    const send = vi.fn(async (payload) => payload);
    const callback = withCapacityAdapterStripping(send, [`${provider}/${model}`]);
    expect(await required(() => callback(body, `${provider}/${model}`))).toBe(body);
    expect(send).toHaveBeenCalledWith(body, `${provider}/${model}`);
  });

  it("preserves native Claude/Gemini cache blocks and rejects a known lossy cache bridge", () => {
    const claude = { system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hello" }] };
    const gemini = { systemInstruction: { parts: [{ text: "system" }] }, cachedContent: "cache/fixture", contents: [{ role: "user", parts: [{ text: "hello" }] }] };
    expect(() => required(() => gate(claude, "claude"))).not.toThrow();
    expect(() => required(() => gate(gemini, "gemini"))).not.toThrow();
    expect(() => required(() => gate(claude, "claude", "openai"))).toThrow("cache protocol");
  });

  it("rejects native Gemini controls and mixed tool results before a lossy cross-protocol send", () => {
    const original = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
    for (const patch of [
      { generationConfig: { responseSchema: { type: "OBJECT" } } },
      { generationConfig: { responseJsonSchema: { type: "object" } } },
      { generationConfig: { thinkingConfig: { thinkingBudget: 32 } } },
      { toolConfig: { functionCallingConfig: { mode: "ANY" } } },
      { sessionId: "native-session" },
      { safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }] },
      { generationConfig: { stopSequences: ["STOP"], seed: 7 } },
      { tools: [{ googleSearch: {} }] },
      { tools: [{ functionDeclarations: [{ name: "inspect", parametersJsonSchema: { type: "object" } }] }] },
      { contents: [{ role: "model", parts: [{ text: "thinking", thoughtSignature: "signature" }] }] },
      { contents: [{ role: "user", parts: [{ functionResponse: { name: "inspect", response: {} } }, { text: "retain this" }] }] },
      { contents: [{ role: "user", parts: [{ functionResponse: { name: "inspect", response: { result: "value", metadata: "retain this" } } }] }] },
    ]) {
      const body = { ...original, ...patch };
      expect(() => required(() => gate(body, "gemini", "openai"))).toThrow(expect.objectContaining({ code: "COMBO_POLICY_REQUIRED", status: 422 }));
      expect(() => required(() => gate(body, "gemini", "gemini"))).not.toThrow();
    }
  });

  it.each([
    ["reasoning classification", { role: "model", parts: [{ thought: true, text: "synthetic reasoning" }] }, "Gemini reasoning continuity"],
    ["tool-result attachment", { role: "user", parts: [{ functionResponse: { name: "inspect", response: { status: "ok" }, parts: [{ inlineData: { mimeType: "image/png", data: "synthetic" } }] } }] }, "Gemini tool result protocol"],
  ])("prevents cross-protocol dispatch that loses Gemini %s", (_label, content, reason) => {
    PROVIDER_CAPABILITIES[provider] = { [model]: { vision: true, tools: true } };
    const body = { contents: [content] };
    const original = structuredClone(body);
    const send = vi.fn();
    expect(() => required(() => { gate(body, "gemini", "openai"); send(); })).toThrow(reason);
    expect(send).not.toHaveBeenCalled();
    expect(() => required(() => gate(body, "gemini", "gemini"))).not.toThrow();
    expect(body).toEqual(original);
  });

  it("rejects Gemini media parts that its cross-protocol bridge cannot preserve", () => {
    PROVIDER_CAPABILITIES[provider] = { [model]: { vision: true, audioInput: true } };
    for (const parts of [
      [{ fileData: { mimeType: "image/png", fileUri: "gs://synthetic/image" } }],
      [{ inlineData: { mimeType: "audio/wav", data: "synthetic" } }],
      [{ inlineData: { mimeType: "image/png", data: "synthetic" } }, { functionCall: { id: "call-1", name: "inspect", args: {} } }],
    ]) {
      const body = { contents: [{ role: "model", parts }] };
      expect(() => required(() => gate(body, "gemini", "openai"))).toThrow("Gemini multipart protocol");
      expect(() => required(() => gate(body, "gemini", "gemini"))).not.toThrow();
    }
  });

  it.each(["passthrough", "prepared"])("preserves client Claude cache controls at the %s wire boundary", async (path) => {
    const body = {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
    };
    const original = structuredClone(body);
    const send = vi.fn(async () => new Response("ok"));
    const executor = new DefaultExecutor("claude");
    await required(async () => {
      const translated = structuredClone(body);
      if (path === "passthrough") {
        normalizeClaudePassthrough(translated, "test-model");
        anchorClaudeCache(translated);
      } else {
        prepareClaudeRequest(translated, "claude");
      }
      await executor.execute({ model: "test-model", body: translated, stream: false, credentials: { apiKey: "fixture" }, directFetch: send });
    });
    const wire = JSON.parse(send.mock.calls[0][1].body);
    expect(wire.system[0].cache_control).toEqual(original.system[0].cache_control);
    expect(wire.tools[0].cache_control).toEqual(original.tools[0].cache_control);
    expect(wire.messages[0].content[0].cache_control).toEqual(original.messages[0].content[0].cache_control);
  });

  it("preserves developer/system instructions and tool call/result through the Claude boundary", () => {
    const body = { messages: [
      { role: "system", content: "client system" }, { role: "developer", content: "client developer" },
      { role: "user", content: "lookup" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "found" },
    ], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }] };
    const original = structuredClone(body);
    const sent = required(() => {
      gate(body, "openai", "claude");
      return openaiToClaudeRequest(model, structuredClone(body), false);
    });
    const instructions = sent.system.map((block) => block.text).join("\n");
    expect(instructions).toContain("client system\nclient developer");
    expect(sent.messages.flatMap((message) => message.content).find((block) => block.type === "tool_use").id).toBe("call_1");
    expect(sent.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result")).toMatchObject({ tool_use_id: "call_1", content: "found" });
    expect(sent.tools[0].input_schema).toEqual(body.tools[0].function.parameters);
    expect(body).toEqual(original);
  });

  it.each([
    ["opencode-go", "deepseek-v4.1-flash", { messages: [{ role: "user", content: "test" }], response_format: { type: "json_object" } }],
    ["groq", "test-model", { messages: [{ role: "assistant", content: "test", reasoning_content: "trace" }] }],
    ["mistral", "test-model", { messages: [{ role: "assistant", content: "test", reasoning_content: "trace" }] }],
    ["cerebras", "test-model", { messages: [{ role: "assistant", content: "test", reasoning_content: "trace" }] }],
    ["cloudflare-ai", "test-model", { messages: [{ role: "user", content: [{ type: "text", text: "test" }] }] }],
  ])("rejects lossy %s executor transformation before dispatch", async (id, modelId, body) => {
    const executor = new DefaultExecutor(id);
    const send = vi.fn();
    await expect(required(() => executor.execute({ model: modelId, body, stream: false, credentials: { apiKey: "fixture", providerSpecificData: { accountId: "fixture-account" } }, directFetch: send })))
      .rejects.toMatchObject({ code: "COMBO_POLICY_REQUIRED", status: 422 });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows executor additions without altering protected fields", async () => {
    const executor = new DefaultExecutor("groq");
    executor.transformRequest = (_model, body) => ({ ...body, extra_metadata: "allowed" });
    const send = vi.fn(async () => new Response("ok"));
    const result = await required(() => executor.execute({ model: "test-model", body: { messages: [{ role: "user", content: "test" }] }, stream: false, credentials: { apiKey: "fixture" }, directFetch: send }));
    expect(result.response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["COMBO_POLICY_REQUIRED", "REQUIRED_POLICY_UNSUPPORTED", "AbortError"])("does not fall through after %s", async (code) => {
    const error = new Error("terminal");
    if (code === "AbortError") error.name = code;
    else error.code = code;
    const send = vi.fn(async () => { throw error; });
    await expect(handleComboChat({ body: {}, models: ["a/one", "b/two"], handleSingleModel: send, log })).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects required fusion before its deliberate tool/history rewriting or any send", async () => {
    const send = vi.fn();
    await expect(required(() => handleFusionChat({ body: {}, models: ["a/one", "b/two"], handleSingleModel: send, log }))).rejects.toMatchObject({ code: "COMBO_POLICY_REQUIRED", status: 422 });
    expect(send).not.toHaveBeenCalled();
  });
});
