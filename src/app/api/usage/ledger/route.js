import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { isSameOriginRequest } from "@/lib/auth/requestOrigin";
import { getLedgerSummary, getLedgerTokenViews, getRequestAttempts, addTariff, setKeyAttribution, addFixedFee, reconcileAttempt, pruneLedger } from "@/lib/requestLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorized() {
  const store = await cookies();
  return verifyDashboardAuthToken(store.get("auth_token")?.value);
}
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  if (!(await authorized())) return json({ error: "Unauthorized" }, 401);
  if (process.env.TELE_PROXY_ENABLED !== "1") return json({ enabled: false });
  const params = new URL(request.url).searchParams;
  const requestId = params.get("requestId");
  try {
    if (requestId) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return json({ error: "Invalid request ID" }, 400);
      return json({ attempts: await getRequestAttempts(requestId) });
    }
    const options = {};
    if (params.has("from")) options.from = params.get("from");
    if (params.has("to")) options.to = params.get("to");
    if (params.has("limit")) options.limit = Number(params.get("limit"));
    return json(await (params.get("view") === "token-views" ? getLedgerTokenViews(options) : getLedgerSummary(options)));
  } catch (error) {
    if (error.message === "Invalid ledger time range") return json({ error: error.message }, 400);
    return json({ error: "Ledger storage unavailable" }, 503);
  }
}

export async function POST(request) {
  if (!(await authorized())) return json({ error: "Unauthorized" }, 401);
  if (process.env.TELE_PROXY_ENABLED !== "1") return json({ error: "Ledger is disabled" }, 404);
  if (!isSameOriginRequest(request)) return json({ error: "Forbidden origin" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Expected application/json" }, 415);
  if (Number(request.headers.get("content-length")) > 16384) return json({ error: "Configuration is too large" }, 413);
  let body;
  try {
    const input = await request.text();
    if (input.length > 16384) return json({ error: "Configuration is too large" }, 413);
    body = JSON.parse(input);
    if (!body || Array.isArray(body) || typeof body !== "object") return json({ error: "Expected a configuration object" }, 400);
  } catch { return json({ error: "Invalid JSON" }, 400); }
  try {
    switch (body.action) {
      case "tariff": return json(await addTariff(body), 201);
      case "attribution": return json(await setKeyAttribution(body));
      case "fixed_fee": return json(await addFixedFee(body), 201);
      case "reconcile": return json(await reconcileAttempt(body.attemptId, body));
      case "retention": return json(await pruneLedger({ retentionDays: body.retentionDays }));
      default: return json({ error: "Unknown ledger configuration action" }, 400);
    }
  } catch (error) {
    // Validation errors are bounded application messages; raw driver errors may contain values.
    const allowed = /^(Tariff |Attribution |Fixed fee |Reconciliation |Ledger retention )/.test(error.message);
    return json({ error: allowed ? error.message : "Ledger configuration rejected" }, allowed ? 400 : 409);
  }
}
