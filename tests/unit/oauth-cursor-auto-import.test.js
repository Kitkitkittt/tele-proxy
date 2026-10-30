import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Module from "node:module";
import { access } from "fs/promises";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), get: vi.fn(), close: vi.fn() }));
vi.mock("next/server", () => ({ NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) } }));
vi.mock("os", () => ({ homedir: () => "/mock/home" }));
vi.mock("fs/promises", () => ({ access: vi.fn(), constants: { R_OK: 4 } }));
vi.mock("child_process", () => {
  const execFile = () => { throw new Error("Unexpected callback invocation"); };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = mocks.exec;
  return { execFile };
});

const originalPlatform = process.platform;
const { GET } = await import("../../src/app/api/oauth/cursor/auto-import/route.js");

describe("Cursor auto-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.mocked(access).mockResolvedValue(undefined);
    mocks.get.mockReturnValue(undefined);
    mocks.exec.mockRejectedValue(new Error("CLI unavailable"));
    const load = Module._load;
    vi.spyOn(Module, "_load").mockImplementation(function (name, ...args) {
      if (name === "better-sqlite3") {
        return class { prepare() { return { get: mocks.get }; } close() { mocks.close(); } };
      }
      return load.call(this, name, ...args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("reports the checked candidate paths when the database is absent", async () => {
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));
    const { body } = await GET();
    expect(body.found).toBe(false);
    expect(body.error).toContain("Cursor database not found");
    expect(body.error).toContain("/mock/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(body.error).toContain("Cursor - Insiders");
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("reads per-key values and unwraps JSON strings", async () => {
    const values = { "cursorAuth/accessToken": '"test-token"', "storage.serviceMachineId": '"test-machine-id"' };
    mocks.get.mockImplementation((key) => values[key] ? { value: values[key] } : undefined);
    const { body } = await GET();
    expect(body).toEqual({ found: true, accessToken: "test-token", machineId: "test-machine-id" });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("falls back to the CLI when native SQLite is unavailable", async () => {
    Module._load.mockImplementation((name) => { if (name === "better-sqlite3") throw new Error("unavailable"); });
    mocks.exec.mockImplementation(async (command, [, sql]) => {
      expect(command).toBe("sqlite3");
      if (sql.includes("cursorAuth/accessToken")) return { stdout: '"cli-token"\n' };
      if (sql.includes("storage.serviceMachineId")) return { stdout: "cli-machine\n" };
      return { stdout: "" };
    });
    const { body } = await GET();
    expect(body).toEqual({ found: true, accessToken: "cli-token", machineId: "cli-machine" });
  });

  it("offers manual import when neither native nor CLI yields tokens", async () => {
    const { body } = await GET();
    expect(body).toEqual({ found: false, windowsManual: true, dbPath: "/mock/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb" });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not import a leftover Linux configuration when Cursor is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.mocked(access).mockImplementation(async (path) => {
      if (String(path).endsWith("cursor.desktop")) throw new Error("ENOENT");
    });
    const { body } = await GET();
    expect(body.found).toBe(false);
    expect(body.error).toContain("does not appear to be installed");
    expect(mocks.exec).toHaveBeenCalledWith("which", ["cursor"], { timeout: 5000 });
  });
});
