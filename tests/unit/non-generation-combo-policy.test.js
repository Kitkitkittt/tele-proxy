import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  row: null,
  credentials: vi.fn(),
  searchCore: vi.fn(),
  fetchCore: vi.fn(),
  dns: vi.fn(),
  combo: vi.fn(),
}));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => ({
  get(sql) {
    if (sql.includes("_meta")) return { value: "1" };
    if (sql.includes("SELECT id FROM combos")) return { id: "combo-id" };
    return mocks.row;
  },
}) }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getCombos: async () => [{ name: "web-combo", models: ["provider"] }],
}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.credentials,
  extractApiKey: () => null,
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccessProvider: async () => null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(), updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrlResolved: mocks.dns }));
vi.mock("open-sse/services/combo.js", () => ({
  getComboModelsFromData: () => ["provider"], handleComboChat: mocks.combo,
}));
vi.mock("open-sse/handlers/search/index.js", () => ({ handleSearchCore: mocks.searchCore }));
vi.mock("open-sse/handlers/fetch/index.js", () => ({ handleFetchCore: mocks.fetchCore }));

import { handleSearch } from "@/sse/handlers/search.js";
import { handleFetch } from "@/sse/handlers/fetch.js";

afterEach(() => vi.unstubAllEnvs());

function policy(overrides = {}) {
  const text = "Preserve caller instructions.";
  return {
    policyId: "synthetic", version: 1, text,
    hash: createHash("sha256").update(text).digest("hex"),
    enabled: 1, required: 1, mergeMode: "append_preserve_client",
    maxInjectedTokens: 600, estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4),
    ...overrides,
  };
}

for (const [name, handler, fields] of [
  ["search", handleSearch, { query: "synthetic query" }],
  ["fetch", handleFetch, { url: "https://example.com/article" }],
]) {
  describe(`${name} combo policy boundary`, () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubEnv("TELE_PROXY_ENABLED", "1");
      mocks.row = policy();
      mocks.dns.mockResolvedValue(undefined);
      mocks.combo.mockImplementation(async () => Response.json({ unchanged: true }));
    });
    const request = () => new Request(`http://localhost/v1/web/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "web-combo", ...fields }),
    });

    it("rejects required active policy before any network or provider dispatch", async () => {
      const response = await handler(request());
      expect(response.status).toBe(422);
      expect((await response.json()).error.message).toContain("not supported");
      expect(mocks.combo).not.toHaveBeenCalled();
      expect(mocks.credentials).not.toHaveBeenCalled();
      expect(mocks.searchCore).not.toHaveBeenCalled();
      expect(mocks.fetchCore).not.toHaveBeenCalled();
      expect(mocks.dns).not.toHaveBeenCalled();
    });

    it("rejects optional active policy without claiming successful application", async () => {
      mocks.row = policy({ required: 0 });
      expect((await handler(request())).status).toBe(422);
      expect(mocks.combo).not.toHaveBeenCalled();
    });

    it.each([
      ["disabled", { enabled: 0 }],
      ["merge mode off", { mergeMode: "off" }],
      ["unconfigured", null],
      ["feature off", "feature-off"],
    ])("preserves existing combo payload when %s", async (_label, config) => {
      if (config === "feature-off") vi.stubEnv("TELE_PROXY_ENABLED", "0");
      else mocks.row = config === null ? null : policy(config);
      const response = await handler(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ unchanged: true });
      expect(mocks.combo).toHaveBeenCalledOnce();
      expect(mocks.combo.mock.calls[0][0].body).toEqual({ provider: "web-combo", ...fields });
      expect(mocks.dns).toHaveBeenCalledTimes(name === "fetch" ? 1 : 0);
    });

    it("fails closed when the selected policy snapshot is invalid", async () => {
      mocks.row = policy({ hash: "invalid" });
      expect((await handler(request())).status).toBe(400);
      expect(mocks.combo).not.toHaveBeenCalled();
      expect(mocks.dns).not.toHaveBeenCalled();
    });
  });
}
