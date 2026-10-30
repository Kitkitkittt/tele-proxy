import { describe, it, expect, vi } from "vitest";
import { withDispatchContext } from "open-sse/services/dispatchContext.js";

vi.mock("open-sse/executors/chatgpt-web/firstParty.js", () => ({
  FIRST_PARTY_BRIDGE_KEY: "test-bridge",
  ensureFirstPartyBridge: vi.fn(),
}));

const { generateChatGptWebImage } = await import("open-sse/executors/chatgpt-web/imageGen.js");
const { GeminiWebExecutor } = await import("open-sse/executors/gemini-web.js");
const { MuseWebExecutor } = await import("open-sse/executors/muse-web.js");
const { dispatchChatGptBrowserGeneration } = await import("open-sse/executors/chatgpt-web/dispatch.js");

function requiredPolicy(callback) {
  return withDispatchContext({ requiredPolicy: true, execute: (_details, send) => send() }, callback);
}

describe("native browser generation dispatch", () => {
  it("dispatches actual conversation POSTs only and unregisters after submit", async () => {
    let handler;
    let matcher;
    const continued = vi.fn(async () => {});
    const page = {
      route: vi.fn(async (pattern, callback) => { matcher = pattern; handler = callback; }),
      unroute: vi.fn(async () => {}),
    };
    const execute = vi.fn((_details, send) => send());
    await withDispatchContext({ execute }, () => dispatchChatGptBrowserGeneration(page, undefined, async () => {
      expect(matcher.test("https://chatgpt.com/backend-api/f/conversation")).toBe(true);
      for (const path of ["/backend-api/f/conversation/prepare", "/backend-api/files", "/api/auth/session", "/backend-api/conversation/id", "/backend-api/files/id/download"]) {
        expect(matcher.test(`https://chatgpt.com${path}`)).toBe(false);
      }
      await handler({ request: () => ({ method: () => "GET" }), continue: continued });
      expect(execute).not.toHaveBeenCalled();
      await handler({ request: () => ({ method: () => "POST" }), continue: continued });
      await handler({ request: () => ({ method: () => "POST" }), continue: continued });
    }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(continued).toHaveBeenCalledTimes(3);
    expect(page.unroute).toHaveBeenCalledWith(matcher, handler);
  });

  it("does not invent a send when browser submit fails before any request", async () => {
    const execute = vi.fn((_details, send) => send());
    const page = { route: vi.fn(async () => {}), unroute: vi.fn(async () => {}) };
    await expect(withDispatchContext({ execute }, () => dispatchChatGptBrowserGeneration(page, undefined, async () => {
      throw new Error("composer unavailable");
    }))).rejects.toThrow("composer unavailable");
    expect(execute).not.toHaveBeenCalled();
    expect(page.unroute).toHaveBeenCalledOnce();
  });
  it("aborts the intercepted request when dispatch rejects", async () => {
    let handler;
    const continued = vi.fn(async () => {});
    const abort = vi.fn(async () => {});
    const page = {
      route: vi.fn(async (_pattern, callback) => { handler = callback; }),
      unroute: vi.fn(async () => {}),
    };
    await expect(withDispatchContext({ execute: async () => { throw new Error("dispatch rejected"); } },
      () => dispatchChatGptBrowserGeneration(page, undefined, async () => {
        await handler({ request: () => ({ method: () => "POST" }), continue: continued, abort });
      }))).rejects.toThrow("dispatch rejected");
    expect(continued).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("failed");
    expect(page.unroute).toHaveBeenCalledOnce();
  });



  it("rejects required policy before ChatGPT image bootstrap", async () => {
    const page = { evaluate: vi.fn() };
    await expect(requiredPolicy(() => generateChatGptWebImage(page, { prompt: "draw" })))
      .rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
    expect(page.evaluate).not.toHaveBeenCalled();
  });


  for (const Executor of [GeminiWebExecutor, MuseWebExecutor]) {
    it(`${Executor.name} rejects required policy before chat or media browser interaction`, async () => {
      const executor = new Executor();
      await expect(requiredPolicy(() => executor.execute({
        body: { messages: [{ role: "system", content: "trusted policy" }, { role: "user", content: "hello" }] },
        credentials: {},
      }))).rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
      await expect(requiredPolicy(() => executor.generateMedia({ prompt: "draw", credentials: {} })))
        .rejects.toMatchObject({ code: "REQUIRED_POLICY_UNSUPPORTED", status: 422 });
    });
  }
});
