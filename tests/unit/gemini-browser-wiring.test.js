/**
 * The executor must actually USE the generation boundary, not merely report it.
 * A helper-only test passes even when this wiring is reverted, so this drives
 * the real `execute()` path with browser doubles and asserts on the route.
 */
import { describe, it, expect, vi } from "vitest";
import { withDispatchContext } from "open-sse/services/dispatchContext.js";

const dispatchSpy = vi.fn(async (_page, _signal, submit) => submit());

vi.mock("open-sse/executors/gemini-web/dispatch.js", () => ({
  GEMINI_GENERATION_PATH: /\/BardChatUi\/data\/batchexecute/,
  dispatchGeminiBrowserGeneration: (...args) => dispatchSpy(...args),
}));

const page = {
  goto: vi.fn(async () => {}),
  on: vi.fn(),
  off: vi.fn(),
  url: vi.fn(() => "https://gemini.google.com/app"),
  evaluate: vi.fn(async () => ""),
  locator: vi.fn(() => ({ count: async () => 1 })),
  waitForSelector: vi.fn(async () => ({ click: async () => {} })),
  waitForTimeout: vi.fn(async () => {}),
  keyboard: { insertText: vi.fn(async () => {}), press: vi.fn(async () => {}) },
  route: vi.fn(async () => {}),
  unroute: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};
const context = {
  addCookies: vi.fn(async () => {}),
  newPage: vi.fn(async () => page),
  close: vi.fn(async () => {}),
};
const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };

vi.mock("open-sse/executors/gemini-web/browserLease.js", () => ({
  acquireGeminiBrowser: vi.fn(async () => browser),
  releaseGeminiBrowser: vi.fn(async () => {}),
}));
vi.mock("open-sse/executors/gemini-web/domCapture.js", () => ({
  readReplyState: vi.fn(async () => ({ count: 0, lastText: "" })),
  waitForGeminiReply: vi.fn(async () => "reply"),
}));

const { GeminiWebExecutor } = await import("open-sse/executors/gemini-web.js");

describe("gemini executor wiring", () => {
  it("sends the generation through the dispatch boundary instead of typing blind", async () => {
    dispatchSpy.mockClear();
    page.keyboard.press.mockClear();
    const executor = new GeminiWebExecutor();
    // No `model`: skips UI mode selection, which needs a live page.
    const body = { messages: [{ role: "user", content: "hello" }] };

    try {
      await withDispatchContext({ execute: (_d, send) => send() }, () =>
        executor.execute({
          body,
          stream: false,
          credentials: { cookie: "__Secure-1PSID=synthetic" },
          log: () => {},
        })
      );
    } catch {
      // Downstream reply handling may fail on these doubles; only the
      // boundary call is under test.
    }

    expect(dispatchSpy).toHaveBeenCalled();
    expect(dispatchSpy.mock.calls[0][0]).toBe(page);
    // The Enter press is submitted *through* the boundary, never before it.
    expect(dispatchSpy.mock.calls[0][2]).toBeTypeOf("function");
    await dispatchSpy.mock.calls[0][2]();
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });
});
