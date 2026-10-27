import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withGenerationDispatch, dispatchPhysicalFetch } from "../../open-sse/services/dispatchContext.js";

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(), policy: null, starts: [], finishes: [], spans: [], requests: [],
}));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: async () => ({ provider: "opencode", model: "jev-1.13-free" }) }));
vi.mock("../../src/sse/services/auth.js", () => ({ getProviderCredentials: async () => ({ accessToken: "public", connectionId: "classifier-connection" }) }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_provider, credentials) => credentials }));
vi.mock("../../src/lib/db/repos/combosRepo.js", () => ({ getComboByName: async () => ({ name: "smart-fixture" }) }));
vi.mock("../../src/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("../../src/lib/comboPolicy.js", () => ({ snapshotComboPolicy: async () => fixture.policy }));
vi.mock("../../src/lib/requestLedger.js", () => ({
  recoverAbandoned: async () => {}, pruneLedger: async () => {},
  startRequest: async () => ({ requestId: "request-fixture" }),
  finishRequest: async (_id, fields) => { fixture.requests.push(fields); },
  startAttempt: async (_id, fields) => {
    const row = { attemptId: `attempt-${fixture.starts.length + 1}` };
    fixture.starts.push({ ...fields, ...row }); return row;
  },
  finishAttempt: async (id, fields) => { fixture.finishes.push({ id, ...fields }); return {}; },
  normalizeUsage: usage => usage,
}));
vi.mock("../../src/lib/gatewayTelemetry.js", () => ({
  startRequest: () => ({ traceId: "trace-fixture" }),
  startAttempt: (_root, fields) => { fixture.spans.push(fields); return {}; },
  endRequest() {}, endAttempt() {}, attachRequestIdentity() {}, event() {}, ledgerFailure() {},
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async () => {
  const { dispatchPhysicalFetch } = await import("../../open-sse/services/dispatchContext.js");
  return { proxyAwareFetch: (...args) => dispatchPhysicalFetch({ signal: args[1]?.signal, transport: "http-direct" }, () => fixture.fetch(...args)) };
});
import { resolveSmartChoice } from "../../src/sse/services/systemoneRouter.js";
import { withGatewayRequest, executeGatewayProvider } from "../../src/lib/teleProxy.js";

const usage = { input_tokens: 12, output_tokens: 3 };
const decision = () => Response.json({ model: "jev-1.13-free", answers: { route: { choice: "fixture/main", confidence: 0.9 } }, usage });
const options = { body: { messages: [{ role: "user", content: "synthetic task" }] }, models: ["fixture/main", "fixture/other"] };
const savedFlag = process.env.TELE_PROXY_ENABLED;
async function gateway(callback, signal) {
  const request = new Request("http://localhost/v1/chat/completions", { signal });
  return withGatewayRequest({ request, body: options.body, target: "smart-fixture", requestedAlias: "smart-fixture" }, callback);
}

beforeEach(() => {
  process.env.TELE_PROXY_ENABLED = "1";
  fixture.policy = null; fixture.fetch.mockReset();
  for (const key of ["starts", "finishes", "spans", "requests"]) fixture[key].length = 0;
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.TELE_PROXY_ENABLED;
  else process.env.TELE_PROXY_ENABLED = savedFlag;
});

describe("System One smart classifier physical boundary", () => {
  it("records classifier and selected generation as distinct attempts and spans with their own usage", async () => {
    fixture.fetch.mockResolvedValueOnce(decision());
    const response = await gateway(async () => {
      expect(await resolveSmartChoice(options)).toMatchObject({ choice: "fixture/main" });
      return executeGatewayProvider({ provider: "fixture", model: "main", format: "openai" }, () =>
        withGenerationDispatch({ body: { model: "main" } }, () => dispatchPhysicalFetch({}, () =>
          Response.json({ model: "main", choices: [{ message: { content: "synthetic answer" } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))));
    });
    await response.text();
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.spans).toHaveLength(2);
    expect(fixture.starts[0]).toMatchObject({ provider: "opencode", requestedModel: "jev-1.13-free", connectionId: "classifier-connection" });
    expect(fixture.starts[1]).toMatchObject({ provider: "fixture", requestedModel: "main", fallbackReason: "primary" });
    expect(fixture.finishes[0]).toMatchObject({ usage, usageComplete: true, status: "success" });
    expect(fixture.finishes[1]).toMatchObject({ usage: { prompt_tokens: 100, completion_tokens: 20 }, usageComplete: true });
    const wire = JSON.parse(fixture.fetch.mock.calls[0][1].body);
    expect(Object.keys(wire).sort()).toEqual(["model", "questions", "state"]);
    expect(wire.questions.route.type).toBe("choice");
  });

  it("rejects required policy before classifier or main generation sends", async () => {
    fixture.policy = { enabled: true, required: true, mergeMode: "append_preserve_client" };
    const main = vi.fn();
    const response = await gateway(async () => { await resolveSmartChoice(options); return main(); });
    expect(response.status).toBe(422);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(main).not.toHaveBeenCalled();
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.requests.at(-1)).toMatchObject({ finalStatus: "policy_failed", policyAppliedStatus: "failed" });
  });

  it("aborts the physical classifier on timeout instead of leaving it running", async () => {
    let wireSignal;
    fixture.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      wireSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const response = await gateway(async () => {
      expect(await resolveSmartChoice({ ...options, timeoutMs: 5 })).toBeNull();
      return Response.json({ fallback: true });
    });
    await response.text();
    expect(wireSignal.aborted).toBe(true);
    expect(fixture.finishes[0]).toMatchObject({ status: "error", usageComplete: false });
  });

  it("keeps the deadline active while reading the classifier body", async () => {
    let cancelled = false;
    fixture.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }));
    const response = await gateway(async () => {
      expect(await resolveSmartChoice({ ...options, timeoutMs: 5 })).toBeNull();
      return Response.json({ fallback: true });
    });
    await response.text();
    expect(cancelled).toBe(true);
    expect(fixture.finishes[0].usageComplete).toBe(false);
  });

  it("propagates client cancellation without starting main generation", async () => {
    const controller = new AbortController();
    let started;
    const wireStarted = new Promise(resolve => { started = resolve; });
    fixture.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); started();
    }));
    const main = vi.fn();
    const pending = gateway(async () => { await resolveSmartChoice(options); return main(); }, controller.signal);
    await wireStarted; controller.abort();
    expect((await pending).status).toBe(499);
    expect(main).not.toHaveBeenCalled();
    expect(fixture.finishes[0]).toMatchObject({ status: "cancelled", usageComplete: false });
  });

  it("keeps feature-off native classifier schema and response unchanged", async () => {
    process.env.TELE_PROXY_ENABLED = "0";
    fixture.fetch.mockResolvedValueOnce(decision());
    expect(await resolveSmartChoice(options)).toMatchObject({ choice: "fixture/main", confidence: 0.9 });
    expect(fixture.starts).toHaveLength(0);
    expect(fixture.spans).toHaveLength(0);
  });
});
