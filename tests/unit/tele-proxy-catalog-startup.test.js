import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate initialization side effects while exercising the actual file-backed catalog.
vi.mock("@/lib/teleProxy.js", () => ({ initializeTeleProxy: vi.fn(async () => {}) }));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-proxy-catalog-"));
const previous = { DATA_DIR: process.env.DATA_DIR, NEXT_RUNTIME: process.env.NEXT_RUNTIME,
  TELE_PROXY_ENABLED: process.env.TELE_PROXY_ENABLED, TELE_PROXY_CANARY: process.env.TELE_PROXY_CANARY };

beforeAll(() => {
  process.env.DATA_DIR = dataDir;
  process.env.NEXT_RUNTIME = "nodejs";
  process.env.TELE_PROXY_ENABLED = "1";
  process.env.TELE_PROXY_CANARY = "1";
  fs.writeFileSync(path.join(dataDir, "model-catalog.json"), JSON.stringify({
    v: 2,
    models: { "fixture-gateway:opaque-123": { vision: true } },
    providers: { "fixture-gateway": { "opaque-123": { contextWindow: 12345 } } },
  }));
});

afterAll(async () => {
  const { setCatalogSource } = await import("../../open-sse/providers/capabilities.js");
  setCatalogSource(null);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

it("installs the local catalog at feature-enabled canary startup", async () => {
  const capabilities = await import("../../open-sse/providers/capabilities.js");
  capabilities.setCatalogSource(null);
  expect(capabilities.getCapabilitiesForModel("fixture-gateway", "opaque-123").vision).toBe(false);
  const { register } = await import("../../src/instrumentation.js");
  await register();
  const actual = capabilities.getCapabilitiesForModel("fixture-gateway", "opaque-123");
  expect(actual.vision).toBe(true);
  expect(actual.contextWindow).toBe(12345);
  expect(capabilities.getCapabilitiesForModel("another-gateway", "opaque-123").vision).toBe(false);
});
