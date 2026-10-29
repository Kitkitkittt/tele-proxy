import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NextRequest } from "next/server";

// Replace only the settings store; ingress, JWT verification and session decoding are real.
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireLogin: true }),
  validateApiKey: async () => false,
}));

let temp, proxy, createDashboardAuthToken, beginSession, encodeSessionCookie;
const cookieSecret = "synthetic-cookie-secret-74c19";
const pathSecret = "synthetic-attacker-path-63df8";
const errorSecret = "synthetic-upstream-secret-25bd1";

beforeAll(async () => {
  temp = await mkdtemp(resolve(tmpdir(), "proxy-ingress-privacy-"));
  vi.stubEnv("DATA_DIR", resolve(temp, "state"));
  vi.stubEnv("HOME", resolve(temp, "home"));
  vi.stubEnv("JWT_SECRET", "synthetic-ingress-jwt-secret-only");
  vi.stubEnv("TELE_PROXY_ENABLED", "1");
  ({ default: proxy } = await import("../../src/proxy.js"));
  ({ createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js"));
  ({ beginSession, encodeSessionCookie } = await import("../../src/lib/mimoLoginSession.js"));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  vi.unstubAllEnvs();
  if (temp) await rm(temp, { recursive: true, force: true });
});

function captureLogs() {
  return ["log", "warn", "error"].map(method => vi.spyOn(console, method).mockImplementation(() => {}));
}
function expectPrivateLogs(logs, ...secrets) {
  const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
  for (const secret of secrets) expect(output).not.toContain(secret);
}
function request(path, cookie) {
  return new NextRequest(`http://localhost${path}`, { headers: { cookie } });
}

describe.sequential("public ingress log privacy", () => {
  it.each(["0", "1"])("never logs cookies or attacker paths before authentication (feature=%s)", async enabled => {
    vi.stubEnv("TELE_PROXY_ENABLED", enabled);
    const logs = captureLogs();
    const response = await proxy(request(`/fe/${pathSecret}`, `auth_token=${cookieSecret}; unrelated=synthetic`));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expectPrivateLogs(logs, cookieSecret, pathSecret);
  });

  it("clears a forged session without dashboard authentication or upstream access", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    const logs = captureLogs();
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(errorSecret));
    const response = await proxy(request(`/fe/${pathSecret}`, `auth_token=${cookieSecret}; 9r_mimo_login=invalid`));
    expect(response.headers.get("set-cookie")).toContain("9r_mimo_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    expect(outbound).not.toHaveBeenCalled();
    expectPrivateLogs(logs, cookieSecret, pathSecret, errorSecret);
  });

  it("does not log attacker paths when an authenticated session cookie is undecodable", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    const token = await createDashboardAuthToken();
    const logs = captureLogs();
    const response = await proxy(request(`/fe/${pathSecret}`, `auth_token=${token}; 9r_mimo_login=${cookieSecret}`));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expectPrivateLogs(logs, token, cookieSecret, pathSecret);
  });

  it("returns the existing 502 without logging raw upstream errors in feature mode", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    const token = await createDashboardAuthToken();
    const session = encodeSessionCookie(beginSession("cn"));
    const logs = captureLogs();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`${errorSecret}: ${cookieSecret}`));
    const response = await proxy(request(`/fe/${pathSecret}`, `auth_token=${token}; 9r_mimo_login=${session}`));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("mimo login proxy error");
    expectPrivateLogs(logs, token, session, cookieSecret, pathSecret, errorSecret);
  });
});
