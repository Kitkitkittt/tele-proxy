import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

// Only Next's request-local cookie adapter and nonessential side effects are replaced.
// Authentication, settings, privacy, ledger and gateway attribution use real persisted state.
const browser = vi.hoisted(() => ({ token: undefined, recordDrop: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: name => name === 'auth_token' && browser.token ? { value: browser.token } : undefined,
  set: (name, value) => { if (name === 'auth_token') browser.token = value; },
}) }));
vi.mock('open-sse/services/combo.js', () => ({ resetComboRotation() {} }));
vi.mock('../../src/lib/gatewayTelemetry.js', () => ({ recordDrop: browser.recordDrop })); // No collector or network in this suite.

const origin = 'http://localhost';
const startedAt = new Date('2030-01-01T00:00:00Z');
const sentinel = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_CONTENT_12ad';
const password = 'synthetic-persisted-password-12ad';
const environment = ['DATA_DIR', 'HOME', 'JWT_SECRET', 'INITIAL_PASSWORD', 'TELE_PROXY_ENABLED'];
let saved, temp, repositories, driver, guard, settings, login, privacy, ledger, gateway;

function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: { host: 'localhost', origin, 'content-type': 'application/json', ...(browser.token ? { cookie: `auth_token=${browser.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function loadRoutes() {
  repositories = await import('../../src/lib/db/index.js');
  driver = await import('../../src/lib/db/driver.js');
  guard = await import('../../src/dashboardGuard.js');
  settings = await import('../../src/app/api/settings/route.js');
  login = await import('../../src/app/api/auth/login/route.js');
  privacy = await import('../../src/app/api/observability/privacy/route.js');
  ledger = await import('../../src/app/api/usage/ledger/route.js');
  gateway = await import('../../src/lib/teleProxy.js');
}
async function http(path, body, method = body === undefined ? 'GET' : 'POST') {
  const req = request(path, body, method);
  const access = await guard.proxy(req);
  if (access.headers.get('x-middleware-next') !== '1') return access;
  const route = path.startsWith('/api/observability/privacy') ? privacy
    : path.startsWith('/api/settings') ? settings
    : path.startsWith('/api/auth/login') ? login : ledger;
  return route[method](req);
}
async function json(path, body, method, status = 200) {
  const response = await http(path, body, method);
  expect(response.status).toBe(status);
  return response.json();
}
async function signIn() {
  await json('/api/auth/login', { password });
  expect(browser.token).toBeTruthy();
}
async function optIn(projectId, enabled = true) {
  return json('/api/observability/privacy', { projectId, enabled, retentionHours: 1 }, 'PUT');
}
async function configuration() {
  return json('/api/observability/privacy');
}
async function inference(key, marker, spoofedProject) {
  const body = { model: marker, messages: [{ role: 'user', content: sentinel }], projectId: spoofedProject, approvedProjectId: spoofedProject };
  const req = new Request(`${origin}/v1/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-project-id': spoofedProject, 'x-9router-project-id': spoofedProject,
  }, body: JSON.stringify(body) });
  // The approved gateway entry seam is called after API-key/model-access checks.
  const response = await gateway.withGatewayRequest({ request: req, body, target: marker, requestedAlias: marker, authenticatedKey: key },
    () => Response.json({ choices: [{ message: { content: 'synthetic answer' }, finish_reason: 'stop' }] }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(JSON.stringify({ choices: [{ message: { content: 'synthetic answer' }, finish_reason: 'stop' }] }));
  // Privacy GET shares the capture queue: it deterministically drains async finalization.
  const diagnostics = await configuration();
  const summary = await json('/api/usage/ledger');
  const row = summary.recentRequests.find(row => row.requestedAlias === marker);
  expect(row).toBeDefined();
  return { diagnostics, row };
}

beforeEach(async () => {
  saved = Object.fromEntries(environment.map(key => [key, process.env[key]]));
  temp = await mkdtemp(resolve(tmpdir(), 'tele-proxy-privacy-regression-'));
  Object.assign(process.env, { DATA_DIR: resolve(temp, 'state'), HOME: resolve(temp, 'home'), TELE_PROXY_ENABLED: '1' });
  delete process.env.JWT_SECRET;
  delete process.env.INITIAL_PASSWORD;
  browser.token = undefined;
  browser.recordDrop.mockClear();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(startedAt);
  vi.resetModules();
  delete global._dbAdapter;
  delete globalThis[Symbol.for('tele-proxy.initialization')];
  await loadRoutes();
  // The initial setup is fixture data, never the user's installed state.
  await repositories.updateSettings({ requireLogin: false, requireApiKey: true, oidcClientSecret: 'synthetic-oidc-secret-12ad' });
  await json('/api/settings', { newPassword: password }, 'PATCH');
});
afterEach(async () => {
  vi.clearAllTimers();
  if (driver) (await driver.getAdapter()).close?.();
  delete global._dbAdapter;
  delete globalThis[Symbol.for('tele-proxy.initialization')];
  vi.resetModules();
  vi.useRealTimers();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe.sequential('persisted privacy HTTP consumers', () => {
  it('retains password, settings and authenticated privacy access across a database reopen', async () => {
    await signIn();
    await optIn('project-a');
    const token = browser.token;
    (await driver.getAdapter()).close?.();
    vi.clearAllTimers();
    // clearAllTimers also resets Vitest's fake clock; reopening must not move time backwards.
    vi.setSystemTime(startedAt);
    vi.resetModules();
    delete global._dbAdapter;
    await loadRoutes();
    expect((await configuration()).projects['project-a'].enabled).toBe(true);
    expect(browser.token).toBe(token);
    browser.token = undefined;
    expect((await json('/api/settings')).requireLogin).toBe(false);
    await json('/api/auth/login', { password: '123456' }, 'POST', 401);
    expect(browser.token).toBeUndefined();
    await signIn();
    expect((await configuration()).projects['project-a'].enabled).toBe(true);
  });

  it('omits persisted diagnostics from unauthenticated settings GET/PATCH and forbids privacy access or mass assignment', async () => {
    await signIn();
    await optIn('project-a');
    await json('/api/observability/privacy', { projectId: 'project-a', diagnostic: { event: 'request', outcome: 'success', durationMs: 7 } });
    const before = await configuration();
    browser.token = undefined;
    const get = await http('/api/settings');
    expect(get.headers.get('cache-control')).toBe('no-store');
    const visible = await get.json();
    expect(visible).toMatchObject({ requireLogin: false, hasPassword: true });
    expect(visible).not.toHaveProperty('teleProxyDiagnostics');
    expect(visible).not.toHaveProperty('password');
    expect(visible).not.toHaveProperty('oidcClientSecret');
    const patched = await json('/api/settings', { theme: 'dark' }, 'PATCH');
    expect(patched.theme).toBe('dark');
    expect(patched).not.toHaveProperty('teleProxyDiagnostics');
    expect(patched).not.toHaveProperty('password');
    expect(patched).not.toHaveProperty('oidcClientSecret');
    for (const value of [null, {}, { projects: { 'project-a': { enabled: false } } }]) {
      await json('/api/settings', { teleProxyDiagnostics: value, theme: 'attacker' }, 'PATCH', 403);
    }
    await json('/api/observability/privacy', undefined, 'GET', 401);
    await json('/api/observability/privacy', { projectId: 'project-a', enabled: false, retentionHours: 1 }, 'PUT', 401);
    await json('/api/observability/privacy', { projectId: 'project-a', diagnostic: { event: 'request', outcome: 'success' } }, 'POST', 401);
    await signIn();
    expect(await configuration()).toEqual(before);
    expect((await json('/api/settings')).theme).toBe('dark');
    const rejected = await json('/api/observability/privacy', { projectId: 'project-a', diagnostic: { event: 'request', outcome: 'success', content: sentinel } }, 'POST', 400);
    expect(JSON.stringify(rejected)).not.toContain(sentinel);
    expect(JSON.stringify(await configuration())).not.toContain(sentinel);
  });

  it('preserves inference and finalized accounting when diagnostic persistence fails', async () => {
    await signIn();
    const key = await repositories.createApiKey('synthetic project A', 'synthetic-machine');
    await json('/api/usage/ledger', { action: 'attribution', keyId: key.id, projectId: 'project-a', contractId: 'synthetic-contract' });
    await optIn('project-a');
    const adapter = await driver.getAdapter();
    const run = adapter.run;
    let failed = false;
    const write = vi.spyOn(adapter, 'run').mockImplementation((sql, params) => {
      if (!failed && sql.includes('INSERT INTO settings') && Object.values(JSON.parse(params[0]).teleProxyDiagnostics?.projects || {}).some(project => project.records?.length)) {
        failed = true;
        throw new Error('synthetic diagnostic persistence failure');
      }
      return run(sql, params);
    });
    let result;
    try {
      result = await inference(key.key, 'synthetic-write-failure', 'project-b');
    } finally {
      write.mockRestore();
    }
    expect(failed).toBe(true);
    expect(result.row).toMatchObject({ approvedProjectId: 'project-a', finalStatus: 'success' });
    expect(result.diagnostics.projects['project-a'].records).toEqual([]);
    expect(browser.recordDrop).toHaveBeenCalledWith('diagnostic_failed');
  });

  it('captures only authenticated-key attribution despite cross-project spoofing and stops at exact opt-in expiry', async () => {
    await signIn();
    const a = await repositories.createApiKey('synthetic project A', 'synthetic-machine');
    const b = await repositories.createApiKey('synthetic project B', 'synthetic-machine');
    for (const [key, projectId] of [[a, 'project-a'], [b, 'project-b']]) {
      await json('/api/usage/ledger', { action: 'attribution', keyId: key.id, projectId, contractId: 'synthetic-contract' });
      await optIn(projectId);
    }
    const first = await inference(a.key, 'synthetic-a', 'project-b');
    expect(first.row.approvedProjectId).toBe('project-a');
    expect(first.diagnostics.projects['project-a'].records).toEqual([expect.objectContaining({ requestId: first.row.requestId, event: 'request', outcome: 'success' })]);
    expect(first.diagnostics.projects['project-b'].records).toEqual([]);
    const second = await inference(b.key, 'synthetic-b', 'project-a');
    expect(second.row.approvedProjectId).toBe('project-b');
    expect(second.diagnostics.projects['project-b'].records).toEqual([expect.objectContaining({ requestId: second.row.requestId })]);
    expect(second.diagnostics.projects['project-a'].records).toHaveLength(1);
    expect(JSON.stringify(second.diagnostics)).not.toContain(sentinel);
    const expiresAt = second.diagnostics.projects['project-a'].expiresAt;
    vi.setSystemTime(expiresAt - 1);
    const beforeExpiry = await inference(a.key, 'synthetic-before-expiry', 'project-b');
    expect(beforeExpiry.diagnostics.projects['project-a'].records).toHaveLength(2);
    vi.setSystemTime(expiresAt);
    const expired = await inference(a.key, 'synthetic-at-expiry', 'project-b');
    expect(expired.diagnostics.projects['project-a']).toMatchObject({ enabled: false, expiresAt: null });
    expect(expired.diagnostics.projects['project-a'].records.map(record => record.requestId)).toEqual([beforeExpiry.row.requestId]);
    expect(expired.diagnostics.projects['project-b'].records).toEqual([]);
    await json('/api/observability/privacy', { projectId: 'project-a', diagnostic: { event: 'request', outcome: 'success' } }, 'POST', 403);
    await optIn('project-a');
    const renewed = await inference(a.key, 'synthetic-renewed', 'project-b');
    expect(renewed.diagnostics.projects['project-a'].records).toHaveLength(2);
    await optIn('project-a', false);
    expect((await configuration()).projects['project-a']).toMatchObject({ enabled: false, expiresAt: null, records: [] });
  });
});
