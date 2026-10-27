import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { isSameOriginRequest } from "@/lib/auth/requestOrigin";
import { getComboPolicyState, saveComboPolicy, policiesEnabled } from "@/lib/comboPolicy";

export const runtime = "nodejs";
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function authorize(request, mutation = false) {
  // Policy administration always requires a real dashboard session, even when public dashboard viewing is enabled.
  const store = await cookies();
  const session = await getDashboardAuthSession(store.get("auth_token")?.value);
  if (session?.authenticated !== true) return json({ error: "Unauthorized" }, 401);
  if (mutation && !isSameOriginRequest(request)) return json({ error: "Forbidden origin" }, 403);
  if (!policiesEnabled()) return json({ error: "Combo policies disabled" }, 404);
  return null;
}

function failure(error) {
  const status = [400, 404, 409].includes(error?.status) ? error.status : 500;
  return json({ error: status === 500 ? "Policy operation failed" : error.message }, status);
}

export async function GET(request, { params }) {
  try {
    const denied = await authorize(request);
    if (denied) return denied;
    const { id } = await params;
    return json(await getComboPolicyState(id));
  } catch (error) { return failure(error); }
}

export async function PUT(request, { params }) {
  try {
    const denied = await authorize(request, true);
    if (denied) return denied;
    // Bound the admin configuration payload; no request or policy content is logged.
    if (Number(request.headers.get("content-length")) > 200000) return json({ error: "Policy payload too large" }, 413);
    const text = await request.text();
    if (text.length > 200000) return json({ error: "Policy payload too large" }, 413);
    let fields;
    try { fields = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    const { id } = await params;
    return json(await saveComboPolicy(id, fields));
  } catch (error) { return failure(error); }
}
