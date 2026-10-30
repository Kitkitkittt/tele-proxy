import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const events = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
let directory;

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock("../../src/lib/db/repos/settingsRepo.js");
});

describe("request detail shutdown lifecycle", () => {
  it("does not register listeners for repeated imports and disabled tele-proxy capture", async () => {
    vi.stubEnv("TELE_PROXY_ENABLED", "1");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "request-details-lifecycle-"));
    vi.stubEnv("DATA_DIR", directory);
    vi.stubEnv("HOME", directory);
    const before = events.map(event => process.listenerCount(event));
    for (let i = 0; i < 12; i++) {
      vi.resetModules();
      const repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");
      await repo.saveRequestDetail({});
    }
    expect(events.map(event => process.listenerCount(event))).toEqual(before);
  });

  it("registers one handler per event when legacy detail capture is enabled", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubEnv("TELE_PROXY_ENABLED", "0");
    vi.stubEnv("ENABLE_REQUEST_LOGS", "true");
    vi.doMock("../../src/lib/db/repos/settingsRepo.js", () => ({ getSettings: async () => ({}) }));
    const before = new Map(events.map(event => [event, new Set(process.listeners(event))]));
    const repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");
    try {
      await repo.saveRequestDetail({});
      await repo.saveRequestDetail({});
      for (const event of events) {
        expect(process.listeners(event).filter(listener => !before.get(event).has(listener))).toHaveLength(1);
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      for (const event of events) {
        for (const listener of process.listeners(event)) {
          if (!before.get(event).has(listener)) process.off(event, listener);
        }
      }
    }
  });
});
