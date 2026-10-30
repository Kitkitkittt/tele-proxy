import { createHash, randomUUID } from "node:crypto";
import { getAdapter } from "./db/driver.js";
import migration from "./db/migrations/2026102701-combo-policy.js";
import { estimatePolicyTokens, validatePolicySnapshot } from "../../open-sse/services/comboPolicy.js";

export class PolicyStoreError extends Error {
  constructor(message, status = 400) { super(message); this.name = "PolicyStoreError"; this.status = status; }
}

export function policiesEnabled() { return process.env.TELE_PROXY_ENABLED === "1"; }

async function policyDb() {
  const db = await getAdapter();
  if (db.get("SELECT value FROM _meta WHERE key = ?", ["teleProxyPolicySchemaVersion"])?.value !== "1") {
    db.transaction(() => {
      migration.up(db);
      db.run("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["teleProxyPolicySchemaVersion", "1"]);
    });
  }
  return db;
}

function snapshot(row) {
  if (!row) return null;
  return Object.freeze({
    policyId: row.policyId, version: row.version, text: row.text, hash: row.hash,
    enabled: row.enabled === 1, required: row.required === 1, mergeMode: row.mergeMode,
    maxInjectedTokens: row.maxInjectedTokens, estimatedTokens: row.estimatedTokens,
  });
}

function selected(db, comboId) {
  return db.get(`SELECT v.* FROM comboPolicyVersions v JOIN comboPolicySelections s
    ON v.comboId = s.comboId AND v.version = s.version WHERE s.comboId = ?`, [comboId]);
}

function requireCombo(db, comboId) {
  if (!db.get("SELECT id FROM combos WHERE id = ?", [comboId])) throw new PolicyStoreError("Combo not found", 404);
}

function metadata(row) {
  const { text: _text, ...rest } = snapshot(row);
  return { ...rest, createdAt: row.createdAt };
}

function state(db, comboId) {
  const row = selected(db, comboId);
  const policy = snapshot(row);
  return {
    featureEnabled: true, policy,
    history: db.all("SELECT * FROM comboPolicyVersions WHERE comboId = ? ORDER BY version DESC", [comboId]).map(metadata),
    audit: db.all(`SELECT action, previousVersion, selectedVersion, hash, actor, createdAt
      FROM comboPolicyAudit WHERE comboId = ? ORDER BY createdAt DESC, id DESC LIMIT 100`, [comboId]),
    preview: policy ? { hash: policy.hash, estimatedTokens: policy.estimatedTokens, text: "[policy content omitted]" } : null,
  };
}

export async function getComboPolicyState(comboId) {
  if (!policiesEnabled()) throw new PolicyStoreError("Combo policies disabled", 404);
  const db = await policyDb();
  requireCombo(db, comboId);
  return state(db, comboId);
}

export async function snapshotComboPolicy(comboName) {
  if (!policiesEnabled()) return null;
  const db = await policyDb();
  const combo = db.get("SELECT id FROM combos WHERE name = ?", [comboName]);
  if (!combo) return null;
  const policy = snapshot(selected(db, combo.id));
  if (policy?.enabled && policy.mergeMode !== "off") validatePolicySnapshot(policy);
  return policy;
}

/** Search and URL extraction cannot represent generation instructions. */
export async function assertNonGenerationComboPolicySupported(comboName, transport) {
  const policy = await snapshotComboPolicy(comboName);
  if (policy?.enabled && policy.mergeMode !== "off") {
    const error = new PolicyStoreError(`Combo policy is not supported by ${transport}`, 422);
    error.code = "REQUIRED_POLICY_UNSUPPORTED";
    throw error;
  }
}

const CONFIG_KEYS = new Set(["policyId", "text", "enabled", "required", "mergeMode", "maxInjectedTokens", "expectedVersion"]);

export async function saveComboPolicy(comboId, fields, actor = "dashboard-admin") {
  if (!policiesEnabled()) throw new PolicyStoreError("Combo policies disabled", 404);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new PolicyStoreError("Policy configuration must be an object");
  const rollback = Object.hasOwn(fields, "selectVersion");
  const keys = rollback ? new Set(["selectVersion", "expectedVersion"]) : CONFIG_KEYS;
  if (Object.keys(fields).some((key) => !keys.has(key))) throw new PolicyStoreError("Unknown policy configuration field");
  if (!Object.hasOwn(fields, "expectedVersion") || (fields.expectedVersion !== null && (!Number.isSafeInteger(fields.expectedVersion) || fields.expectedVersion < 1))) {
    throw new PolicyStoreError("expectedVersion must be the selected version, or null for an unconfigured combo");
  }
  if (rollback && (!Number.isSafeInteger(fields.selectVersion) || fields.selectVersion < 1)) throw new PolicyStoreError("Invalid selected version");
  // Actor is an internal role, never a client-supplied identity or session claim.
  if (actor !== "dashboard-admin" && actor !== "canary-admin") throw new PolicyStoreError("Invalid audit actor");
  const db = await policyDb();
  db.transaction(() => {
    requireCombo(db, comboId);
    const previous = selected(db, comboId);
    if ((previous?.version ?? null) !== fields.expectedVersion) throw new PolicyStoreError("Policy changed; reload before saving", 409);
    let policy;
    let action;
    const now = new Date().toISOString();
    if (rollback) {
      policy = snapshot(db.get("SELECT * FROM comboPolicyVersions WHERE comboId = ? AND version = ?", [comboId, fields.selectVersion]));
      if (!policy) throw new PolicyStoreError("Policy version not found", 404);
      validatePolicySnapshot(policy);
      action = "select";
    } else {
      if (previous && fields.policyId !== previous.policyId) throw new PolicyStoreError("Policy identity cannot change; edit its immutable versions instead");
      if (typeof fields.text !== "string") throw new PolicyStoreError("Policy text is required");
      const version = (db.get("SELECT MAX(version) AS version FROM comboPolicyVersions WHERE comboId = ?", [comboId])?.version ?? 0) + 1;
      policy = {
        policyId: fields.policyId, version, text: fields.text,
        hash: createHash("sha256").update(fields.text).digest("hex"),
        enabled: fields.enabled, required: fields.required, mergeMode: fields.mergeMode,
        maxInjectedTokens: fields.maxInjectedTokens ?? 600, estimatedTokens: estimatePolicyTokens(fields.text),
      };
      validatePolicySnapshot(policy);
      db.run(`INSERT INTO comboPolicyVersions(comboId, version, policyId, text, hash, enabled, required, mergeMode, maxInjectedTokens, estimatedTokens, createdAt)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [comboId, version, policy.policyId, policy.text, policy.hash, Number(policy.enabled), Number(policy.required), policy.mergeMode, policy.maxInjectedTokens, policy.estimatedTokens, now]);
      action = policy.enabled && policy.mergeMode !== "off" ? "edit" : "disable";
    }
    db.run("INSERT INTO comboPolicySelections(comboId, version) VALUES(?, ?) ON CONFLICT(comboId) DO UPDATE SET version = excluded.version", [comboId, policy.version]);
    db.run(`INSERT INTO comboPolicyAudit(id, comboId, action, previousVersion, selectedVersion, hash, actor, createdAt)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), comboId, action, previous?.version ?? null, policy.version, policy.hash, actor, now]);
  });
  return state(db, comboId);
}
