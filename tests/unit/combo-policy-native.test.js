import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  applyComboPolicy,
  ComboPolicyError,
  COMBO_POLICY_MERGE_MODES,
  DEFAULT_MAX_POLICY_TOKENS,
  estimatePolicyTokens,
  MAX_POLICY_TEXT_LENGTH,
  MAX_POLICY_TOKENS,
  validatePolicySnapshot,
} from "../../open-sse/services/comboPolicy.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const POLICY_TEXT = "Respect the client's language.\n\nPreserve exact code identifiers.\nNo invented facts.";
function snapshot(overrides = {}) {
  const value = {
    policyId: "combo.native-policy",
    version: 1,
    text: POLICY_TEXT,
    enabled: true,
    required: true,
    mergeMode: COMBO_POLICY_MERGE_MODES.APPEND,
    maxInjectedTokens: DEFAULT_MAX_POLICY_TOKENS,
    ...overrides,
  };
  return {
    ...value,
    estimatedTokens: estimatePolicyTokens(value.text),
    hash: createHash("sha256").update(value.text, "utf8").digest("hex"),
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectPolicyError(fn, code) {
  expect(fn).toThrow(ComboPolicyError);
  try {
    fn();
  } catch (error) {
    expect(error.code).toBe(code);
    expect(error.status).toBe(400);
    return;
  }
  throw new Error("Expected ComboPolicyError");
}

describe("native combo policy append", () => {
  it("appends a system message without replacing client systems, tools, schema or reasoning", () => {
    const original = deepFreeze({
      messages: [
        { role: "system", content: "Client instructions", cache_control: { type: "ephemeral" } },
        { role: "developer", content: "Keep developer instructions" },
        { role: "user", content: "Question", comboPolicyInjected: true },
        { role: "assistant", content: null, reasoning_content: "existing reasoning",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } },
      reasoning_effort: "high",
      prompt_cache_key: "client-cache",
    });
    const policy = deepFreeze(snapshot());
    const result = applyComboPolicy(original, FORMATS.OPENAI, policy);
    expect(result.messages).toEqual([...original.messages, { role: "system", content: POLICY_TEXT }]);
    expect({ ...result, messages: original.messages }).toEqual(original);
    expect(result.tools).not.toBe(original.tools);
    expect(original.messages).toHaveLength(5);
    expect(result).not.toBe(original);
  });

  it("does not treat client policy text or spoofed markers as trusted deduplication", () => {
    const original = { comboPolicyInjected: true, _comboPolicyHash: "spoofed", messages: [
      { role: "system", content: POLICY_TEXT },
      { role: "user", content: "[combo-policy:combo.native-policy:1] already injected" },
    ] };
    const result = applyComboPolicy(original, FORMATS.OPENAI, snapshot());
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]).toEqual({ role: "system", content: POLICY_TEXT });
  });

  it("starts retries from the immutable original and never leaks mutations between attempts", () => {
    const original = deepFreeze({ messages: [{ role: "user", content: "Retry me" }], tools: [] });
    const policy = deepFreeze(snapshot());
    const first = applyComboPolicy(original, FORMATS.OPENAI, policy);
    first.messages[0].content = "executor mutation";
    first.tools.push({ type: "function" });
    const retry = applyComboPolicy(original, FORMATS.OPENAI, policy);
    expect(retry.messages).toEqual([
      { role: "user", content: "Retry me" }, { role: "system", content: POLICY_TEXT },
    ]);
    expect(retry.tools).toEqual([]);
    expect(original.messages).toHaveLength(1);
  });

  it.each([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE])("preserves string Responses input without prior instructions (%s)", format => {
    const original = deepFreeze({ input: "Exact user question", reasoning: { effort: "high" },
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } } });
    const result = applyComboPolicy(original, format, snapshot());
    expect(result.input).toBe(original.input);
    expect(result.instructions).toBe(POLICY_TEXT);
    expect({ ...result, instructions: undefined }).toEqual({ ...original, instructions: undefined });
  });

  it("appends Responses instructions while preserving structured input and cache metadata", () => {
    const original = deepFreeze({ instructions: "Client paragraph one.\n\nClient paragraph two.", input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Developer", cache_control: { type: "ephemeral" } }] },
      { type: "reasoning", id: "reason_1", encrypted_content: "opaque", summary: [] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "exact output" },
    ], tools: [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: true }],
    previous_response_id: "response_1", prompt_cache_key: "cache_1" });
    const result = applyComboPolicy(original, FORMATS.OPENAI_RESPONSES, snapshot());
    expect(result.instructions).toBe(`${original.instructions}\n\n${POLICY_TEXT}`);
    expect({ ...result, instructions: original.instructions }).toEqual(original);
    expect(result.input).not.toBe(original.input);
  });

  it.each([undefined, "", "Client system.\n\nSecond paragraph."])("appends Anthropic string system (%s)", system => {
    const original = deepFreeze({ messages: [{ role: "user", content: "Question" }], ...(system === undefined ? {} : { system }) });
    const result = applyComboPolicy(original, FORMATS.CLAUDE, snapshot());
    expect(result.system).toBe(system ? `${system}\n\n${POLICY_TEXT}` : POLICY_TEXT);
    expect(result.messages).toEqual(original.messages);
  });

  it("preserves Anthropic system block cache controls, tools and thinking signatures", () => {
    const original = deepFreeze({ system: [
      { type: "text", text: "Client one", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "Client two" },
    ], messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "private", signature: "signed-value" },
        { type: "tool_use", id: "tool_1", name: "lookup", input: { query: "test" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "result", cache_control: { type: "ephemeral" } }] },
    ], tools: [{ name: "lookup", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
    thinking: { type: "enabled", budget_tokens: 1024 } });
    const result = applyComboPolicy(original, FORMATS.CLAUDE, snapshot());
    expect(result.system).toEqual([...original.system, { type: "text", text: POLICY_TEXT }]);
    expect({ ...result, system: original.system }).toEqual(original);
  });

  it("preserves multipart Gemini instructions and native generation fields", () => {
    const original = deepFreeze({ systemInstruction: { role: "system", parts: [{ text: "First" }, { text: "Second" }] },
      contents: [{ role: "model", parts: [{ text: "Reasoning", thought: true, thoughtSignature: "opaque" },
        { functionCall: { name: "lookup", args: {} }, thoughtSignature: "signed" }] }],
      tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT" } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: { type: "OBJECT" }, thinkingConfig: { thinkingBudget: 1024 } },
      cachedContent: "cachedContents/client-cache" });
    const result = applyComboPolicy(original, FORMATS.GEMINI, snapshot());
    expect(result.systemInstruction).toEqual({ ...original.systemInstruction,
      parts: [...original.systemInstruction.parts, { text: POLICY_TEXT }] });
    expect({ ...result, systemInstruction: original.systemInstruction }).toEqual(original);
  });

  it("creates missing Gemini native systemInstruction", () => {
    const original = { contents: [{ role: "user", parts: [{ text: "Question" }] }] };
    expect(applyComboPolicy(original, FORMATS.GEMINI, snapshot()).systemInstruction)
      .toEqual({ parts: [{ text: POLICY_TEXT }] });
  });

  it.each([undefined, null, snapshot({ enabled: false }), snapshot({ mergeMode: COMBO_POLICY_MERGE_MODES.OFF })])(
    "returns a detached unchanged body when no active policy exists", policy => {
      const original = deepFreeze({ arbitrary: { nested: ["not a native request"] } });
      const result = applyComboPolicy(original, "unknown", policy);
      expect(result).toEqual(original);
      expect(result).not.toBe(original);
      expect(result.arbitrary).not.toBe(original.arbitrary);
    });
});

describe("native combo policy failures before dispatch", () => {
  it("rejects an unknown required format before dispatch", () => {
    const dispatch = vi.fn();
    expectPolicyError(() => dispatch(applyComboPolicy({ messages: [] }, "unknown", snapshot())), "COMBO_POLICY_REQUIRED");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("explicitly rejects unsupported nonrequired formats rather than silently skipping", () => {
    expectPolicyError(() => applyComboPolicy({}, FORMATS.KIRO, snapshot({ required: false })), "COMBO_POLICY_UNSUPPORTED");
  });

  it.each([
    [FORMATS.OPENAI, null],
    [FORMATS.OPENAI, { messages: "bad" }],
    [FORMATS.OPENAI, { messages: [null] }],
    [FORMATS.OPENAI, { messages: [{ role: "user", content: 42 }] }],
    [FORMATS.OPENAI, { messages: [{ role: "user", content: [null] }] }],
    [FORMATS.OPENAI_RESPONSES, { input: null }],
    [FORMATS.OPENAI_RESPONSES, { input: "text", instructions: [] }],
    [FORMATS.OPENAI_RESPONSES, { input: [null] }],
    [FORMATS.OPENAI_RESPONSES, { input: [{}] }],
    [FORMATS.CLAUDE, { messages: [], system: { text: "wrong shape" } }],
    [FORMATS.CLAUDE, { messages: [], system: [{ type: "image", text: "wrong type" }] }],
    [FORMATS.GEMINI, { contents: [], systemInstruction: "wrong shape" }],
    [FORMATS.GEMINI, { contents: [], systemInstruction: { parts: [{ text: 42 }] } }],
    [FORMATS.GEMINI, { contents: null }],
    [FORMATS.GEMINI, { contents: [{}] }],
    [FORMATS.GEMINI, { contents: [{ parts: [null] }] }],
  ])("rejects malformed required native bodies (%s)", (format, body) => {
    expectPolicyError(() => applyComboPolicy(body, format, snapshot()), "COMBO_POLICY_REQUIRED");
  });

  it("rejects malformed nonrequired native bodies explicitly", () => {
    expectPolicyError(() => applyComboPolicy({ messages: null }, FORMATS.OPENAI,
      snapshot({ required: false })), "COMBO_POLICY_UNSUPPORTED");
  });

  it("converts clone failures into policy errors", () => {
    expectPolicyError(() => applyComboPolicy({ messages: [], callback() {} }, FORMATS.OPENAI,
      snapshot()), "COMBO_POLICY_REQUIRED");
  });
});

describe("combo policy snapshot integrity", () => {
  it("validates exact UTF8 hash and byte-based estimate without changing text", () => {
    const policy = snapshot({ text: "Tiếng Việt\n\n保留原文 " });
    expect(estimatePolicyTokens(policy.text)).toBe(Math.ceil(Buffer.byteLength(policy.text, "utf8") / 4));
    expect(validatePolicySnapshot(policy)).toBe(policy);
    expect(applyComboPolicy({ input: "text" }, FORMATS.OPENAI_RESPONSES, policy).instructions).toBe(policy.text);
  });

  it("validates disabled empty snapshots for storage", () => {
    const policy = snapshot({ enabled: false, text: "" });
    expect(validatePolicySnapshot(policy)).toBe(policy);
  });

  it.each([
    { text: "tampered text" }, { hash: "0".repeat(64) }, { hash: "invalid" },
    { estimatedTokens: -1 }, { estimatedTokens: 1.5 }, { version: 0 }, { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { policyId: "bad/id" }, { policyId: "" },
    { enabled: "true" }, { mergeMode: "replace" },
    { maxInjectedTokens: 0 }, { maxInjectedTokens: MAX_POLICY_TOKENS + 1 },
    { maxInjectedTokens: 1.5 },
  ])("rejects invalid or tampered snapshot fields (%j)", patch => {
    const policy = { ...snapshot(), ...patch };
    expectPolicyError(() => applyComboPolicy({ messages: [] }, FORMATS.OPENAI, policy), "COMBO_POLICY_REQUIRED");
  });

  it.each(["", " \n\t", "text\0text", "x".repeat(MAX_POLICY_TEXT_LENGTH + 1)])("rejects invalid active text", text => {
    expectPolicyError(() => validatePolicySnapshot(snapshot({ text })), "COMBO_POLICY_REQUIRED");
  });

  it("enforces the configured injection estimate ceiling", () => {
    expectPolicyError(() => validatePolicySnapshot(snapshot({ maxInjectedTokens: 1 })), "COMBO_POLICY_REQUIRED");
  });

  it("rejects malformed required flags without trusting their truthiness", () => {
    expectPolicyError(() => validatePolicySnapshot({ ...snapshot(), required: "false" }), "COMBO_POLICY_INVALID");
  });

  it("returns an explicit invalid-snapshot code for nonrequired policies", () => {
    expectPolicyError(() => applyComboPolicy({ input: "text" }, FORMATS.OPENAI_RESPONSES,
      { ...snapshot({ required: false }), version: -1 }), "COMBO_POLICY_INVALID");
  });
});
