import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { transcribeCodex, codexHttpFetch } from "../../open-sse/handlers/codexStt.js";
import { readBounded } from "../../open-sse/handlers/codexSttAudio.js";

// Real conversion needs the external encoder; skip only those cases when absent
// so transport coverage keeps running on minimal hosts.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const audio = vi.hoisted(() => ({ convert: null }));
vi.mock("open-sse/handlers/codexSttAudio.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    convertAudio: (...args) => audio.convert ? audio.convert(...args) : actual.convertAudio(...args),
  };
});
const { convertAudio } = await import("open-sse/handlers/codexSttAudio.js");

function wav(seconds = 0.02, sampleRate = 48000, channels = 2) {
  const pcm = Buffer.alloc(Math.floor(sampleRate * seconds) * channels * 2);
  const b = Buffer.alloc(44 + pcm.length); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(pcm.length, 40); return b;
}
function form(extra = {}, bytes = wav()) {
  const f = new FormData(); f.set("model", "cx/transcribe"); f.set("file", new File([bytes], "input.wav", { type: "audio/wav" }));
  for (const [k,v] of Object.entries(extra)) f.set(k,v); return f;
}
const credentials = { authType: "oauth", accessToken: "test-token", providerSpecificData: { workspaceId: "test-account", baseUrl: "https://untrusted.invalid" } };
beforeEach(() => { audio.convert = null; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); audio.convert = null; });

it.skipIf(!hasFfmpeg)("converts real stereo 48k WAV to mono24k PCM16 and removes temporary files", async () => {
  const leftovers = async () => (await readdir(tmpdir())).filter((s) => s.startsWith("9router-codex-stt-"));
  const before = await leftovers();
  const result = Buffer.from(await (await convertAudio(new File([wav()], "in.wav"), new AbortController().signal)).arrayBuffer());
  expect(result.toString("ascii", 0, 4)).toBe("RIFF"); expect(result.readUInt16LE(22)).toBe(1); expect(result.readUInt32LE(24)).toBe(24000); expect(result.readUInt16LE(34)).toBe(16);
  expect(await leftovers()).toEqual(before);
});
it.skipIf(!hasFfmpeg)("rejects malformed and overlong audio and cleans up", async () => {
  await expect(convertAudio(new File(["invalid"], "in.wav"), new AbortController().signal)).rejects.toMatchObject({ status: 400 });
  await expect(convertAudio(new File([wav(121)], "in.wav"), new AbortController().signal)).rejects.toMatchObject({ status: 400 });
});
it("sends only the converted file and projects upstream metadata out of the response through a local relay", async () => {
  // Conversion is covered above; this case owns the wire format and projection.
  audio.convert = async () => new Blob([wav(0.02, 24000, 1)], { type: "audio/wav" });
  let observed;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    observed = { headers: req.headers, body: Buffer.concat(chunks) };
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: "hello", account: "private", segments: [{ start: 0 }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const result = await transcribeCodex({ formData: form(), credentials, proxyOptions: { vercelRelayUrl: `http://127.0.0.1:${server.address().port}` } });
    expect(result.success).toBe(true); expect(await result.response.json()).toEqual({ text: "hello" });
    const text = await transcribeCodex({ formData: form({ response_format: "text" }), credentials, proxyOptions: { vercelRelayUrl: `http://127.0.0.1:${server.address().port}` } });
    expect(await text.response.text()).toBe("hello");
    expect(text.response.headers.get("content-type")).toContain("text/plain");
    expect(observed.headers["x-relay-target"]).toBe("https://chatgpt.com"); expect(observed.headers["x-relay-path"]).toBe("/backend-api/transcribe");
    expect(observed.headers.authorization).toBe("Bearer test-token"); expect(observed.headers["chatgpt-account-id"]).toBe("test-account");
    const body = observed.body.toString("latin1"); expect(body.match(/Content-Disposition/g)).toHaveLength(1); expect(body).toContain('name="file"'); expect(body).not.toContain('name="model"');
    const start = observed.body.indexOf(Buffer.from("RIFF")); expect(observed.body.readUInt32LE(start + 24)).toBe(24000);
  } finally { await new Promise((r) => server.close(r)); }
});
it("keeps abort wired after direct response headers", async () => {
  const source = new PassThrough(); source.statusCode = 200; source.headers = {};
  const req = new EventEmitter(); req.end = () => queueMicrotask(() => callback(source));
  let callback;
  vi.spyOn(https, "request").mockImplementation((_url, _opts, cb) => { callback = cb; return req; });
  const controller = new AbortController();
  const response = await codexHttpFetch("https://chatgpt.com", { body: Buffer.from("test"), headers: {}, signal: controller.signal });
  const reading = response.text(); controller.abort();
  await expect(reading).rejects.toBeDefined(); expect(source.destroyed).toBe(true);
});
it("uses canonical NO_PROXY and strict unresolved-pool semantics on the direct adapter", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1"); vi.stubEnv("NO_PROXY", "chatgpt.com");
  const directFetch = vi.fn(async () => new Response("direct"));
  expect(await (await proxyAwareFetch("https://chatgpt.com/test", { directFetch, strictTls: true })).text()).toBe("direct");
  expect(directFetch).toHaveBeenCalledTimes(1);
  await expect(proxyAwareFetch("https://chatgpt.com/test", { directFetch, strictTls: true }, { strictProxy: true, proxyPoolId: "inactive" })).rejects.toThrow("none resolved");
  expect(directFetch).toHaveBeenCalledTimes(1);
});
it("rejects unsupported fields/formats and oversized uploads before transport", async () => {
  for (const extra of [{ prompt: "context" }, { language: "en" }, { response_format: "srt" }, { "timestamp_granularities[]": "word" }]) {
    expect((await transcribeCodex({ formData: form(extra), credentials })).status).toBe(400);
  }
  const f = form(); f.set("file", new File([Buffer.alloc(25 * 1024 * 1024 + 1)], "large.wav"));
  expect((await transcribeCodex({ formData: f, credentials })).status).toBe(413);
});
it("bounds streaming reads and cancels aborts while waiting for body chunks", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); } });
  await expect(readBounded(stream, 4, controller.signal)).rejects.toMatchObject({ status: 413 });
  const hanging = new ReadableStream(); const pending = readBounded(hanging, 10, controller.signal); controller.abort();
  await expect(pending).rejects.toBeDefined();
});
