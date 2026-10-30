// Optional additive policy state; existing combos remain unconfigured and disabled.
export default {
  version: 2026102701,
  name: "combo-policy",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS comboPolicyVersions (
        comboId TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE, version INTEGER NOT NULL,
        policyId TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
        enabled INTEGER NOT NULL, required INTEGER NOT NULL, mergeMode TEXT NOT NULL,
        maxInjectedTokens INTEGER NOT NULL, estimatedTokens INTEGER NOT NULL,
        createdAt TEXT NOT NULL, PRIMARY KEY(comboId, version)
      );
      CREATE TABLE IF NOT EXISTS comboPolicySelections (
        comboId TEXT PRIMARY KEY REFERENCES combos(id) ON DELETE CASCADE, version INTEGER NOT NULL,
        FOREIGN KEY(comboId, version) REFERENCES comboPolicyVersions(comboId, version)
      );
      CREATE TABLE IF NOT EXISTS comboPolicyAudit (
        id TEXT PRIMARY KEY, comboId TEXT NOT NULL, action TEXT NOT NULL,
        previousVersion INTEGER, selectedVersion INTEGER NOT NULL,
        hash TEXT NOT NULL, actor TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comboPolicyAudit_combo ON comboPolicyAudit(comboId, createdAt);
    `);
  },
};
