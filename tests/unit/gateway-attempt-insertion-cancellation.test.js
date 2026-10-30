import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe('gateway cancellation during durable attempt insertion', () => {
  let temp, db, ledger, gateway, dispatch, telemetry;
  let attemptReserved, releaseAttempt;
  const reserved = new Promise(resolve => { attemptReserved = resolve; });
  const release = new Promise(resolve => { releaseAttempt = resolve; });

  beforeAll(async () => {
    temp = await mkdtemp(resolve(tmpdir(), 'tele-proxy-cancel-insert-'));
    vi.stubEnv('DATA_DIR', resolve(temp, 'state'));
    vi.stubEnv('HOME', resolve(temp, 'home'));
    vi.stubEnv('TELE_PROXY_ENABLED', '1');
    // Prevent the telemetry exporter from making network calls; metrics still run.
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'synthetic=disabled');
    vi.resetModules();
    delete global._dbAdapter;
    vi.doMock('../../src/lib/requestLedger.js', async importOriginal => {
      const actual = await importOriginal();
      return { ...actual, startAttempt: async (...args) => {
        const attempt = await actual.startAttempt(...args);
        attemptReserved(attempt);
        await release;
        return attempt;
      } };
    });
    ledger = await import('../../src/lib/requestLedger.js');
    db = (await import('../../src/lib/db/driver.js')).getAdapter;
    gateway = await import('../../src/lib/teleProxy.js');
    dispatch = await import('../../open-sse/services/dispatchContext.js');
    telemetry = await import('../../src/lib/gatewayTelemetry.js');
  });

  afterAll(async () => {
    releaseAttempt();
    if (db) (await db()).close?.();
    delete global._dbAdapter;
    vi.doUnmock('../../src/lib/requestLedger.js');
    vi.unstubAllEnvs();
    vi.resetModules();
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  it('does not count a reservation cancelled before the physical send', async () => {
    const count = pattern => Number(telemetry.metricsText().match(pattern)?.[1] || 0);
    const requests = /^nine_router_requests_total\{environment="[^"]+",combo="other",outcome="cancelled"\} (\d+)$/m;
    const attempts = /^nine_router_attempts_total\{environment="[^"]+",provider="openai",outcome="cancelled",reason="cancelled"\} (\d+)$/m;
    const unknownUsage = /^nine_router_usage_unknown_total\{environment="[^"]+",provider="openai"\} (\d+)$/m;
    const before = [count(requests), count(attempts), count(unknownUsage)];
    const controller = new AbortController();
    const send = vi.fn(() => new Response(null, { status: 204 }));
    const request = new Request('http://localhost/v1/chat/completions', { method: 'POST', signal: controller.signal });
    const pending = gateway.withGatewayRequest({ request, body: {}, target: 'cancel-insert', requestedAlias: 'cancel-insert' }, () =>
      gateway.executeGatewayProvider({ provider: 'openai', model: 'synthetic', format: 'openai' }, () =>
        dispatch.withGenerationDispatch({}, () => dispatch.dispatchPhysicalFetch({}, send))));

    const reservedAttempt = await reserved;
    controller.abort();
    releaseAttempt();
    const response = await pending;
    const database = await db();
    const root = database.get('SELECT * FROM teleProxyRequests WHERE request_id = ?', [reservedAttempt.requestId]);
    const rows = await ledger.getRequestAttempts(reservedAttempt.requestId);

    expect(send).not.toHaveBeenCalled();
    expect(response.status).toBe(499);
    expect(root).toMatchObject({ final_status: 'cancelled', attempt_count: 0, accounting_completeness: 'incomplete' });
    expect(root.completed_at).toBeTruthy();
    expect(rows).toEqual([]);
    expect([count(requests), count(attempts), count(unknownUsage)]).toEqual([before[0] + 1, before[1], before[2]]);
  });
});
