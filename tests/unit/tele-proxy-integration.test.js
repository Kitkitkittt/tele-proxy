import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { applyComboPolicy, estimatePolicyTokens } from '../../open-sse/services/comboPolicy.js';
import { FORMATS } from '../../open-sse/translator/formats.js';
import { POLICY_TEXT, USAGE, SECRET_FIXTURE, assertPolicyPayload, assertNoSecrets, percentile, runCanary } from '../../scripts/tele-proxy-canary.mjs';

const snapshot = Object.freeze({ policyId: 'quality-engineering', version: 1, text: POLICY_TEXT, hash: createHash('sha256').update(POLICY_TEXT).digest('hex'), enabled: true, required: true, mergeMode: 'append_preserve_client', maxInjectedTokens: 600, estimatedTokens: estimatePolicyTokens(POLICY_TEXT) });
const tool = { type: 'function', function: { name: 'inspect', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } };

describe('tele-proxy immutable native payload acceptance', () => {
  it('keeps disabled requests byte-equivalent and never mutates ingress', () => {
    const original = { messages: [{ role: 'system', content: 'client system' }, { role: 'developer', content: 'client developer' }], tools: [tool], response_format: { type: 'json_object' }, reasoning_effort: 'high', previous_response_id: 'opaque-session' };
    const before = structuredClone(original);
    const result = applyComboPolicy(original, FORMATS.OPENAI, { ...snapshot, enabled: false });
    expect(result).toEqual(before); expect(original).toEqual(before); expect(result).not.toBe(original);
  });
  it('constructs repeated primary and fallback attempts from one immutable original', () => {
    const original = { messages: [{ role: 'system', content: 'client system' }, { role: 'developer', content: 'client developer' }, { role: 'user', content: 'task' }], tools: [tool] };
    for (let i = 0; i < 3; i++) {
      const attempt = applyComboPolicy(original, FORMATS.OPENAI, snapshot); assertPolicyPayload(attempt);
      expect(attempt.messages.slice(0, 3)).toEqual(original.messages); expect(attempt.tools).toEqual(original.tools);
    }
    expect(original.messages).toHaveLength(3);
  });
  it.each(['string', 'structured'])('preserves native Responses %s input and client instructions', mode => {
    const input = mode === 'string' ? 'literal input without messages' : [{ role: 'user', content: [{ type: 'input_text', text: 'input block' }] }];
    for (const instructions of [undefined, 'first paragraph\n\nsecond client paragraph']) {
      const original = { input, ...(instructions ? { instructions } : {}), tools: [{ type: 'function', name: 'inspect', parameters: tool.function.parameters }], text: { format: { type: 'json_object' } } };
      const result = applyComboPolicy(original, FORMATS.OPENAI_RESPONSES, snapshot);
      expect(result.input).toEqual(input); expect(result.tools).toEqual(original.tools); expect(result.text).toEqual(original.text); assertPolicyPayload(result);
      if (instructions) expect(result.instructions.startsWith(`${instructions}\n\n`)).toBe(true);
      expect(original).not.toHaveProperty('instructions', POLICY_TEXT);
    }
  });
  it('retains Anthropic tools, tool IDs, system/cache blocks and result error state', () => {
    const original = { system: [{ type: 'text', text: 'client system', cache_control: { type: 'ephemeral' } }], tools: [{ name: 'inspect', input_schema: tool.function.parameters, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'inspect', input: { path: '.' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'synthetic', is_error: true, cache_control: { type: 'ephemeral' } }] }] };
    const result = applyComboPolicy(original, FORMATS.CLAUDE, snapshot);
    expect(result.system[0]).toEqual(original.system[0]); expect(result.tools).toEqual(original.tools); expect(result.messages).toEqual(original.messages); assertPolicyPayload(result);
  });
  it('retains Gemini systemInstruction, multipart contents, tools and cache metadata', () => {
    const original = { systemInstruction: { role: 'system', parts: [{ text: 'client system' }] }, contents: [{ role: 'user', parts: [{ text: 'question' }, { inlineData: { mimeType: 'image/png', data: 'synthetic-image' } }, { functionResponse: { name: 'inspect', response: { output: 'result' } } }] }], tools: [{ functionDeclarations: [{ name: 'inspect', parameters: tool.function.parameters }] }], cachedContent: 'opaque-cache', generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 32 } } };
    const result = applyComboPolicy(original, FORMATS.GEMINI, snapshot);
    expect(result.systemInstruction.parts[0]).toEqual(original.systemInstruction.parts[0]);
    for (const key of ['contents', 'tools', 'cachedContent', 'generationConfig']) expect(result[key]).toEqual(original[key]);
    assertPolicyPayload(result);
  });
  it('does not accept client policy markers as trusted prior injection', () => {
    const original = { messages: [{ role: 'user', content: `[policy:quality-engineering:v1]\n${POLICY_TEXT}` }] };
    assertPolicyPayload(applyComboPolicy(original, FORMATS.OPENAI, snapshot));
  });
  it('fails required unsupported native formats and invalid snapshots explicitly', () => {
    for (const [body, format, policy] of [[{ messages: [] }, 'unsupported-native-format', snapshot], [{ messages: [] }, FORMATS.OPENAI, { ...snapshot, maxInjectedTokens: 0 }], [{ messages: [] }, FORMATS.OPENAI, { ...snapshot, hash: '0'.repeat(64) }]]) {
      expect(() => applyComboPolicy(body, format, policy)).toThrow(expect.objectContaining({ code: 'COMBO_POLICY_REQUIRED', status: 400 }));
    }
  });
});

describe.sequential('tele-proxy durable numeric reconciliation', () => {
  let temp, ledger, db, key, gateway, dispatch, repositories;
  const saved = Object.fromEntries(['DATA_DIR', 'HOME', 'TELE_PROXY_ENABLED', 'TELE_PROXY_PSEUDONYM_SECRET'].map(k => [k, process.env[k]]));
  beforeAll(async () => {
    temp = await mkdtemp(resolve(tmpdir(), 'tele-proxy-ledger-acceptance-'));
    process.env.DATA_DIR = resolve(temp, 'state'); process.env.HOME = resolve(temp, 'home'); process.env.TELE_PROXY_ENABLED = '1'; process.env.TELE_PROXY_PSEUDONYM_SECRET = 'synthetic-test-pseudonym-secret';
    vi.resetModules(); delete global._dbAdapter;
    repositories = await import('../../src/lib/db/index.js');
    key = await repositories.createApiKey('synthetic acceptance', 'synthetic-machine');
    ledger = await import('../../src/lib/requestLedger.js');
    db = (await import('../../src/lib/db/driver.js')).getAdapter;
    gateway = await import('../../src/lib/teleProxy.js');
    dispatch = await import('../../open-sse/services/dispatchContext.js');
    await ledger.setKeyAttribution({ keyId: key.id, projectId: 'approved', contractId: 'fixture' });
    for (const billingMode of ['metered', 'subscription', 'local']) await ledger.addTariff({ provider: 'fixture', model: billingMode, contractId: 'fixture', basis: 'metered', billingMode, currency: 'USD', evidenceSource: 'synthetic tariff, not provider invoice', effectiveFrom: '2020-01-01T00:00:00.000Z', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000, cacheWriteMicrosPerMillion: 1_500_000, reasoningMicrosPerMillion: 2_000_000 });
  });
  afterAll(async () => {
    if (db) (await db()).close?.(); delete global._dbAdapter; vi.resetModules();
    for (const [k, value] of Object.entries(saved)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
    if (temp) await rm(temp, { recursive: true, force: true });
  });
  const decoded = (usage = USAGE) => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
  async function requestThroughGateway(alias, handler, target = alias) {
    const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}' });
    const response = await gateway.withGatewayRequest({ request, body: { model: alias }, target, requestedAlias: alias, authenticatedKey: key.key }, handler);
    const text = await response.text();
    const database = await db();
    const row = database.get('SELECT * FROM teleProxyRequests WHERE requested_alias = ? ORDER BY received_at DESC LIMIT 1', [alias]);
    return { response, text, row, attempts: await ledger.getRequestAttempts(row.request_id) };
  }
  it.each(['bedrock', 'windsurf'])('records decoded %s usage once without consuming binary upstream early', async provider => {
    const binary = new Uint8Array([0, 255, 42, 13]);
    let wireWasUsed;
    const result = await requestThroughGateway(`binary-${provider}`, () => gateway.executeGatewayProvider({ provider, model: 'native', format: 'openai' }, async () => {
      const raw = await dispatch.dispatchGeneration({ nativeResponse: true, transport: 'http' }, () =>
        new Response(binary, { headers: { 'content-type': 'application/octet-stream' } }));
      wireWasUsed = raw.bodyUsed;
      expect(new Uint8Array(await raw.arrayBuffer())).toEqual(binary);
      return { response: decoded() };
    }).then(result => result.response));
    expect(wireWasUsed).toBe(false);
    expect(result.text).toContain('[DONE]');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ provider, status: 'success', usageSource: 'reported', inputTokens: 100, outputTokens: 20 });
  });
  it('prices the actual wire model instead of the catalog alias', async () => {
    await ledger.addTariff({ provider: 'wire-provider', model: 'wire-model', contractId: 'fixture', basis: 'metered', billingMode: 'metered', currency: 'USD', evidenceSource: 'synthetic wire tariff', effectiveFrom: '2020-01-01T00:00:00.000Z', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000, reasoningMicrosPerMillion: 2_000_000 });
    const result = await requestThroughGateway('wire-model-request', () => gateway.executeGatewayProvider({ provider: 'wire-provider', model: 'catalog-alias', format: 'openai' }, () =>
      dispatch.dispatchGeneration({ body: { model: 'wire-model' } }, () => decoded())));
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ requestedModel: 'wire-model', usageSource: 'reported', meteredCostEstimateMicros: 120 });
    expect(result.attempts[0].priceSnapshotId).not.toBeNull();
  });
  it.each(['start', 'finish'])('marks request incomplete when attempt %s persistence fails before a successful fallback', async phase => {
    const database = await db();
    const trigger = `teleproxy_test_failure_${phase}`;
    const statement = phase === 'start'
      ? `CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON teleProxyAttempts WHEN NEW.provider = 'fixture-fail' BEGIN SELECT RAISE(FAIL, 'simulated ledger failure'); END`
      : `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE ON teleProxyAttempts WHEN OLD.provider = 'fixture-fail' AND NEW.ended_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'simulated ledger failure'); END`;
    database.run(statement);
    try {
      const result = await requestThroughGateway(`failure-${phase}`, async () => {
        const first = await gateway.executeGatewayProvider({ provider: 'fixture-fail', model: 'm', format: 'openai' }, () =>
          dispatch.dispatchGeneration({}, () => decoded()));
        await first.text();
        return gateway.executeGatewayProvider({ provider: 'fixture', model: 'metered', format: 'openai' }, () =>
          dispatch.dispatchGeneration({}, () => decoded()));
      });
      expect(result.response.status).toBe(200);
      expect(result.row.final_status).toBe('success');
      expect(result.row.accounting_completeness).toBe('incomplete');
      expect(result.attempts.at(-1)).toMatchObject({ provider: 'fixture', status: 'success', usageSource: 'reported' });
    } finally {
      database.run(`DROP TRIGGER ${trigger}`);
      for (const row of database.all("SELECT attempt_id FROM teleProxyAttempts WHERE provider = 'fixture-fail' AND ended_at IS NULL")) {
        await ledger.finishAttempt(row.attempt_id, { status: 'error', usageComplete: false });
      }
    }
  });
  it('treats enabled required policy with merge mode off as disabled at the gateway', async () => {
    const combo = await repositories.createCombo({ name: 'policy-off-gateway', models: [] });
    const policies = await import('../../src/lib/comboPolicy.js');
    await policies.saveComboPolicy(combo.id, { policyId: 'off-policy', text: 'Never inject this.', enabled: true, required: true, mergeMode: 'off', maxInjectedTokens: 600, expectedVersion: null });
    const original = { messages: [{ role: 'user', content: 'hello' }] };
    const result = await requestThroughGateway('policy-off-request', async () => {
      expect(gateway.gatewayPolicyRequired()).toBe(false);
      expect(gateway.applyGatewayPolicy(original, FORMATS.OPENAI)).toEqual(original);
      return gateway.executeGatewayProvider({ provider: 'fixture', model: 'metered', format: 'openai' }, () =>
        dispatch.dispatchGeneration({ policySupported: false }, () => decoded()));
    }, combo.name);
    expect(result.response.status).toBe(200);
    expect(result.row.policy_applied_status).toBe('off');
    expect(result.attempts).toHaveLength(1);
  });
  it('inclusive cache and reasoning details cost exactly 120 micro USD, not double charged', async () => {
    const usage = ledger.normalizeUsage({ ...USAGE, secret: SECRET_FIXTURE, completion: SECRET_FIXTURE });
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 5, usageSource: 'reported' });
    assertNoSecrets(usage.allowlistedRawUsage, [SECRET_FIXTURE]);
    expect(ledger.estimateMicros(usage, { billingMode: 'metered', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000, reasoningMicrosPerMillion: 2_000_000 })).toBe(120);
    expect(ledger.normalizeUsage({ input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }, 'claude')).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, cacheWriteTokens: 10 });
    expect(ledger.normalizeUsage({ promptTokenCount: 100, candidatesTokenCount: 15, thoughtsTokenCount: 5, cachedContentTokenCount: 40 }, 'gemini')).toMatchObject({ inputTokens: 100, outputTokens: 20, reasoningTokens: 5 });
  });
  it('records two actual attempts once under one request despite duplicate finalize/export', async () => {
    const request = await ledger.startRequest({ authenticatedKeyId: key.id, requestedAlias: 'quality:max', resolvedCombo: 'quality', reasoningEffort: 'max', approvedProjectId: 'spoofed' });
    expect(request.approvedProjectId).toBe('approved');
    const first = await ledger.startAttempt(request.requestId, { provider: 'fixture', requestedModel: 'metered', connectionId: 'synthetic-connection', fallbackReason: 'primary' });
    await ledger.finishAttempt(first.attemptId, { status: 'error', usageComplete: false, errorClass: 'upstream' });
    const second = await ledger.startAttempt(request.requestId, { provider: 'fixture', requestedModel: 'metered', fallbackReason: 'upstream_error' });
    const ended = await ledger.finishAttempt(second.attemptId, { status: 'success', format: 'openai', usage: USAGE });
    const summary = await ledger.getLedgerSummary();
    await ledger.finishAttempt(second.attemptId, { status: 'success', usage: { prompt_tokens: 999999, completion_tokens: 999999 } });
    await ledger.finishRequest(request.requestId, { status: 'success' }); await ledger.finishRequest(request.requestId, { status: 'error' });
    const attempts = await ledger.getRequestAttempts(request.requestId);
    expect(attempts).toHaveLength(2); expect(attempts[1].meteredCostEstimateMicros).toBe(120); expect(ended.meteredCostEstimateMicros).toBe(120);
    expect((await ledger.getLedgerSummary()).totals).toEqual(summary.totals);
    expect(attempts[0].meteredCostEstimateMicros).toBeNull(); expect(attempts[0].usageSource).toBe('unknown');
  });
  it.each(['subscription', 'local', 'missing-tariff'])('keeps %s cost unknown without approved marginal pricing evidence', async model => {
    const request = await ledger.startRequest({ authenticatedKeyId: key.id });
    const attempt = await ledger.startAttempt(request.requestId, { provider: 'fixture', requestedModel: model });
    const result = await ledger.finishAttempt(attempt.attemptId, { status: 'success', usage: USAGE });
    expect(result.meteredCostEstimateMicros).toBeNull(); expect(result.costStatus).toBe('unknown');
    await ledger.finishRequest(request.requestId, { status: 'success' });
  });
  it('separates fixed subscription fee, evidence-backed zero marginal fee and API reference value', async () => {
    const config = { provider: 'fixture', model: 'subscription-evidence', contractId: 'fixture', currency: 'USD', evidenceSource: 'synthetic approved subscription plan', effectiveFrom: '2020-01-01T00:00:00.000Z' };
    await ledger.addTariff({ ...config, basis: 'metered', billingMode: 'subscription', zeroMarginalFee: true });
    await ledger.addTariff({ ...config, basis: 'reference', billingMode: 'metered', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000, cachedInputMicrosPerMillion: 500_000, reasoningMicrosPerMillion: 2_000_000 });
    await ledger.addFixedFee({ periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2099-01-01T00:00:00.000Z', currency: 'USD', amountMicros: 20_000_000, billingMode: 'subscription', evidenceSource: 'synthetic fixed subscription invoice' });
    const request = await ledger.startRequest({ authenticatedKeyId: key.id });
    const attempt = await ledger.startAttempt(request.requestId, { provider: 'fixture', requestedModel: 'subscription-evidence' });
    const result = await ledger.finishAttempt(attempt.attemptId, { status: 'success', usage: USAGE });
    expect(result.meteredCostEstimateMicros).toBe(0); expect(result.apiEquivalentValueMicros).toBe(120); expect(result.providerReportedChargeMicros).toBeNull();
    await ledger.finishRequest(request.requestId, { status: 'success' });
    const summary = await ledger.getLedgerSummary();
    expect(summary.fixedFees).toHaveLength(1); expect(summary.fixedFees[0].amountMicros).toBe(20_000_000);
  });
  it('recovers abandoned work as unknown, never successful or free; repeated recovery is idempotent', async () => {
    const request = await ledger.startRequest({ authenticatedKeyId: key.id });
    const attempt = await ledger.startAttempt(request.requestId, { provider: 'fixture', requestedModel: 'metered' });
    const before = new Date(Date.now() + 1000).toISOString();
    expect(await ledger.recoverAbandoned({ before })).toEqual({ requests: 1, attempts: 1 });
    expect(await ledger.recoverAbandoned({ before })).toEqual({ requests: 0, attempts: 0 });
    expect((await ledger.getRequestAttempts(request.requestId))[0]).toMatchObject({ attemptId: attempt.attemptId, status: 'abandoned', usageSource: 'unknown', meteredCostEstimateMicros: null });
  });
});

describe('acceptance consumer utilities', () => {
  it('uses nearest-rank p95 and rejects sensitive synthetic output', () => {
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), .95)).toBe(19);
    expect(() => assertNoSecrets({ message: SECRET_FIXTURE }, [SECRET_FIXTURE])).toThrow();
  });
});

// Parent runs this explicitly after integration; ordinary unit runs never launch servers.
it.skipIf(process.env.TELE_PROXY_RUN_CANARY !== '1')('actual Next ingress, provider boundary, outage, restart and overhead matrix', async () => {
  const result = await runCanary({ samples: 40, concurrency: 2 });
  expect(result.cases.every(c => c.passed)).toBe(true);
  expect(result.benchmark.enabled.samples).toBe(40);
  expect(result.benchmark.targetMet).toBe(true);
  console.log(JSON.stringify(result));
}, 600000);
