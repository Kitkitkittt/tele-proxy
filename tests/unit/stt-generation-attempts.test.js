import { describe, it, expect, vi, afterEach } from "vitest";

const savedFetch = globalThis.fetch;
const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "TELE_PROXY_ENABLED"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.resetModules();
});

const responses = {
  deepgram: { results: { channels: [{ alternatives: [{ transcript: "hello" }] }] } },
  "nvidia-asr": { text: "hello" },
  "gemini-stt": { candidates: [{ content: { parts: [{ text: "hello" }] } }] },
  "elevenlabs-stt": { text: "hello" },
  "huggingface-asr": { text: "hello" },
  openai: { text: "hello" },
};

async function setup(outbound) {
  vi.resetModules();
  for (const key of envKeys) delete process.env[key];
  process.env.TELE_PROXY_ENABLED = "1";
  globalThis.fetch = outbound;
  const context = await import("../../open-sse/services/dispatchContext.js");
  const { handleSttCore } = await import("../../open-sse/handlers/sttCore.js");
  const formData = new FormData();
  formData.append("file", new Blob(["audio"], { type: "audio/wav" }), "audio.wav");
  const run = (format) => handleSttCore({
    provider: "synthetic", model: "synthetic-model", formData,
    credentials: {}, sttConfig: { format, authType: "none", baseUrl: "https://stt.invalid/transcript" },
  });
  return { context, run };
}

describe("transcription handler boundaries", () => {
  it.each(Object.keys(responses))("normalizes %s transcription without an accounting context", async (format) => {
    const outbound = vi.fn(async () => Response.json(responses[format]));
    const { run } = await setup(outbound);
    const result = await run(format);
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ text: "hello" });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("rejects a required unsupported policy before sending", async () => {
    const outbound = vi.fn();
    const { context, run } = await setup(outbound);
    const result = await context.withDispatchContext({ requiredPolicy: true, execute: (_details, send) => send() }, () => run("deepgram"));
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(outbound).not.toHaveBeenCalled();
  });
});
