/**
 * SSRF and internal-header invariants for the Xiaomi login proxy.
 *  - a forged (unsigned) session cookie must not select the upstream egress
 *    target, even when the operator sets requireLogin=false
 *  - internal x-9r-* forwarding metadata must never reach account.xiaomi.com
 *  - a redirect's Set-Cookie must apply to the next same-host hop
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGIN = "http://localhost:20128";

let requireLogin;
let peerTokenHeader;
let calls;

beforeEach(() => {
  vi.resetModules();
  calls = [];
  peerTokenHeader = "x-9r-peer-token";
  vi.doMock("@/lib/localDb", () => ({
    getSettings: async () => ({ requireLogin }),
  }));
  vi.doMock("@/lib/auth/dashboardSession", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, verifyDashboardAuthToken: async (token) => token === "valid-token" };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/localDb");
  vi.doUnmock("@/lib/auth/dashboardSession");
  vi.unstubAllEnvs();
});

function forgedCookie(proxyUrl) {
  const payload = JSON.stringify({ s: "s1", r: "cn", t: Date.now(), p: proxyUrl, j: [["passToken", "x", ".xiaomi.com", "/"]] });
  return `9r_mimo_login=v2.${Buffer.from(payload).toString("base64url")}`;
}

async function loadProxy() {
  return (await import("../../src/proxy.js")).default;
}

describe("xiaomi proxy authorization and forwarding", () => {
  it("refuses a forged session cookie when requireLogin is disabled", async () => {
    requireLogin = false;
    const proxy = await loadProxy();
    const request = new Request(`${ORIGIN}/fe/service/login`, {
      headers: { cookie: `${forgedCookie("http://169.254.169.254:80")}; auth_token=not-a-token` },
    });
    Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
    Object.defineProperty(request, "cookies", { value: { get: (name) => (name === "auth_token" ? { value: "not-a-token" } : undefined) } });

    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await proxy(request);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never forwards internal x-9r headers or the session to upstream", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    vi.resetModules();
    const { proxyAccountRequest } = await import("../../src/lib/mimoLoginSession.js");
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      calls.push(new Headers(init.headers));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    const req = new Request(`${ORIGIN}/fe/service/login?x=1`, {
      headers: { "x-9r-peer-token": "internal-secret", "x-forwarded-for": "1.2.3.4", "x-9r-real-ip": "1.2.3.4" },
    });
    await proxyAccountRequest({ jar: new Map(), upstreamBase: "https://mimo-server-cn.xiaomimimo.com", proxyUrl: null }, req, ORIGIN);

    expect(calls.length).toBeGreaterThan(0);
    for (const headers of calls) {
      expect(headers.get(peerTokenHeader)).toBeNull();
      expect(headers.get("x-9r-real-ip")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBeNull();
    }
  });

  it("sends a redirect Set-Cookie on the next same-host hop", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    vi.resetModules();
    const { proxyAccountRequest } = await import("../../src/lib/mimoLoginSession.js");

    // Capture the Cookie header actually sent on each hop.
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), cookie: new Headers(init.headers).get("cookie") });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://account.xiaomi.com/fe/after-hint", "set-cookie": "serviceToken=hop-cookie; Domain=.xiaomi.com; Path=/" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    const req = new Request(`${ORIGIN}/fe/service/login`, { headers: { cookie: "auth_token=should-not-forward" } });
    await proxyAccountRequest({ jar: new Map(), upstreamBase: "https://mimo-server-cn.xiaomimimo.com", proxyUrl: null }, req, ORIGIN);

    expect(calls.length).toBe(2);
    expect(calls[1].cookie || "").toContain("serviceToken=hop-cookie");
    expect(calls[1].cookie || "").not.toContain("auth_token");
  });
});
