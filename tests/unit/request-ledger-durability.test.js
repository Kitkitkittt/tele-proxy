import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
let directory;
let file;
let adapters;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("TELE_PROXY_ENABLED", "1");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tele-proxy-ledger-durability-"));
  file = path.join(directory, "ledger.sqlite");
  adapters = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const adapter of adapters) adapter.close();
  vi.doUnmock("@/lib/db/driver.js");
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function open() {
  const adapter = await createSqlJsAdapter(file);
  adapters.push(adapter);
  return adapter;
}

async function useLedger(adapter) {
  vi.doMock("@/lib/db/driver.js", () => ({ getAdapter: async () => adapter }));
  return import("../../src/lib/requestLedger.js");
}

function createBase(adapter) {
  adapter.exec("CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE apiKeys(id TEXT PRIMARY KEY)");
}

describe("sql.js ledger durability", () => {
  it("reopens acknowledged attempts after abrupt process exit, then durably recovers them", async () => {
    // process.exit skips beforeExit and adapter.close: only explicit ledger acknowledgements can save.
    const child = spawnSync(process.execPath, ["--loader", path.join(root, "scripts/tele-proxy-canary-loader.mjs"), "--input-type=module", "-e", `
      import fs from 'node:fs';
      import { createSqlJsAdapter } from './src/lib/db/adapters/sqljsAdapter.js';
      const adapter = await createSqlJsAdapter(process.argv[1]);
      adapter.exec('CREATE TABLE _meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE apiKeys(id TEXT PRIMARY KEY)');
      global._dbAdapter = { instance: adapter };
      const ledger = await import('./src/lib/requestLedger.js');
      const request = await ledger.startRequest();
      const attempt = await ledger.startAttempt(request.requestId, { provider: 'synthetic', requestedModel: 'synthetic-model' });
      // Continuous unrelated writes must not defer an already acknowledged attempt's persistence.
      adapter.run('INSERT INTO _meta(key,value) VALUES(?,?)', ['pending', 'unsaved']);
      fs.writeSync(1, JSON.stringify({ requestId: request.requestId, attemptId: attempt.attemptId }));
      process.exit(0);
    `, file], { cwd: root, env: { ...process.env, TELE_PROXY_ENABLED: "1", DATA_DIR: directory, HOME: directory }, encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const { requestId, attemptId } = JSON.parse(child.stdout);
    const adapter = await open();
    expect(adapter.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [requestId])).toEqual({ attempt_count: 1 });
    expect(adapter.get("SELECT status, ended_at FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId])).toEqual({ status: "inflight", ended_at: null });
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'pending'")).toBeUndefined();
    const ledger = await useLedger(adapter);
    expect(await ledger.recoverAbandoned({ before: "9999-01-01T00:00:00.000Z" })).toEqual({ requests: 1, attempts: 1 });
    // Reopen before closing the writer: recovery cannot rely on shutdown or the debounce timer.
    const reopened = await open();
    expect(reopened.get("SELECT status, usage_source, cost_status, metered_cost_estimate_micros FROM teleProxyAttempts WHERE attempt_id = ?", [attemptId])).toEqual({ status: "abandoned", usage_source: "unknown", cost_status: "unknown", metered_cost_estimate_micros: null });
    expect(reopened.get("SELECT final_status, accounting_completeness FROM teleProxyRequests WHERE request_id = ?", [requestId])).toEqual({ final_status: "abandoned", accounting_completeness: "incomplete" });
  });

  it("persists terminal usage and first downstream observation before returning", async () => {
    const adapter = await open();
    createBase(adapter);
    const ledger = await useLedger(adapter);
    const request = await ledger.startRequest();
    const attempt = await ledger.startAttempt(request.requestId);
    await ledger.finishAttempt(attempt.attemptId, { status: "success", usage: { prompt_tokens: 10, completion_tokens: 2 } });
    await ledger.recordDownstreamFirstContent(attempt.attemptId, 25);
    await ledger.finishRequest(request.requestId, { finalStatus: "success" });
    const reopened = await open();
    expect(reopened.get("SELECT status, input_tokens, output_tokens, downstream_first_content_ms FROM teleProxyAttempts WHERE attempt_id = ?", [attempt.attemptId])).toEqual({ status: "success", input_tokens: 10, output_tokens: 2, downstream_first_content_ms: 25 });
    expect(reopened.get("SELECT final_status FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ final_status: "success" });
  });
  it("durably deletes only the matching unsent attempt before writer close", async () => {
    const adapter = await open();
    createBase(adapter);
    const ledger = await useLedger(adapter);
    const request = await ledger.startRequest();
    const removed = await ledger.startAttempt(request.requestId, { attemptId: "unsent-attempt" });
    const kept = await ledger.startAttempt(request.requestId, { attemptId: "other-attempt" });

    expect(await ledger.discardUnsentAttempt(request.requestId, removed.attemptId)).toBe(true);
    const reopened = await open();
    expect(reopened.get("SELECT attempt_id, status FROM teleProxyAttempts ORDER BY attempt_id")).toEqual({ attempt_id: kept.attemptId, status: "inflight" });
    expect(reopened.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ attempt_count: 1 });

    expect(await ledger.discardUnsentAttempt(request.requestId, removed.attemptId)).toBe(true);
    const repeated = await open();
    expect(repeated.get("SELECT COUNT(*) AS n FROM teleProxyAttempts")).toEqual({ n: 1 });
    expect(repeated.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ attempt_count: 1 });
  });

  it("does not delete terminal or wrong-owner attempts", async () => {
    const adapter = await open();
    createBase(adapter);
    const ledger = await useLedger(adapter);
    const owner = await ledger.startRequest();
    const other = await ledger.startRequest();
    const terminal = await ledger.startAttempt(owner.requestId, { attemptId: "terminal-attempt" });
    const inflight = await ledger.startAttempt(owner.requestId, { attemptId: "inflight-attempt" });
    await ledger.finishAttempt(terminal.attemptId, { status: "success" });

    await expect(ledger.discardUnsentAttempt(owner.requestId, terminal.attemptId)).rejects.toThrow();
    await expect(ledger.discardUnsentAttempt(other.requestId, inflight.attemptId)).rejects.toThrow();
    const reopened = await open();
    expect(reopened.get("SELECT status, ended_at FROM teleProxyAttempts WHERE attempt_id = ?", [terminal.attemptId]).status).toBe("success");
    expect(reopened.get("SELECT status, ended_at FROM teleProxyAttempts WHERE attempt_id = ?", [inflight.attemptId]).status).toBe("inflight");
    expect(reopened.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [owner.requestId])).toEqual({ attempt_count: 2 });
    expect(reopened.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [other.requestId])).toEqual({ attempt_count: 0 });
  });

  it.each(["fsyncSync", "renameSync"])("rejects failed %s acknowledgement when deleting an unsent attempt", async (operation) => {
    const adapter = await open();
    createBase(adapter);
    const ledger = await useLedger(adapter);
    const request = await ledger.startRequest();
    const attempt = await ledger.startAttempt(request.requestId, { attemptId: "unsent-attempt" });
    const previous = fs.readFileSync(file);
    const failure = vi.spyOn(fs, operation).mockImplementationOnce(() => { throw new Error("synthetic disk failure"); });

    await expect(ledger.discardUnsentAttempt(request.requestId, attempt.attemptId)).rejects.toThrow("synthetic disk failure");
    expect(fs.readFileSync(file)).toEqual(previous);
    failure.mockRestore();
    const reopened = await open();
    expect(reopened.get("SELECT status FROM teleProxyAttempts WHERE attempt_id = ?", [attempt.attemptId])).toEqual({ status: "inflight" });
    expect(reopened.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ attempt_count: 1 });
  });


  it.each(["fsyncSync", "renameSync"])("rejects a failed %s acknowledgement and preserves the previous disk image", async (operation) => {
    const adapter = await open();
    createBase(adapter);
    const ledger = await useLedger(adapter);
    const request = await ledger.startRequest();
    const previous = fs.readFileSync(file);
    const failure = vi.spyOn(fs, operation).mockImplementationOnce(() => { throw new Error("synthetic disk failure"); });
    let dispatched = false;
    await expect((async () => {
      await ledger.startAttempt(request.requestId, { attemptId: "stable-attempt" });
      dispatched = true;
    })()).rejects.toThrow("synthetic disk failure");
    expect(dispatched).toBe(false);
    expect(fs.readFileSync(file)).toEqual(previous);
    expect(fs.readdirSync(directory)).toEqual(["ledger.sqlite"]);
    failure.mockRestore();
    const reopened = await open();
    expect(reopened.get("SELECT COUNT(*) AS n FROM teleProxyAttempts")).toEqual({ n: 0 });
    expect(reopened.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ attempt_count: 0 });
    await ledger.startAttempt(request.requestId, { attemptId: "stable-attempt" });
    const retried = await open();
    expect(retried.get("SELECT COUNT(*) AS n FROM teleProxyAttempts")).toEqual({ n: 1 });
    expect(retried.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ attempt_count: 1 });
  });

  it("rejects directory fsync failure even after atomic replacement and permits stable replay", async () => {
    const adapter = await open();
    createBase(adapter);
    const ledger = await useLedger(adapter);
    const request = await ledger.startRequest();
    const fsync = fs.fsyncSync;
    const failure = vi.spyOn(fs, "fsyncSync")
      .mockImplementationOnce(fd => fsync(fd))
      .mockImplementationOnce(() => { throw new Error("synthetic directory failure"); });
    await expect(ledger.startAttempt(request.requestId, { attemptId: "directory-attempt" })).rejects.toThrow("synthetic directory failure");
    failure.mockRestore();
    await ledger.startAttempt(request.requestId, { attemptId: "directory-attempt" });
    const reopened = await open();
    expect(reopened.get("SELECT COUNT(*) AS n FROM teleProxyAttempts")).toEqual({ n: 1 });
    expect(reopened.get("SELECT attempt_count FROM teleProxyRequests WHERE request_id = ?", [request.requestId])).toEqual({ attempt_count: 1 });
    expect(fs.readdirSync(directory)).toEqual(["ledger.sqlite"]);
  });
});
