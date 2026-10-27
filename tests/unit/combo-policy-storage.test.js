import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const oldDir = process.env.DATA_DIR;
const oldFlag = process.env.TELE_PROXY_ENABLED;
let dir, store, db, combo;
const config = (text = "Preserve the caller's instructions.\n\nInspect evidence.") => ({
  policyId: "synthetic-policy", text, enabled: true, required: true,
  mergeMode: "append_preserve_client", maxInjectedTokens: 600, expectedVersion: null,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-policy-"));
  process.env.DATA_DIR = dir;
  process.env.TELE_PROXY_ENABLED = "1";
  delete global._dbAdapter;
  vi.resetModules();
  store = await import("@/lib/comboPolicy.js");
  const repo = await import("@/lib/db/repos/combosRepo.js");
  combo = await repo.createCombo({ name: "synthetic", models: ["openai/mock"] });
  db = await (await import("@/lib/db/driver.js")).getAdapter();
});

afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (oldDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDir;
  if (oldFlag === undefined) delete process.env.TELE_PROXY_ENABLED; else process.env.TELE_PROXY_ENABLED = oldFlag;
});

describe("combo policy immutable storage", () => {
  it("leaves old combos and disabled feature unchanged without optional schema writes", async () => {
    process.env.TELE_PROXY_ENABLED = "0";
    expect(await store.snapshotComboPolicy(combo.name)).toBeNull();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'comboPolicyVersions'")).toBeUndefined();
    await expect(store.saveComboPolicy(combo.id, config())).rejects.toMatchObject({ status: 404 });
    process.env.TELE_PROXY_ENABLED = "1";
    expect(await store.snapshotComboPolicy(combo.name)).toBeNull();
    expect(db.get("SELECT value FROM _meta WHERE key = 'teleProxyPolicySchemaVersion'").value).toBe("1");
  });

  it("creates versions, disables, selects rollback, and keeps ingress snapshots immutable", async () => {
    const first = await store.saveComboPolicy(combo.id, config());
    const ingress = await store.snapshotComboPolicy(combo.name);
    expect(Object.isFrozen(ingress)).toBe(true);
    const second = await store.saveComboPolicy(combo.id, { ...config("Revised synthetic policy."), expectedVersion: 1 });
    const disabled = await store.saveComboPolicy(combo.id, { ...config("Revised synthetic policy."), enabled: false, expectedVersion: 2 });
    expect(disabled.policy.version).toBe(3);
    expect(disabled.policy.enabled).toBe(false);
    const rolled = await store.saveComboPolicy(combo.id, { selectVersion: 1, expectedVersion: 3 });
    expect(rolled.policy).toEqual(first.policy);
    expect(rolled.history.map((p) => p.version)).toEqual([3, 2, 1]);
    expect(ingress).toEqual(first.policy);
    expect(second.policy.hash).not.toBe(first.policy.hash);
    expect(rolled.audit).toHaveLength(4);
    expect(rolled.audit.map((a) => a.action)).toContain("select");
    expect(JSON.stringify(rolled.audit)).not.toContain(config().text);
    expect(rolled.history.every((p) => !("text" in p))).toBe(true);
    expect(rolled.preview.text).toBe("[policy content omitted]");
    const fourth = await store.saveComboPolicy(combo.id, { ...config("Fourth revision."), expectedVersion: 1 });
    expect(fourth.policy.version).toBe(4);
  });

  it("rejects stale updates and validates administrative configuration without partial writes", async () => {
    await store.saveComboPolicy(combo.id, config());
    await expect(store.saveComboPolicy(combo.id, config())).rejects.toMatchObject({ status: 409 });
    await expect(store.saveComboPolicy(combo.id, { selectVersion: 999, expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    for (const change of [{ maxInjectedTokens: 0 }, { text: "bad\0text" }, { policyId: "different" }, { mergeMode: "replace" }, { enabled: "true" }, { text: "X".repeat(32769) }, { text: "Too large", maxInjectedTokens: 1 }, { version: 99 }]) {
      await expect(store.saveComboPolicy(combo.id, { ...config(), expectedVersion: 1, ...change })).rejects.toBeDefined();
    }
    expect((await store.getComboPolicyState(combo.id)).history).toHaveLength(1);
    expect((await store.getComboPolicyState(combo.id)).audit).toHaveLength(1);
  });

  it("persists selections across restart and fails corrupted required policy before dispatch", async () => {
    await store.saveComboPolicy(combo.id, config());
    db.close();
    delete global._dbAdapter;
    vi.resetModules();
    store = await import("@/lib/comboPolicy.js");
    expect((await store.snapshotComboPolicy(combo.name)).version).toBe(1);
    db = await (await import("@/lib/db/driver.js")).getAdapter();
    db.run("UPDATE comboPolicyVersions SET maxInjectedTokens = 0 WHERE comboId = ?", [combo.id]);
    const dispatch = vi.fn();
    await expect((async () => { await store.snapshotComboPolicy(combo.name); dispatch(); })()).rejects.toMatchObject({ code: "COMBO_POLICY_REQUIRED" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not block existing combo deletion and retains content-free audit", async () => {
    await store.saveComboPolicy(combo.id, config());
    const { deleteCombo } = await import("@/lib/db/repos/combosRepo.js");
    expect(await deleteCombo(combo.id)).toBe(true);
    expect(await store.snapshotComboPolicy(combo.name)).toBeNull();
    expect(db.all("SELECT * FROM comboPolicyAudit")).toHaveLength(1);
  });
});
