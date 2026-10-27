// Explicit opt-in only: never default to live credentials or production routing.
const baseUrl = process.env.TEST_BASE_URL;
const apiKey = process.env.TEST_API_KEY;
const combo = process.env.TEST_COMBO;
if (!baseUrl || !apiKey || !combo) {
  throw new Error("Set TEST_BASE_URL, TEST_API_KEY and TEST_COMBO for an authorized test target");
}
const url = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  throw new Error("This smoke command accepts loopback targets only");
}
const response = await fetch(new URL("chat/completions", `${baseUrl.replace(/\/$/, "")}/`), {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify({ model: combo, messages: [{ role: "user", content: "Reply with OK" }], stream: false }),
  signal: AbortSignal.timeout(30_000),
});
console.log(JSON.stringify({ status: response.status, ok: response.ok }));
if (!response.ok) process.exitCode = 1;
