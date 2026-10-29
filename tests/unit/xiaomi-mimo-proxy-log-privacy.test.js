/**
 * Feature-on Xiaomi proxy diagnostics must not emit payloads or URLs.
 * Reaches the two sites the ingress-only fix does not cover:
 *  - proxyAccountRequest's "body STILL local" anomaly
 *  - buildBrowserResponse's upstream-error line
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __test__, proxyAccountRequest } from "../../src/lib/mimoLoginSession.js";

const { buildBrowserResponse } = __test__;
const ORIGIN = "http://localhost:20128";
const SENTINEL = "synthetic-mimo-secret-4f1c";
let logged;

const sess = () => ({ jar: new Map(), upstreamBase: "https://mimo-server-cn.xiaomimimo.com", proxyUrl: null });

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("feature-on mimo proxy diagnostics", () => {
  it("omits attacker body and URL from upstream-error logs", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    const upstream = new Response(`{"code":40001,"msg":"token=${SENTINEL}"}`, {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    const out = await buildBrowserResponse(sess(), upstream, ORIGIN, "/pass/serviceLogin", `https://account.xiaomi.com/pass?sts=${SENTINEL}`);
    expect(out.status).toBe(400);
    const text = logged.join("\n");
    expect(text).toContain("upstream error http=400 code=40001");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("url=");
  });

  it("omits unrewritable local body content from POST anomaly logs", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    const req = new Request(`${ORIGIN}/fe/service/login?x=1`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `cb=__mimo_login&token=${SENTINEL}`,
    });
    await proxyAccountRequest(sess(), req, ORIGIN);
    const text = logged.join("\n");
    expect(text).toContain("body STILL local, not matchable");
    expect(text).not.toContain(SENTINEL);
  });

  it("keeps full diagnostics when the feature is off", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    const upstream = new Response(`{"code":40001,"msg":"token=${SENTINEL}"}`, {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    await buildBrowserResponse(sess(), upstream, ORIGIN, "/pass/serviceLogin", `https://account.xiaomi.com/pass?sts=${SENTINEL}`);
    expect(logged.join("\n")).toContain(SENTINEL);
  });
});
