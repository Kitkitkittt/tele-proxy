// OpenAI → Gemini / Cursor / CommandCode request translation.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { applyComboPolicy } from "../../open-sse/services/comboPolicy.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

const O2G = (body) => translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "m", body, true, null, "gemini");
const O2C = (body) => translateRequest(FORMATS.OPENAI, FORMATS.CURSOR, "m", body, true, null, "cursor");
const O2CC = (body) => translateRequest(FORMATS.OPENAI, FORMATS.COMMANDCODE, "m", body, true, null, "commandcode");

describe("OpenAI → Gemini", () => {
  it("keeps multiple system messages", () => {
    const out = O2G({
      messages: [
        { role: "system", content: "RULE_ONE" },
        { role: "system", content: "RULE_TWO" },
        { role: "user", content: "hi" },
      ],
    });
    expect(JSON.stringify(out.systemInstruction), "earlier system lost").toContain("RULE_ONE");
  });

  it("keeps a single developer instruction in the native field", () => {
    const out = O2G({ messages: [{ role: "developer", content: "Developer rule" }] });
    expect(out.systemInstruction.parts).toEqual([{ text: "Developer rule" }]);
    expect(JSON.stringify(out.contents)).not.toContain("Developer rule");
  });

  it("rejects unsupported instruction content rather than dropping it", () => {
    expect(() => O2G({ messages: [{ role: "system", content: [
      { type: "text", text: "Rule" }, { type: "image_url", image_url: { url: "https://example.invalid/image" } },
    ] }] })).toThrow(/instructions must contain only text/);
  });

  it("preserves ordered instructions and required policy on the physical Gemini wire", async () => {
    const policyText = "Required gateway policy";
    const snapshot = { policyId: "wire-test", version: 1, text: policyText,
      hash: createHash("sha256").update(policyText).digest("hex"), enabled: true, required: true,
      mergeMode: "append_preserve_client", maxInjectedTokens: 600,
      estimatedTokens: Math.ceil(Buffer.byteLength(policyText) / 4) };
    const body = { messages: [
      { role: "system", content: "First system" },
      { role: "developer", content: [{ type: "text", text: "Developer one" }, { type: "text", text: "Developer two" }] },
      { role: "system", content: "Last system" },
      { role: "user", content: "Hello" },
    ], tools: [{ type: "function", function: { name: "lookup", description: "Find value",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }] };
    let wire;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      wire = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const native = applyComboPolicy(O2G(body), FORMATS.GEMINI, snapshot);
      const executor = new DefaultExecutor("gemini");
      const result = await executor.execute({ model: "gemini-2.5-flash", stream: false, body: native,
        credentials: { apiKey: "test", runtimeTransport: { baseUrl: `http://127.0.0.1:${server.address().port}/generate` } } });
      expect(result.response.status).toBe(200);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    expect(wire.systemInstruction.parts.map(part => part.text)).toEqual([
      "First system", "Developer one", "Developer two", "Last system", policyText,
    ]);
    expect(wire.tools[0].functionDeclarations[0]).toEqual({ name: "lookup", description: "Find value",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } });
    expect(JSON.stringify(wire.contents)).not.toContain("First system");
  });
});

describe("OpenAI → Cursor", () => {
  // openai-to-cursor.js:12-24 — image content fully dropped (text only)
  // KNOWN BUG
  it.fails("image content is preserved", () => {
    const out = O2C({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] }],
    });
    expect(JSON.stringify(out), "image dropped").toContain("AAAA");
  });

  // openai-to-cursor.js:179 — max_tokens hardcoded to 32000
  // KNOWN BUG
  it.fails("respects client max_tokens", () => {
    const out = O2C({ max_tokens: 200, messages: [{ role: "user", content: "hi" }] });
    expect(out.max_tokens).toBe(200);
  });
});

describe("OpenAI → CommandCode", () => {
  // openai-to-commandcode.js:53-57 — safeParseJson returns {} on bad JSON (args silently lost)
  // KNOWN BUG
  it.fails("malformed tool arguments are not silently emptied", () => {
    const out = O2CC({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{bad" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "r" },
      ],
    });
    const asst = out.params.messages.find((m) => m.role === "assistant");
    const call = asst.content.find((b) => b.type === "tool-call");
    expect(Object.keys(call.input).length, "arguments silently dropped to {}").toBeGreaterThan(0);
  });

  it("image content is preserved as native CommandCode image blocks", () => {
    const out = O2CC({
      messages: [{ role: "user", content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ] }],
    });
    expect(JSON.stringify(out)).toContain("BBBB");
    expect(JSON.stringify(out)).not.toContain("[image omitted]");
    expect(out.params.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image", image: "data:image/png;base64,BBBB", mimeType: "image/png", mediaType: "image/png" },
    ]);
  });
});
