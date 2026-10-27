import { describe, expect, it, vi } from "vitest";
import { withDispatchContext } from "../../open-sse/services/dispatchContext.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", async () => {
  const { dispatchPhysicalFetch } = await import("../../open-sse/services/dispatchContext.js");
  return { proxyAwareFetch: (...args) => dispatchPhysicalFetch({ transport: "http-direct" }, () => fetchMock(...args)) };
});
import TraeExecutor from "../../open-sse/executors/trae.js";
import traeProvider from "../../open-sse/providers/registry/trae.js";

function executorFixture() {
  const executor = new TraeExecutor();
  // Trae is intentionally hidden from the live registry; exercise its real transport explicitly.
  executor.config = traeProvider.transport;
  return executor;
}

const context = (events, requiredPolicy = false) => ({
  requiredPolicy, execute: async (details, send) => { events.push(details); return send(); },
});

describe("Trae native generation boundary", () => {
  it("counts initial submitted session once and excludes subsequent event polling", async () => {
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { chat_session_id: "s", message_id: "m" } })))
      .mockResolvedValueOnce(new Response('event: done\ndata: {}\n\n'));
    const events = [];
    const executor = executorFixture();
    await withDispatchContext(context(events), async () => {
      await executor.createSession({}, "user prompt", "model", {});
      await executor.streamEvents({}, "s", "m", () => true);
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "trae", model: "model" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects required trusted policy before flattening or sending", async () => {
    fetchMock.mockReset();
    const events = [];
    await expect(withDispatchContext(context(events, true), () => executorFixture().execute({
      model: "model", body: { messages: [{ role: "system", content: "trusted policy" }] }, credentials: {},
    }))).rejects.toMatchObject({ name: "RequiredPolicyError", code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
