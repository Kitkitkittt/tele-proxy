import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { applyComboPolicy, estimatePolicyTokens } from '../../open-sse/services/comboPolicy.js';
import { FORMATS } from '../../open-sse/translator/formats.js';
import { transformToOllama } from '../../open-sse/utils/ollamaTransform.js';
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
  let temp, ledger, db, key, gateway, dispatch, repositories, delayedFinish, observedEnd;
  const saved = Object.fromEntries(['DATA_DIR', 'HOME', 'TELE_PROXY_ENABLED', 'TELE_PROXY_PSEUDONYM_SECRET'].map(k => [k, process.env[k]]));
  beforeAll(async () => {
    temp = await mkdtemp(resolve(tmpdir(), 'tele-proxy-ledger-acceptance-'));
    process.env.DATA_DIR = resolve(temp, 'state'); process.env.HOME = resolve(temp, 'home'); process.env.TELE_PROXY_ENABLED = '1'; process.env.TELE_PROXY_PSEUDONYM_SECRET = 'synthetic-test-pseudonym-secret';
    vi.resetModules(); delete global._dbAdapter;
    repositories = await import('../../src/lib/db/index.js');
    key = await repositories.createApiKey('synthetic acceptance', 'synthetic-machine');
    vi.doMock('../../src/lib/requestLedger.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, finishRequest: async (...args) => {
        const delay = delayedFinish;
        if (delay?.phase === 'before') { delay.enter(); await delay.release; }
        const result = await actual.finishRequest(...args);
        if (delay?.phase === 'after') { delay.enter(); await delay.release; }
        return result;
      } };
    });
    vi.doMock('../../src/lib/gatewayTelemetry.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, endRequest: (handle, fields) => {
        actual.endRequest(handle, fields);
        observedEnd?.(fields);
      } };
    });
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
    vi.doUnmock('../../src/lib/requestLedger.js');
    vi.doUnmock('../../src/lib/gatewayTelemetry.js');
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
  it.each([
    ['GET polling', 'openrouter', 'job-1', 'GET'],
    ['Vertex POST polling', 'vertex', Buffer.from('projects/p/locations/us-central1/publishers/google/models/veo-3.1/operations/op').toString('base64url'), 'POST'],
  ])('does not count video %s as a generation attempt', async (_label, provider, requestId, method) => {
    const { handleVideoProxyCore } = await import('../../open-sse/handlers/videoCore.js');
    const sends = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options) => {
      sends.push({ url: String(url), method: options?.method || 'GET' });
      return Response.json({ request_id: 'synthetic-job', status: 'pending' });
    });
    try {
      const { response, attempts, row } = await requestThroughGateway('video-poll-' + provider, async () => {
        const result = await gateway.executeGatewayProvider({ provider, model: 'veo-3.1' }, () => handleVideoProxyCore({
          provider, requestId, credentials: provider === 'vertex' ? { accessToken: 'synthetic-access-token', projectId: 'p' } : { apiKey: 'synthetic-video-key' },
        }));
        return result.response;
      });
      expect(response.status).toBe(200);
      expect(sends).toHaveLength(1);
      expect(sends[0].method).toBe(method);
      expect(row.attempt_count).toBe(0);
      expect(attempts).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('records an internal transport timeout as an error, not a client cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('fetch connect timeout');
    const { response, row, attempts } = await requestThroughGateway('internal-timeout', () =>
      gateway.executeGatewayProvider({ provider: 'openai', model: 'fixture', format: 'openai' }, () =>
        dispatch.dispatchGeneration({ signal: controller.signal }, async () => {
          controller.abort(reason);
          throw reason;
        })));
    expect(response.status).toBe(502);
    expect(row).toMatchObject({ final_status: 'error', attempt_count: 1, accounting_completeness: 'incomplete' });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'error', errorClass: 'upstream', cancelState: 'none', usageSource: 'unknown' });
  });
  it('records a client timeout reason as client cancellation', async () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', signal: controller.signal });
    const response = await gateway.withGatewayRequest({ request, body: {}, target: 'client-timeout', requestedAlias: 'client-timeout' }, () =>
      gateway.executeGatewayProvider({ provider: 'openai', model: 'fixture', format: 'openai' }, () =>
        dispatch.dispatchGeneration({}, async () => {
          controller.abort(new DOMException('synthetic client deadline', 'TimeoutError'));
          throw controller.signal.reason;
        })));
    const database = await db();
    const root = database.get('SELECT * FROM teleProxyRequests WHERE requested_alias = ?', ['client-timeout']);
    const attempts = await ledger.getRequestAttempts(root.request_id);
    expect(response.status).toBe(499);
    expect(root).toMatchObject({ final_status: 'cancelled', attempt_count: 1 });
    expect(attempts[0]).toMatchObject({ status: 'cancelled', errorClass: 'cancelled', cancelState: 'client_cancelled' });
  });
  it('does not send or count a reserved attempt when the client aborts with an independent transport signal', async () => {
    const client = new AbortController();
    const transport = new AbortController();
    const send = vi.fn(() => new Response(null, { status: 204 }));
    const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', signal: client.signal });
    const response = await gateway.withGatewayRequest({ request, body: {}, target: 'independent-signal', requestedAlias: 'independent-signal' }, () =>
      gateway.executeGatewayProvider({ provider: 'openai', model: 'fixture' }, () =>
        dispatch.dispatchGeneration({ signal: transport.signal, observeNative() { client.abort(); } }, send)));
    const database = await db();
    const root = database.get('SELECT * FROM teleProxyRequests WHERE requested_alias = ?', ['independent-signal']);
    expect(response.status).toBe(499);
    expect(send).not.toHaveBeenCalled();
    expect(root).toMatchObject({ final_status: 'cancelled', attempt_count: 0, accounting_completeness: 'incomplete' });
    expect(await ledger.getRequestAttempts(root.request_id)).toEqual([]);
  });
  it('counts only observed upstream HTTP 5xx attempts once, not network failures or client statuses', async () => {
    const telemetry = await import('../../src/lib/gatewayTelemetry.js');
    const count = () => Number(telemetry.metricsText().match(/^nine_router_upstream_http_5xx_attempts_total\{environment="[^"]+",provider="openai"\} (\d+)$/m)?.[1] || 0);
    const before = count();
    const send = (alias, callback) => requestThroughGateway(alias, () => gateway.executeGatewayProvider({ provider: 'openai', model: 'fixture', format: 'openai' }, () => dispatch.dispatchGeneration({}, callback)));
    await send('status-503', () => new Response('upstream error', { status: 503 }));
    expect(count()).toBe(before + 1);
    await send('status-429', () => new Response('rate limited', { status: 429 }));
    await send('status-200', () => decoded());
    expect(count()).toBe(before + 1);
    await requestThroughGateway('status-network', async () => {
      try {
        await gateway.executeGatewayProvider({ provider: 'openai', model: 'fixture', format: 'openai' }, () => dispatch.dispatchGeneration({}, () => { throw new Error('network failure'); }));
      } catch {
        return new Response('gateway error', { status: 503 });
      }
      throw new Error('expected network failure');
    });
    expect(count()).toBe(before + 1);
    await send('status-599', () => new Response(null, { status: 599 }));
    expect(count()).toBe(before + 2);
    const root = telemetry.startRequest({});
    const attempt = telemetry.startAttempt(root, { provider: 'openai' });
    telemetry.endAttempt(attempt, { status: 'error', observedUpstreamHttpStatus: 500 });
    telemetry.endAttempt(attempt, { status: 'error', observedUpstreamHttpStatus: 500 });
    telemetry.endRequest(root, { status: 'error' });
    expect(count()).toBe(before + 3);
  });
  it('counts response-like DNS bypass 5xx at the physical send, not client statuses', async () => {
    const telemetry = await import('../../src/lib/gatewayTelemetry.js');
    const count = () => Number(telemetry.metricsText().match(/^nine_router_upstream_http_5xx_attempts_total\{environment="[^"]+",provider="openai"\} (\d+)$/m)?.[1] || 0);
    const before = count();
    const send = (alias, transport, status, clientStatus = status) => requestThroughGateway(alias, () =>
      gateway.executeGatewayProvider({ provider: 'openai', model: 'fixture', format: 'openai' }, () =>
        dispatch.withGenerationDispatch({}, async () => {
          const wire = await dispatch.dispatchPhysicalFetch({ transport }, () => ({
            status, headers: new Map(), body: new ReadableStream({ start(controller) { controller.close(); } }),
          }));
          return new Response(wire.body, { status: clientStatus });
        })));
    await send('bypass-status-503', 'http-dns-bypass', 503);
    expect(count()).toBe(before + 1);
    await send('bypass-status-429', 'http-dns-bypass', 429);
    await send('bypass-client-503', 'http-dns-bypass', 200, 503);
    await send('other-client-503', 'other', 503);
    expect(count()).toBe(before + 1);
  });
  it('counts only proven empty client Chat SSE at completed consumer EOF', async () => {
    const telemetry = await import('../../src/lib/gatewayTelemetry.js');
    const count = () => Number(telemetry.metricsText().match(/^nine_router_confirmed_empty_streams_total\{environment="[^"]+",combo="other"\} (\d+)$/m)?.[1] || 0);
    const before = count();
    const chunk = (delta, finish_reason = null, identity = {}) => `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 123, model: 'fixture', ...identity, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const done = 'data: [DONE]\n\n';
    const start = chunk({ role: 'assistant', content: '' });
    const stop = chunk({}, 'stop');
    const wrap = async (body, contentType = 'text/event-stream', signal) => {
      const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}', signal });
      return gateway.withGatewayRequest({ request, body: { model: 'empty-fixture' }, target: 'empty-fixture', requestedAlias: 'empty-fixture', authenticatedKey: key.key }, () =>
        new Response(body, { headers: { 'content-type': contentType } }));
    };
    const input = start + stop + done;
    const response = await wrap(input);
    expect(count()).toBe(before);
    expect(await response.text()).toBe(input);
    expect(count()).toBe(before + 1);
    const withUsage = start + chunk({}, 'stop', { usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 0 }, estimated: true } }) + done;
    expect(await (await wrap(withUsage)).text()).toBe(withUsage);
    expect(count()).toBe(before + 2);
    for (const raw of [
      chunk({ content: 'x' }) + stop + done,
      chunk({ refusal: 'no' }) + stop + done,
      chunk({ reasoning_content: 'reason' }) + stop + done,
      chunk({ tool_calls: [] }) + stop + done,
      chunk({ audio: { data: 'x' } }) + stop + done,
      start + chunk({}, 'stop', { usage: { prompt_tokens: -1 } }) + done,
      start + chunk({}, 'stop', { usage: { completion_tokens: '0' } }) + done,
      start + chunk({}, 'stop', { usage: { completion_tokens_details: { unknown: 0 } } }) + done,
      start + chunk({}, 'stop', { usage: { output: 'secret' } }) + done,
      start + chunk({}, 'stop', { usage: null }) + done,
      start + chunk({}, 'stop', { usage: { prompt_tokens: 1 } }).replace('"prompt_tokens":1', '"prompt_tokens":1,"prompt_tokens":1') + done,
      start + chunk({}, 'stop', { id: 'different' }) + done,
      start + chunk({}, 'stop', { model: 'different' }) + done,
      start + chunk({}, 'stop', { created: 124 }) + done,
      start + chunk({}, 'stop', { id: 'x'.repeat(129) }) + done,
      start + chunk({}, 'stop', { model: 'x'.repeat(129) }) + done,
      start + stop + stop + done,
      start + stop + chunk({}) + done,
      start + chunk({}, 'length') + done,
      start + stop,
      'data: {bad}\n\n' + start + stop + done,
      'data: {"object":"chat.completion.chunk","object":"chat.completion.chunk","choices":[]}\n\n' + start + stop + done,
      'data: ' + 'x'.repeat(65537) + '\n\n' + start + stop + done,
      start + stop + done + 'data: {"unexpected":true}\n\n',
      done,
    ]) expect(await (await wrap(raw)).text()).toBe(raw);
    expect(await (await wrap(input, 'application/x-ndjson')).text()).toBe(input);
    const invalid = new Uint8Array([...new TextEncoder().encode(start + stop), 0xff, ...new TextEncoder().encode(done)]);
    expect(new Uint8Array(await (await wrap(invalid)).arrayBuffer())).toEqual(invalid);
    const failure = new Error('stream failure');
    let sent = false;
    const broken = new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(input)); }
      else controller.error(failure);
    } }, { highWaterMark: 0 });
    await expect((await wrap(broken)).text()).rejects.toBe(failure);
    const cancelled = await wrap(input);
    const reader = cancelled.body.getReader();
    await reader.read();
    await reader.cancel('client left');
    const abort = new AbortController();
    const aborted = await wrap(input, 'text/event-stream', abort.signal);
    abort.abort();
    await expect(aborted.text()).rejects.toMatchObject({ name: 'AbortError' });
    expect(count()).toBe(before + 2);
  });
  it('counts only successful client EOF after delayed request persistence', async () => {
    const telemetry = await import('../../src/lib/gatewayTelemetry.js');
    const count = () => Number(telemetry.metricsText().match(/^nine_router_confirmed_empty_streams_total\{environment="[^"]+",combo="other"\} (\d+)$/m)?.[1] || 0);
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 123, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const input = chunk({ role: 'assistant', content: '' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
    const before = count();
    for (const [phase, mode] of [['before', 'cancel'], ['before', 'abort'], ['after', 'cancel'], ['after', 'abort'], ['after', 'success']]) {
      let enter, release, ended;
      const entered = new Promise(resolve => { enter = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      const endSeen = new Promise(resolve => { ended = resolve; });
      const events = [];
      observedEnd = fields => { events.push(fields); ended(); };
      delayedFinish = { phase, enter, release: released };
      const alias = `empty-race-${phase}-${mode}`;
      const expectedStatus = mode === 'success' ? 'success' : 'cancelled';
      const requests = outcome => Number(telemetry.metricsText().match(new RegExp(`^nine_router_requests_total\\{environment="[^"]+",combo="other",outcome="${outcome}"\\} (\\d+)$`, 'm'))?.[1] || 0);
      const beforeSuccess = requests('success'), beforeCancelled = requests('cancelled');
      try {
        const abort = new AbortController();
        const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}', signal: abort.signal });
        const response = await gateway.withGatewayRequest({ request, body: { model: alias }, target: alias, requestedAlias: alias, authenticatedKey: key.key }, () => new Response(input, { headers: { 'content-type': 'text/event-stream' } }));
        const reader = response.body.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe(input);
        const eof = reader.read();
        // Attach a rejection handler before triggering an abort.
        const eofResult = eof.then(value => ({ value }), error => ({ error }));
        await entered;
        const database = await db();
        const stored = () => database.get('SELECT final_status, completed_at FROM teleProxyRequests WHERE requested_alias = ?', [alias]);
        expect(stored().completed_at !== null).toBe(phase === 'after');
        if (phase === 'after') expect(stored().final_status).toBe('success');
        expect(count()).toBe(before);
        let cancellation;
        if (mode === 'cancel') cancellation = reader.cancel('client left');
        if (mode === 'abort') abort.abort();
        release();
        const result = await eofResult;
        if (cancellation) await cancellation;
        await endSeen;
        if (mode === 'abort') expect(result.error).toMatchObject({ name: 'AbortError' });
        else expect(result.value.done).toBe(true);
        expect(stored().final_status).toBe(expectedStatus);
        expect(events.map(event => event.status)).toEqual([expectedStatus]);
        expect(requests('success')).toBe(beforeSuccess + (mode === 'success' ? 1 : 0));
        expect(requests('cancelled')).toBe(beforeCancelled + (mode === 'success' ? 0 : 1));
        expect(count()).toBe(before + (mode === 'success' ? 1 : 0));
      } finally {
        release();
        delayedFinish = undefined;
        observedEnd = undefined;
      }
    }
  });
  it('does not classify the intermediate SSE transformed into Ollama output', async () => {
    const telemetry = await import('../../src/lib/gatewayTelemetry.js');
    const count = () => Number(telemetry.metricsText().match(/^nine_router_confirmed_empty_streams_total\{environment="[^"]+",combo="other"\} (\d+)$/m)?.[1] || 0);
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 123, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const input = chunk({ role: 'assistant', content: '' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
    const before = count();
    const request = new Request('http://localhost/v1/api/chat', { method: 'POST', body: '{}' });
    const response = await gateway.withGatewayRequest({ request, body: { model: 'empty-ollama' }, target: 'empty-ollama', requestedAlias: 'empty-ollama', authenticatedKey: key.key }, () => new Response(input, { headers: { 'content-type': 'text/event-stream' } }));
    const transformed = transformToOllama(response, 'fixture');
    expect(transformed.headers.get('content-type')).toBe('application/x-ndjson');
    expect((await transformed.text()).trim().split('\n').map(JSON.parse).every(value => value.done === true)).toBe(true);
    expect(count()).toBe(before);
  });
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
  // Acceptance: a streaming primary that already delivered client content must not dispatch
  // the fallback when its upstream stream later fails at the physical boundary.
  it('never dispatches a fallback model after the committed primary stream fails upstream', async () => {
    const { handleComboChat } = await import('../../open-sse/services/combo.js');
    const { handleStreamingResponse, buildOnStreamComplete } = await import('../../open-sse/handlers/chatCore/streamingHandler.js');
    const { createStreamController } = await import('../../open-sse/utils/streamHandler.js');
    const { initTranslators } = await import('../../open-sse/translator/index.js');
    await initTranslators();
    const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const combo = await repositories.createCombo({ name: 'committed-stream-failure', models: ['fixture/primary-ok', 'fixture/fallback-never'] });
    const sends = [];
    const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}' });
    const { response, text, row } = await requestThroughGateway('committed-stream-failure', () =>
      gateway.executeGatewayProvider({ provider: 'fixture', model: 'primary-ok', format: 'openai' }, () =>
        dispatch.dispatchGeneration({ provider: 'fixture', model: 'primary-ok', policySupported: false, transport: 'http' }, () => handleComboChat({
          body: { messages: [{ role: 'user', content: 'hi' }] },
          models: combo.models,
          handleSingleModel: async (_body, member) => {
            sends.push(member);
            if (member !== 'fixture/primary-ok') return new Response('unexpected fallback', { status: 500 });
            // Upstream HTTP boundary: content frame, then a transport failure mid-body.
            const failure = new Error('synthetic upstream stream failure');
            let sent = false;
            const upstream = new ReadableStream({ pull(controller) {
              if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'chatcmpl-committed', object: 'chat.completion.chunk', created: 1, model: 'primary-ok', choices: [{ index: 0, delta: { content: 'committed-visible' }, finish_reason: null }] })}\n\n`)); }
              else controller.error(failure);
            } }, { highWaterMark: 0 });
            const { onStreamComplete, streamDetailId } = buildOnStreamComplete({ provider: 'fixture', model: 'primary-ok', requestStartTime: Date.now(), body: { messages: [] }, stream: true, log: LOG });
            const streamed = await handleStreamingResponse({
              providerResponse: new Response(upstream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
              provider: 'fixture', model: 'primary-ok', sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
              body: { messages: [{ role: 'user', content: 'hi' }] }, stream: true, requestStartTime: Date.now(),
              streamController: createStreamController({ log: LOG, provider: 'fixture', model: 'primary-ok' }),
              onStreamComplete, streamDetailId, log: LOG,
            });
            return streamed.response;
          },
          log: LOG, comboName: combo.name, comboStrategy: 'fallback',
        })),
      ), combo.name);
    expect(text).toContain('committed-visible');
    expect(response.status).toBe(200);
    // Read-after-drain: sends are recorded durably as attempts settle.
    const attemptsAfter = await ledger.getRequestAttempts(row.request_id);
    expect(sends).toEqual(['fixture/primary-ok']);
    expect(row).toMatchObject({ requested_alias: 'committed-stream-failure', attempt_count: 1 });
    expect(attemptsAfter).toHaveLength(1);
    expect(attemptsAfter[0]).toMatchObject({ provider: 'fixture', requestedModel: 'primary-ok' });
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
  it('serves inference and counts degradation when the logical request insert fails', async () => {
    const database = await db();
    const trigger = 'teleproxy_test_failure_request';
    database.run(`CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON teleProxyRequests WHEN NEW.requested_alias = 'request-insert-failure' BEGIN SELECT RAISE(FAIL, 'simulated ledger failure'); END`);
    const telemetry = await import('../../src/lib/gatewayTelemetry.js');
    const before = (telemetry.metricsText().match(/^nine_router_ledger_write_failures_total\{[^}]*\} (\d+)$/m) || [, '0'])[1];
    try {
      const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', body: '{}' });
      const response = await gateway.withGatewayRequest({
        request, body: { model: 'request-insert-failure' }, target: 'request-insert-failure',
        requestedAlias: 'request-insert-failure', authenticatedKey: key.key,
      }, () => gateway.executeGatewayProvider({ provider: 'fixture', model: 'metered', format: 'openai' }, () =>
        dispatch.dispatchGeneration({}, () => decoded())));
      expect(response.status).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
      expect(database.get('SELECT request_id FROM teleProxyRequests WHERE requested_alias = ?', ['request-insert-failure'])).toBeUndefined();
      const after = Number((telemetry.metricsText().match(/^nine_router_ledger_write_failures_total\{[^}]*\} (\d+)$/m) || [, '0'])[1]);
      expect(after).toBeGreaterThan(Number(before));
    } finally {
      database.run(`DROP TRIGGER ${trigger}`);
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
  it('corrects only successful EOF outcomes without changing attempt cost or accepting later corrections', async () => {
    const request = await ledger.startRequest({ authenticatedKeyId: key.id });
    const attempt = await ledger.startAttempt(request.requestId, { provider: 'fixture', requestedModel: 'metered' });
    await ledger.finishAttempt(attempt.attemptId, { status: 'success', format: 'openai', usage: USAGE });
    const attempts = await ledger.getRequestAttempts(request.requestId);
    await ledger.finishRequest(request.requestId, { status: 'success' });
    expect((await ledger.correctRequestEofOutcome(request.requestId, 'cancelled')).finalStatus).toBe('cancelled');
    expect((await ledger.correctRequestEofOutcome(request.requestId, 'error')).finalStatus).toBe('cancelled');
    expect((await ledger.finishRequest(request.requestId, { status: 'success' })).finalStatus).toBe('cancelled');
    expect(await ledger.getRequestAttempts(request.requestId)).toEqual(attempts);
    const failed = await ledger.startRequest({ authenticatedKeyId: key.id });
    await ledger.finishRequest(failed.requestId, { status: 'error' });
    expect((await ledger.correctRequestEofOutcome(failed.requestId, 'cancelled')).finalStatus).toBe('error');
    await expect(ledger.correctRequestEofOutcome(request.requestId, 'success')).rejects.toThrow('Invalid EOF correction outcome');
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
