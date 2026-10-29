/**
 * #5: the Gemini browser generation boundary must produce one durable attempt
 * per real generation send, and none for composer bootstrap, uploads or polls.
 * Local wire fixture — a fake page whose route handler stands in for Playwright.
 */
import { describe, it, expect, vi } from "vitest";
import { withDispatchContext } from "open-sse/services/dispatchContext.js";
import { dispatchGeminiBrowserGeneration, GEMINI_GENERATION_PATH } from "open-sse/executors/gemini-web/dispatch.js";

function routeFor(url, method) {
  return {
    request: () => ({ url: () => url, method: () => method }),
    continue: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

describe("gemini browser generation boundary", () => {
  it("counts exactly one attempt for the generation POST, not for bootstrap or polls", async () => {
    let handler;
    const execute = vi.fn((_details, send) => send());
    const page = {
      route: vi.fn(async (_pattern, cb) => { handler = cb; }),
      unroute: vi.fn(async () => {}),
    };

    await withDispatchContext({ execute }, () => dispatchGeminiBrowserGeneration(page, undefined, async () => {
      // Not generation: composer bootstrap and a non-POST read.
      await handler(routeFor("https://gemini.google.com/app", "GET"));
      // Generation: the batchexecute POST.
      const gen = routeFor("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=abc", "POST");
      await handler(gen);
      expect(gen.continue).toHaveBeenCalledOnce();
    }));

    expect(execute).toHaveBeenCalledOnce();
    const details = execute.mock.calls[0][0];
    expect(details.transport).toBe("browser-gemini");
    expect(page.unroute).toHaveBeenCalledWith(GEMINI_GENERATION_PATH, handler);
  });

  it("does not invent an attempt when the composer never submits", async () => {
    const execute = vi.fn((_details, send) => send());
    const page = { route: vi.fn(async () => {}), unroute: vi.fn(async () => {}) };
    await expect(withDispatchContext({ execute }, () =>
      dispatchGeminiBrowserGeneration(page, undefined, async () => { throw new Error("composer unavailable"); })
    )).rejects.toThrow("composer unavailable");
    expect(execute).not.toHaveBeenCalled();
    expect(page.unroute).toHaveBeenCalledOnce();
  });

  it("aborts the generation request when dispatch rejects", async () => {
    let handler;
    const page = { route: vi.fn(async (_p, cb) => { handler = cb; }), unroute: vi.fn(async () => {}) };
    const gen = routeFor("https://gemini.google.com/_/BardChatUi/data/batchexecute", "POST");
    await expect(withDispatchContext({ execute: async () => { throw new Error("ledger write failed"); } },
      () => dispatchGeminiBrowserGeneration(page, undefined, () => handler(gen))
    )).rejects.toThrow("ledger write failed");
    expect(gen.continue).not.toHaveBeenCalled();
    expect(gen.abort).toHaveBeenCalledWith("failed");
  });

  it("counts one attempt when a poll POST overlaps the generation POST", async () => {
    let handler;
    const execute = vi.fn((_details, send) => send());
    const page = { route: vi.fn(async (_p, cb) => { handler = cb; }), unroute: vi.fn(async () => {}) };

    await withDispatchContext({ execute }, () => dispatchGeminiBrowserGeneration(page, undefined, async () => {
      const send = routeFor("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=send", "POST");
      const poll = routeFor("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=poll", "POST");
      await Promise.all([handler(send), handler(poll)]);
      // Both still reach the wire; only one is accounted as a generation.
      expect(send.continue).toHaveBeenCalledOnce();
      expect(poll.continue).toHaveBeenCalledOnce();
    }));

    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed before touching the page when a policy is required", async () => {
    const page = { route: vi.fn(), unroute: vi.fn() };
    await expect(withDispatchContext({ requiredPolicy: true, execute: (_d, send) => send() },
      () => dispatchGeminiBrowserGeneration(page, undefined, async () => {})
    )).rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
    expect(page.route).not.toHaveBeenCalled();
  });
});
