import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("undici", () => ({
  Agent: class Agent { constructor(options) { this.options = options; } },
  ProxyAgent: class ProxyAgent { constructor(options) { this.options = options; } },
}));

const savedFetch = globalThis.fetch;
const envKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "STRICT_SSL"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.resetModules();
});

async function setup(fetch) {
  vi.resetModules();
  for (const key of envKeys) delete process.env[key];
  globalThis.fetch = fetch;
  const context = await import("../../open-sse/services/dispatchContext.js");
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  return { ...context, proxyAwareFetch };
}

function record(events) {
  return { execute: async (details, send) => { events.push(details); return send(); } };
}

describe("physical generation retries", () => {
  it("counts proxy failure, insecure TLS retry and direct fallback independently", async () => {
    const certError = Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" });
    const fetch = vi.fn()
      .mockRejectedValueOnce(certError)
      .mockRejectedValueOnce(new Error("proxy unavailable"))
      .mockResolvedValueOnce(new Response("ok"));
    const { withDispatchContext, withGenerationDispatch, proxyAwareFetch } = await setup(fetch);
    const events = [];
    const response = await withDispatchContext(record(events), () => withGenerationDispatch({ provider: "p", model: "m" }, () =>
      proxyAwareFetch("https://generation.invalid/chat", { method: "POST", body: "{}" }, { enabled: true, url: "http://proxy.invalid:8080" })));
    expect(response.status).toBe(200);
    expect(events.map(({ transport }) => transport)).toEqual(["http-proxy", "http-proxy-tls-retry", "http-direct"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.every((event) => !Object.hasOwn(event, "url") && !Object.hasOwn(event, "headers"))).toBe(true);
  });

  it("does not count token bootstrap, poll or download without an explicit generation marker", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response("ok"));
    const { withDispatchContext, proxyAwareFetch } = await setup(fetch);
    const events = [];
    await withDispatchContext(record(events), async () => {
      await proxyAwareFetch("https://generation.invalid/token", { method: "POST" });
      await proxyAwareFetch("https://generation.invalid/poll");
      await proxyAwareFetch("https://generation.invalid/file");
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(0);
  });

  it("aborts an active physical generation using the logical request signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const { withDispatchContext, withGenerationDispatch, proxyAwareFetch } = await setup(fetch);
    const events = [];
    const response = withDispatchContext({ ...record(events), signal: controller.signal }, () =>
      withGenerationDispatch({ provider: "p", model: "m" }, () => proxyAwareFetch("https://generation.invalid/chat", { method: "POST" })));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("Synthetic client cancellation", "AbortError"));
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toHaveLength(1);
    expect(events[0].signal.aborted).toBe(true);
  });

  it("counts base internal URL retries and fallback per physical fetch", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("retry", { status: 502 }))
      .mockResolvedValueOnce(new Response("fallback", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok"));
    const { withDispatchContext } = await setup(fetch);
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const events = [];
    const executor = new BaseExecutor("p", {
      baseUrls: ["https://generation.invalid/one", "https://generation.invalid/two"],
      retry: { 502: { attempts: 1, delayMs: 0 }, 429: { attempts: 0 } },
    });
    const result = await withDispatchContext(record(events), () => executor.execute({ model: "m", body: {}, stream: true, credentials: {} }));
    expect(result.response.status).toBe(200);
    expect(events).toHaveLength(3);
    expect(events.every(({ provider, model }) => provider === "p" && model === "m")).toBe(true);
  });

  it("does not count an OpenCode dependency failure as a physical send", async () => {
    const { withDispatchContext, withGenerationDispatch, proxyAwareFetch } = await setup(vi.fn());
    const events = [];
    await expect(withDispatchContext(record(events), () => withGenerationDispatch({}, () =>
      proxyAwareFetch("https://generation.invalid/chat", { directFetch: () => { throw new Error("dependency unavailable"); } })))).rejects.toThrow("dependency unavailable");
    expect(events).toHaveLength(0);
  });
});
