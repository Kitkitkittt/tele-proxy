import { describe, it, expect } from "vitest";
import {
  withDispatchContext, withDispatchMetadata, withGenerationDispatch,
  dispatchGeneration, dispatchPhysicalFetch, assertNativePolicySupported, getDispatchContext, bindDispatchContext, reportUnsupportedDispatch,
} from "../../open-sse/services/dispatchContext.js";

function observer(events, extra = {}) {
  return { ...extra, execute: async (details, send) => {
    events.push(details);
    return send();
  } };
}

describe("physical dispatch context", () => {
  it("shares dispatch metadata across module instances without crossing concurrent requests", async () => {
    vi.resetModules();
    const otherBundle = await import("../../open-sse/services/dispatchContext.js");
    const events = [];
    await Promise.all(["a", "b"].map((executionId) =>
      withDispatchContext(observer(events), () => withDispatchMetadata({ executionId }, async () => {
        await Promise.resolve();
        return otherBundle.dispatchGeneration({ transport: "native" }, () => new Response(executionId));
      }))));
    expect(events.map(({ executionId }) => executionId).sort()).toEqual(["a", "b"]);
  });

  it("preserves standalone executor behavior and does not classify metadata-only calls", async () => {
    const response = new Response("ok");
    expect(await dispatchGeneration({}, () => response)).toBe(response);
    const events = [];
    await withDispatchContext(observer(events), () => withDispatchMetadata({ provider: "p" }, () =>
      dispatchPhysicalFetch({ transport: "http-direct" }, () => response)));
    expect(events).toEqual([]);
    expect(getDispatchContext()).toBeNull();
  });

  it("counts each retry separately without counting nested direct fetch hooks", async () => {
    const events = [];
    await withDispatchContext(observer(events), () => withGenerationDispatch({ provider: "p", model: "m" }, async () => {
      await expect(dispatchPhysicalFetch({ transport: "http-proxy" }, () => {
        throw new Error("proxy failed");
      })).rejects.toThrow("proxy failed");
      return dispatchPhysicalFetch({ transport: "http-direct" }, () =>
        dispatchGeneration({ transport: "nested-native" }, () => new Response("ok")));
    }));
    expect(events.map(({ transport }) => transport)).toEqual(["http-proxy", "http-direct"]);
    expect(events.every(({ provider, model }) => provider === "p" && model === "m")).toBe(true);
  });

  it("keeps concurrent requests and selected account metadata isolated", async () => {
    const events = [];
    await Promise.all(["one", "two"].map((connectionId) =>
      withDispatchContext(observer(events), () => withDispatchMetadata({ connectionId }, async () => {
        await Promise.resolve();
        return withGenerationDispatch({ model: connectionId }, () =>
          dispatchPhysicalFetch({ transport: "http-direct" }, () => new Response("ok")));
      }))));
    expect(events.map(({ connectionId, model }) => [connectionId, model]).sort()).toEqual([
      ["one", "one"], ["two", "two"],
    ]);
  });

  it("does not classify observer side effects or later auth/poll as generation", async () => {
    const events = [];
    let observerFetches = 0;
    const context = { execute: async (details, send) => {
      events.push(details);
      await dispatchPhysicalFetch({}, () => { observerFetches++; });
      return send();
    } };
    await withDispatchContext(context, async () => {
      await withGenerationDispatch({}, () => dispatchPhysicalFetch({}, () => new Response("ok")));
      await dispatchPhysicalFetch({}, () => new Response("auth"));
    });
    expect(events).toHaveLength(1);
    expect(observerFetches).toBe(1);
  });

  it("rejects unsupported required policy before any native send", () => {
    let sends = 0;
    const context = observer([], { requiredPolicy: true });
    expect(() => withDispatchContext(context, () => dispatchGeneration({ policySupported: false }, () => sends++)))
      .toThrow("Required policy is not supported by this provider transport");
    expect(sends).toBe(0);
    expect(() => withDispatchContext(context, () => assertNativePolicySupported({ policySupported: true }))).not.toThrow();
  });

  it("reads required policy freshly for fallback dispatches", async () => {
    let required = false;
    const events = [];
    const context = observer(events);
    Object.defineProperty(context, "requiredPolicy", { get: () => required });
    await withDispatchContext(context, async () => {
      await dispatchGeneration({ policySupported: false }, () => new Response("optional"));
      required = true;
      expect(() => dispatchGeneration({ policySupported: false }, () => new Response("forbidden")))
        .toThrow("Required policy");
    });
    expect(events).toHaveLength(1);
  });

  it("does not dispatch an already cancelled inference", () => {
    const controller = new AbortController();
    controller.abort();
    const events = [];
    expect(() => withDispatchContext(observer(events), () =>
      dispatchGeneration({ signal: controller.signal }, () => new Response("forbidden")))).toThrow();
    expect(events).toHaveLength(0);
  });

  it("hands live streams and native opaque results through without reading or cloning", async () => {
    let pulls = 0;
    const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
    const response = new Response(body);
    const opaque = { reader: "native", usage: undefined };
    await withDispatchContext(observer([]), async () => {
      expect(await dispatchGeneration({}, () => response)).toBe(response);
      expect(await dispatchGeneration({}, () => ({ response }))).toEqual({ response });
      expect(await dispatchGeneration({}, () => opaque)).toBe(opaque);
    });
    expect(pulls).toBe(0);
    expect(response.bodyUsed).toBe(false);
  });

  it("binds browser protocol callbacks to their originating request", async () => {
    const events = [];
    const callback = withDispatchContext(observer(events), () => withDispatchMetadata({ executionId: "browser-one" }, () =>
      bindDispatchContext(() => dispatchGeneration({ transport: "browser-test" }, () => undefined))));
    await withDispatchContext(observer([]), () => callback());
    expect(events).toEqual([expect.objectContaining({ executionId: "browser-one", transport: "browser-test" })]);
    expect(getDispatchContext()).toBeNull();
  });

  it("reports uncertain native submissions without fabricating dispatch attempts", () => {
    const events = [];
    const unsupported = [];
    withDispatchContext(observer(events, { markDispatchUnsupported: (details) => unsupported.push(details) }), () =>
      withDispatchMetadata({ executionId: "native-one" }, () => reportUnsupportedDispatch({ transport: "browser-test" })));
    expect(events).toEqual([]);
    expect(unsupported).toEqual([{ executionId: "native-one", transport: "browser-test" }]);
    expect(() => withDispatchContext(observer(events, { markDispatchUnsupported() { throw new Error("sink unavailable"); } }), () =>
      reportUnsupportedDispatch({ transport: "browser-test" }))).not.toThrow();
  });
});
