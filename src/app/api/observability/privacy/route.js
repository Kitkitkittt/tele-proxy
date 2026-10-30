import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getDiagnosticConfiguration, configureProjectDiagnostics, captureProjectDiagnostic } from "@/lib/privacyDiagnostics.js";
import { isSameOriginRequest } from "@/lib/auth/requestOrigin.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function authorize(request, mutation = false) {
  if (process.env.TELE_PROXY_ENABLED !== "1") return json({ error: "Not found" }, 404);
  const store = await cookies();
  const session = await getDashboardAuthSession(store.get("auth_token")?.value);
  if (session?.authenticated !== true) return json({ error: "Unauthorized" }, 401);
  if (mutation && !isSameOriginRequest(request)) return json({ error: "Forbidden origin" }, 403);
  return null;
}
async function body(request) {
  if (Number(request.headers.get("content-length")) > 4096) { const error = new Error("Payload too large"); error.status = 413; throw error; }
  const reader = request.body?.getReader();
  if (!reader) { const error = new Error("JSON body required"); error.status = 400; throw error; }
  const decoder = new TextDecoder(); let text = ""; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); const error = new Error("Payload too large"); error.status = 413; throw error; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { const error = new Error("Invalid JSON"); error.status = 400; throw error; }
  } finally { reader.releaseLock(); }
}
function failure(error) { const status = [400, 403, 413, 503].includes(error?.status) ? error.status : 500; return json({ error: status === 500 ? "Diagnostic operation failed" : error.message }, status); }
export async function GET(request) {
  try { const denied = await authorize(request); return denied || json(await getDiagnosticConfiguration()); } catch (error) { return failure(error); }
}
export async function PUT(request) {
  try {
    const denied = await authorize(request, true); if (denied) return denied;
    const input = await body(request);
    if (!input || Object.keys(input).some((k) => !["projectId", "enabled", "retentionHours"].includes(k))) return json({ error: "Invalid configuration" }, 400);
    return json(await configureProjectDiagnostics(input.projectId, { enabled: input.enabled, retentionHours: input.retentionHours }));
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  try {
    const denied = await authorize(request, true); if (denied) return denied;
    const input = await body(request);
    if (!input || Object.keys(input).some((k) => !["projectId", "diagnostic"].includes(k))) return json({ error: "Invalid diagnostic" }, 400);
    return json(await captureProjectDiagnostic(input.projectId, input.diagnostic));
  } catch (error) { return failure(error); }
}
