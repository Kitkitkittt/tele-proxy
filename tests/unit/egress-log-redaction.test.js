/**
 * Two privacy gaps left after the earlier Xiaomi redaction work:
 *  - proxyFetch's TLS-fallback warn printed the full upstream URL (with query)
 *    even in feature mode, while every sibling warn in that file is guarded.
 *  - the login "start" route logged and returned raw error.message.
 * Both are egress/log paths PRIVACY.md says are fixed in feature mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SENTINEL = "synthetic-egress-secret-9c3e";

let warned;
let logged;

beforeEach(() => {
  warned = [];
  logged = [];
  vi.spyOn(console, "warn").mockImplementation((...a) => warned.push(a.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Drive the guarded path directly: the warn is reached from fetchWithTlsFallback. */
async function triggerTlsFallback() {
  // proxyFetch captures `originalFetch = globalThis.fetch` at module load and
  // only then replaces globalThis.fetch, so the stub must be installed FIRST.
  vi.resetModules();
  const certError = Object.assign(new Error("self signed certificate"), {
    cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw certError;
  }));
  const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
  const url = `https://account.xiaomi.com/sts?sign=${SENTINEL}&ts=1`;
  try {
    await proxyAwareFetch(url, { method: "GET" });
  } catch {
    // the retry also throws; we only care what was logged
  }
  return url;
}

describe("egress URL redaction in feature mode", () => {
  it("does not log the upstream URL from the TLS fallback when the feature is on", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    const url = await triggerTlsFallback();
    const text = warned.join("\n");
    expect(text).toContain("TLS cert verification failed");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(url);
  });

  it("keeps the full URL when the feature is off", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    const url = await triggerTlsFallback();
    expect(warned.join("\n")).toContain(url);
  });
});

describe("login start route error redaction", () => {
  async function callRoute(env) {
    vi.stubEnv("TELE_PROXY_ENABLED", env);
    vi.resetModules();
    // Force the handler into its catch block.
    vi.doMock("@/lib/mimoLoginSession", async (orig) => {
      const actual = await orig();
      return {
        ...actual,
        beginSession: () => {
          throw new Error(`egress failed for https://proxy.example:8080?token=${SENTINEL}`);
        },
      };
    });
    const { POST } = await import("../../src/app/api/oauth/xiaomi-mimo/login/start/route.js");
    const res = await POST(
      new Request("http://localhost:20128/api/oauth/xiaomi-mimo/login/start", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:20128" },
        body: JSON.stringify({ region: "cn" }),
      })
    );
    const body = await res.text();
    return { status: res.status, body };
  }

  it("returns a generic error and omits the message in feature mode", async () => {
    const { status, body } = await callRoute("1");
    expect(status).toBe(500);
    expect(body).not.toContain(SENTINEL);
    expect(logged.join("\n")).not.toContain(SENTINEL);
    expect(logged.join("\n")).toContain("start error");
  });

  it("keeps the detail when the feature is off", async () => {
    const { body } = await callRoute("0");
    expect(body).toContain(SENTINEL);
  });
});
