import { afterEach, describe, it, expect, vi } from "vitest";

import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { encodeField, wrapConnectRPCFrame } from "../../open-sse/utils/cursorProtobuf.js";

const LEN = 2;

function cursorResponseFrame({ text = "", thinking = "" }) {
  const responseFields = [];

  if (text) {
    responseFields.push(encodeField(1, LEN, text));
  }

  if (thinking) {
    const thinkingMessage = encodeField(1, LEN, thinking);
    responseFields.push(encodeField(25, LEN, thinkingMessage));
  }

  const response = Buffer.concat(responseFields.map((field) => Buffer.from(field)));
  const envelope = encodeField(2, LEN, response);
  return Buffer.from(wrapConnectRPCFrame(envelope));
}

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("CursorExecutor Composer thinking-field responses", () => {
  it("uses visible content after </think> for non-streaming Composer responses", async () => {
    const executor = new CursorExecutor();
    const buffer = cursorResponseFrame({
      thinking: "private reasoning that must not leak</think>OK",
    });

    const response = executor.transformProtobufToJSON(buffer, "cu/composer-2.5", {
      messages: [{ role: "user", content: "reply OK" }],
    });
    const payload = await response.json();

    expect(payload.choices[0].message.content).toBe("OK");
    expect(JSON.stringify(payload)).not.toContain("private reasoning");
    expect(payload.usage.completion_tokens).toBeGreaterThan(0);
  });

  it("streams only visible content after </think> for Composer responses", async () => {
    const executor = new CursorExecutor();
    const buffer = Buffer.concat([
      cursorResponseFrame({ thinking: "private reasoning" }),
      cursorResponseFrame({ thinking: " that must not leak</think>O" }),
      cursorResponseFrame({ thinking: "K" }),
    ]);

    const response = executor.transformProtobufToSSE(buffer, "composer-2.5-fast", {
      messages: [{ role: "user", content: "reply OK" }],
    });
    const events = parseSSE(await response.text());
    const content = events
      .map((event) => event.choices?.[0]?.delta?.content || "")
      .join("");

    expect(content).toBe("OK");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(events.at(-1).usage.completion_tokens).toBeGreaterThan(0);
  });

  it("does not treat thinking as visible output for non-Composer models", async () => {
    const executor = new CursorExecutor();
    const buffer = cursorResponseFrame({
      thinking: "private reasoning</think>SHOULD_NOT_APPEAR",
    });

    const response = executor.transformProtobufToJSON(buffer, "gpt-5.3-codex", {
      messages: [{ role: "user", content: "hi" }],
    });
    const payload = await response.json();

    expect(payload.choices[0].message.content).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("SHOULD_NOT_APPEAR");
  });
});

describe("CursorExecutor legacy debug privacy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(["transformProtobufToJSON", "transformProtobufToSSE"])(
    "%s suppresses decoded content and error debug logs at runtime only while feature-on",
    async (consume) => {
      vi.stubEnv("CURSOR_STREAM_DEBUG", "1");
      vi.stubEnv("CURSOR_PROTOBUF_DEBUG", "0");
      vi.stubEnv("TELE_PROXY_ENABLED", "0");
      vi.resetModules();
      const { CursorExecutor: DebugCursorExecutor } = await import("../../open-sse/executors/cursor.js");
      const executor = new DebugCursorExecutor();
      const content = "CURSOR_PRIVATE_DECODED_CONTENT_SENTINEL";
      const error = "CURSOR_PRIVATE_ERROR_SNIPPET_SENTINEL";
      const buffer = Buffer.concat([
        cursorResponseFrame({ text: content }),
        Buffer.from(wrapConnectRPCFrame(Buffer.from(JSON.stringify({
          error: { message: error, code: "synthetic_failure" },
        })))),
      ]);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      // Import with telemetry off, then enable it without reloading the executor.
      for (const enabled of ["1", "0"]) {
        vi.stubEnv("TELE_PROXY_ENABLED", enabled);
        log.mockClear();
        const response = executor[consume](buffer, "gpt-4o", {
          messages: [{ role: "user", content: "synthetic request" }],
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(content);
        const captured = JSON.stringify(log.mock.calls);
        if (enabled === "1") {
          expect(captured).not.toContain(content);
          expect(captured).not.toContain(error);
        } else {
          expect(captured).toContain(content);
          expect(captured).toContain(error);
        }
      }
    },
  );
});
