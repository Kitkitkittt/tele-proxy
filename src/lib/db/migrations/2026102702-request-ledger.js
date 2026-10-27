// Additive, adapter-neutral ledger migration. Existing reference usage is not imported as spend.
export default {
  version: 2026102702,
  name: "request-ledger",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS teleProxyRequests (
        request_id TEXT PRIMARY KEY, trace_id TEXT, received_at TEXT NOT NULL, completed_at TEXT,
        environment TEXT NOT NULL, authenticated_key_id TEXT, approved_project_id TEXT, contract_id TEXT,
        optional_session_id TEXT, client_family TEXT, requested_alias TEXT, resolved_combo TEXT,
        reasoning_effort TEXT, policy_id TEXT, policy_version INTEGER, policy_hash TEXT,
        policy_applied_status TEXT, final_status TEXT NOT NULL DEFAULT 'inflight',
        attempt_count INTEGER NOT NULL DEFAULT 0, total_duration_ms INTEGER,
        accounting_completeness TEXT NOT NULL DEFAULT 'incomplete'
      );
      CREATE INDEX IF NOT EXISTS teleProxyRequests_received ON teleProxyRequests(received_at);
      CREATE TABLE IF NOT EXISTS teleProxyAttempts (
        attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES teleProxyRequests(request_id),
        sequence INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        provider TEXT, connection_pseudonym TEXT, requested_model TEXT, response_model TEXT,
        contract_id TEXT, status TEXT NOT NULL DEFAULT 'inflight', error_class TEXT,
        fallback_reason TEXT, cancel_state TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cached_input_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        usage_source TEXT NOT NULL DEFAULT 'unknown', allowlisted_raw_usage TEXT,
        provider_reported_charge_micros INTEGER, invoice_reconciled_spend_micros INTEGER,
        metered_cost_estimate_micros INTEGER, api_equivalent_value_micros INTEGER,
        subscription_allocation_micros INTEGER, local_infrastructure_allocation_micros INTEGER,
        currency TEXT, provider_reported_currency TEXT, reference_currency TEXT,
        billing_mode TEXT NOT NULL DEFAULT 'unknown', price_snapshot_id TEXT,
        reference_price_snapshot_id TEXT, cost_status TEXT NOT NULL DEFAULT 'unknown',
        charge_evidence_source TEXT, invoice_evidence_source TEXT,
        subscription_evidence_source TEXT, local_evidence_source TEXT,
        upstream_first_content_ms INTEGER, downstream_first_content_ms INTEGER,
        UNIQUE(request_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS teleProxyAttempts_request ON teleProxyAttempts(request_id);
      CREATE INDEX IF NOT EXISTS teleProxyAttempts_started ON teleProxyAttempts(started_at);
      CREATE TABLE IF NOT EXISTS teleProxyTariffs (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, contract_id TEXT NOT NULL,
        effective_from TEXT NOT NULL, effective_to TEXT, basis TEXT NOT NULL, currency TEXT NOT NULL,
        evidence_source TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL,
        UNIQUE(provider, model, contract_id, effective_from, basis)
      );
      CREATE INDEX IF NOT EXISTS teleProxyTariffs_lookup ON teleProxyTariffs(provider, model, contract_id, effective_from);
      CREATE TABLE IF NOT EXISTS teleProxyAttribution (
        key_id TEXT PRIMARY KEY REFERENCES apiKeys(id), project_id TEXT NOT NULL,
        contract_id TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS teleProxyFixedFees (
        id TEXT PRIMARY KEY, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
        currency TEXT NOT NULL, amount_micros INTEGER NOT NULL, billing_mode TEXT NOT NULL,
        evidence_source TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(period_start, period_end, currency, billing_mode, evidence_source)
      );
    `);
  },
};
