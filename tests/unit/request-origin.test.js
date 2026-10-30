import { afterEach, describe, expect, it, vi } from "vitest";
import { isSameOriginRequest } from "../../src/lib/auth/requestOrigin.js";

const req = (headers) => new Request("http://localhost:20280/api/admin", { headers });
afterEach(() => vi.unstubAllEnvs());

describe("administrative effective-origin validation", () => {
  it("uses HTTP Host rather than Next internal authority", () => {
    expect(isSameOriginRequest(req({ host: "127.0.0.1:20280", origin: "http://127.0.0.1:20280" }))).toBe(true);
    expect(isSameOriginRequest(req({ host: "127.0.0.1:20280", origin: "http://localhost:20280" }))).toBe(false);
  });

  it("requires explicit canonical configuration for TLS termination and matching Host", () => {
    vi.stubEnv("BASE_URL", ""); vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
    const headers = { host: "proxy.example", origin: "https://proxy.example", "x-forwarded-proto": "https", "x-forwarded-host": "proxy.example" };
    expect(isSameOriginRequest(req(headers))).toBe(false);
    vi.stubEnv("BASE_URL", "https://proxy.example");
    expect(isSameOriginRequest(req(headers))).toBe(true);
    expect(isSameOriginRequest(req({ ...headers, host: "attacker.example" }))).toBe(false);
    expect(isSameOriginRequest(req({ ...headers, origin: "https://attacker.example", "x-forwarded-host": "attacker.example" }))).toBe(false);
  });

  it("rejects cross-site, opaque origins and malformed authorities", () => {
    for (const headers of [
      { host: "localhost:20280", origin: "http://localhost:20280", "sec-fetch-site": "cross-site" },
      { host: "localhost:20280", origin: "null" },
      { host: "localhost:20280", origin: "http://localhost:20280/path" },
      { host: "localhost:20280@attacker.example", origin: "http://attacker.example" },
      { host: "localhost:20280/path", origin: "http://localhost:20280" },
      { host: "localhost:20280", origin: "https://attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" },
    ]) expect(isSameOriginRequest(req(headers))).toBe(false);
  });

  it("normalizes default ports and supports IPv6 Host without weakening scheme matching", () => {
    expect(isSameOriginRequest(req({ host: "example.com:80", origin: "http://example.com" }))).toBe(true);
    expect(isSameOriginRequest(req({ host: "[::1]:20280", origin: "http://[::1]:20280" }))).toBe(true);
    expect(isSameOriginRequest(req({ host: "example.com:80", origin: "https://example.com" }))).toBe(false);
  });
});
