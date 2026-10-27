import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: null, enabled: true,
  get: vi.fn(), save: vi.fn(), cookie: null,
}));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init?.headers } }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: async () => mocks.session }));
vi.mock("@/lib/comboPolicy", () => ({
  getComboPolicyState: (...args) => mocks.get(...args),
  saveComboPolicy: (...args) => mocks.save(...args),
  policiesEnabled: () => mocks.enabled,
}));
import { GET, PUT } from "@/app/api/combos/[id]/policy/route.js";
const context = { params: Promise.resolve({ id: "combo-1" }) };
const request = (body, headers = {}) => new Request("http://localhost/api/combos/combo-1/policy", {
  method: body === undefined ? "GET" : "PUT", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  vi.clearAllMocks(); mocks.session = null; mocks.enabled = true; mocks.cookie = "fixture-cookie";
  mocks.get.mockResolvedValue({ policy: null, history: [], audit: [], preview: null, featureEnabled: true });
  mocks.save.mockResolvedValue({ policy: { version: 2 }, history: [] });
});

describe("policy API administrative authorization", () => {
  it.each([null, {}, { authenticated: false }])("denies missing/invalid sessions including spoofed policy headers", async (session) => {
    mocks.session = session;
    const headers = { authorization: "Bearer client-key", "x-policy-enabled": "false", "x-9r-cli-token": "spoof", "x-policy-version": "1" };
    expect((await GET(request(undefined, headers), context)).status).toBe(401);
    expect((await PUT(request({ enabled: false }, headers), context)).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });

  it("returns selected immutable config and never caches policy text", async () => {
    mocks.session = { authenticated: true };
    const result = await GET(request(), context);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(mocks.get).toHaveBeenCalledWith("combo-1");
  });

  it("saves and selects rollback only through authenticated same-origin administration", async () => {
    mocks.session = { authenticated: true };
    const config = { policyId: "test", text: "Synthetic", enabled: true, required: true, mergeMode: "append_preserve_client", maxInjectedTokens: 600, expectedVersion: 1 };
    expect((await PUT(request(config, { origin: "http://localhost" }), context)).status).toBe(200);
    expect(mocks.save).toHaveBeenLastCalledWith("combo-1", config);
    const rollback = { selectVersion: 1, expectedVersion: 2 };
    expect((await PUT(request(rollback), context)).status).toBe(200);
    expect(mocks.save).toHaveBeenLastCalledWith("combo-1", rollback);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it("accepts browser authority retained in Host when Next rewrites its internal URL", async () => {
    mocks.session = { authenticated: true };
    const body = { selectVersion: 1, expectedVersion: 2 };
    const transformed = new Request("http://localhost:20280/api/combos/combo-1/policy", {
      method: "PUT", body: JSON.stringify(body),
      headers: { host: "127.0.0.1:20280", origin: "http://127.0.0.1:20280", "sec-fetch-site": "same-origin" },
    });
    expect((await PUT(transformed, context)).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("rejects spoofed forwarding authority despite a matching internal URL origin", async () => {
    mocks.session = { authenticated: true };
    const transformed = new Request("http://localhost:20280/api/combos/combo-1/policy", {
      method: "PUT", body: "{}",
      headers: { host: "127.0.0.1:20280", origin: "http://localhost:20280", "x-forwarded-host": "localhost:20280", "x-forwarded-proto": "http" },
    });
    expect((await PUT(transformed, context)).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }])("denies cross-origin mutations", async (headers) => {
    mocks.session = { authenticated: true };
    expect((await PUT(request({ selectVersion: 1, expectedVersion: 2 }, headers), context)).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("returns disabled feature, validation, conflict and malformed payload failures without leaking internals", async () => {
    mocks.session = { authenticated: true }; mocks.enabled = false;
    expect((await GET(request(), context)).status).toBe(404);
    expect((await PUT(request({}), context)).status).toBe(404);
    mocks.enabled = true;
    const invalid = new Request("http://localhost/api/combos/combo-1/policy", { method: "PUT", body: "{" });
    expect((await PUT(invalid, context)).status).toBe(400);
    expect((await PUT(request({}, { "content-length": "200001" }), context)).status).toBe(413);
    mocks.save.mockRejectedValueOnce(Object.assign(new Error("Policy changed; reload before saving"), { status: 409 }));
    expect((await PUT(request({}), context)).status).toBe(409);
    mocks.get.mockRejectedValueOnce(new Error("secret storage detail"));
    const failed = await GET(request(), context);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("secret storage detail");
  });
});
