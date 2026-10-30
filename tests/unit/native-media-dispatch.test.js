import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import { UcWebExecutor } from "../../open-sse/executors/uc-web.js";
import { VeoAiFreeWebExecutor } from "../../open-sse/executors/veoaifree-web.js";
import { dispatchPhysicalFetch, withDispatchContext } from "../../open-sse/services/dispatchContext.js";

const record = (events, requiredPolicy = false) => ({
  requiredPolicy,
  execute: async (details, send) => { events.push(details); return send(); },
});
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
function mockTransport(upstream) {
  const fetch = vi.fn((url, init = {}) => dispatchPhysicalFetch({ signal: init.signal }, () => upstream(String(url), init)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native media generation boundaries", () => {
  for (const kind of ["image", "video"]) {
    it(`counts UC ${kind} submit only, excluding Clerk, upload, HEAD poll and download`, async () => {
      vi.useFakeTimers();
      const calls = [];
      mockTransport(async (url, init) => {
        const method = init.method || "GET";
        calls.push([url, method]);
        if (url.includes("clerk.uncensored.com")) return Response.json({ jwt: jwt({ uid: "test-user" }) });
        if (url.includes("generate-signed-url")) return Response.json({ signed_url: "https://upload.invalid/file", blob_name: "input" });
        if (method === "PUT") return new Response(null, { status: 200 });
        if (url.includes("image-gen") || url.includes("image_to_video")) return Response.json({ url: "https://result.invalid/file" });
        if (method === "HEAD") return new Response(null, { status: 200 });
        return new Response("binary", { headers: { "content-type": kind === "image" ? "image/png" : "video/mp4" } });
      });
      const events = [];
      const pending = withDispatchContext(record(events), () => new UcWebExecutor().generateMedia({
        kind, prompt: "hi", credentials: { apiKey: `__client=${jwt({ sid: "session" })}` },
        ...(kind === "video" ? { images: ["data:image/png;base64,aGk="] } : {}),
      }));
      await vi.runAllTimersAsync();
      expect(await pending).toEqual([{ b64: Buffer.from("binary").toString("base64"), mime: kind === "image" ? "image/png" : "video/mp4" }]);
      expect(events).toEqual([expect.objectContaining({ transport: "uc-media" })]);
      expect(calls.some(([url]) => url.includes("clerk.uncensored.com"))).toBe(true);
      expect(calls.some(([, method]) => method === "HEAD")).toBe(true);
      if (kind === "video") {
        expect(calls.some(([url]) => url.includes("generate-signed-url"))).toBe(true);
        expect(calls.some(([, method]) => method === "PUT")).toBe(true);
      }
    });
  }

  for (const kind of ["image", "video"]) {
    it(`counts Veo ${kind} generation but excludes nonce, POST result polling and artifact download`, async () => {
      vi.useFakeTimers();
      vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
      const actions = [];
      const mp4 = Buffer.from("0000ftypisom");
      const fetch = mockTransport(async (url, init) => {
        if (url === "https://veoaifree.com") return new Response('nonce":"abcdef1234"');
        if (url.includes("admin-ajax.php")) {
          const action = new URLSearchParams(init.body).get("actionType");
          actions.push(action);
          if (action === "banan-image-generator") return new Response("aGk=");
          if (action === "full-video-generate") return new Response("scene-token");
          return new Response("https://result.invalid/video.mp4");
        }
        return new Response(mp4, { headers: { "content-type": "video/mp4" } });
      });
      const events = [];
      const pending = withDispatchContext(record(events), () => new VeoAiFreeWebExecutor().generateMedia({ kind, prompt: "hi" }));
      await vi.runAllTimersAsync();
      expect(await pending).toEqual(kind === "image" ? [{ b64: "aGk=", mime: "image/png" }] : [{ b64: mp4.toString("base64"), mime: "video/mp4" }]);
      expect(events).toEqual([expect.objectContaining({ transport: "veoaifree-media" })]);
      expect(actions).toEqual(kind === "image" ? ["banan-image-generator"] : ["full-video-generate", "final-video-results"]);
      expect(fetch).toHaveBeenCalledTimes(kind === "image" ? 2 : 4);
    });
  }

  for (const Executor of [UcWebExecutor, VeoAiFreeWebExecutor]) {
    it(`${Executor.name} rejects required trusted policy before bootstrap`, async () => {
      const fetch = mockTransport(() => { throw new Error("must not send"); });
      const events = [];
      await expect(withDispatchContext(record(events, true), () => new Executor().generateMedia({ prompt: "hi" })))
        .rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
      expect(fetch).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
  }
});
