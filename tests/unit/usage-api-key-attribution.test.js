import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;
let adapter;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-api-key-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterEach(() => {
  adapter?.close();
  Object.assign(global._dbAdapter, { instance: null, initPromise: null, logged: false });
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Usage stats API key attribution", () => {
  it.each(["24h", "7d"])("never serializes legacy credentials in %s stats while keeping colliding masks distinct", async (period) => {
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    vi.stubEnv("TZ", "UTC");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
    const apiKeyA = "sk-machine-aaaaaa-11112222";
    const apiKeyB = "sk-machine-bbbbbb-33332222";
    const timeA = new Date(Date.now() - 120000).toISOString();
    const timeB = new Date(Date.now() - 60000).toISOString();

    await db.saveRequestUsage({
      timestamp: timeA,
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyA,
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    await db.saveRequestUsage({
      timestamp: timeB,
      provider: "openai",
      model: "gpt-4",
      connectionId: "c1",
      apiKey: apiKeyB,
      tokens: { prompt_tokens: 20, completion_tokens: 10 },
      endpoint: "/v1/chat",
      status: "ok",
    });

    // Feature-on reads must also protect raw credentials already stored by legacy writers.
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    const stats = await db.getUsageStats(period);
    const serialized = JSON.stringify(stats);
    expect(serialized.includes(apiKeyA)).toBe(false);
    expect(serialized.includes(apiKeyB)).toBe(false);
    const history = JSON.stringify(await db.getUsageHistory());
    expect(history.includes(apiKeyA)).toBe(false);
    expect(history.includes(apiKeyB)).toBe(false);
    expect(Object.keys((await db.getUsageStats(period)).byApiKey)).toEqual(Object.keys(stats.byApiKey));
    const apiKeyEntries = Object.values(stats.byApiKey);

    expect(apiKeyEntries).toHaveLength(2);
    expect(apiKeyEntries[0].apiKeyMasked).toBe(apiKeyEntries[1].apiKeyMasked);
    expect(apiKeyEntries.find(entry => entry.promptTokens === 10).lastUsed).toBe(timeA);
    expect(apiKeyEntries.find(entry => entry.promptTokens === 20).lastUsed).toBe(timeB);

    expect(
      apiKeyEntries
        .map((entry) => entry.promptTokens)
        .sort((a, b) => a - b)
    ).toEqual([10, 20]);
  });
});
