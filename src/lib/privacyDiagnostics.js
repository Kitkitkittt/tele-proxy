import { getSettings, updateSettings } from "./db/repos/settingsRepo.js";

const projectId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const allowedEvents = new Set(["request", "attempt", "policy", "stream", "export"]);
const allowedOutcomes = new Set(["success", "error", "cancelled", "incomplete", "unknown"]);
const key = "teleProxyDiagnostics";
let pending = 0;
let chain = Promise.resolve();
function fail(message) { const error = new Error(message); error.status = 400; throw error; }
export function sanitizeDiagnostic(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Invalid diagnostic");
  const allowed = new Set(["event", "outcome", "durationMs", "inputTokens", "outputTokens", "upstreamFirstContentMs", "clientFirstContentMs"]);
  if (Object.keys(input).some((name) => !allowed.has(name))) fail("Only allowlisted metadata is accepted; content capture is prohibited");
  if (!allowedEvents.has(input.event) || !allowedOutcomes.has(input.outcome)) fail("Invalid diagnostic event or outcome");
  const record = { event: input.event, outcome: input.outcome };
  for (const name of [...allowed].slice(2)) {
    if (input[name] === undefined) continue;
    if (typeof input[name] !== "number" || !Number.isFinite(input[name]) || input[name] < 0 || input[name] > 1e12) fail("Invalid diagnostic measurement");
    record[name] = input[name];
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 1024) fail("Diagnostic too large");
  return record;
}
function prune(value) {
  const now = Date.now(); const projects = {};
  for (const [id, entry] of Object.entries(value?.projects || {}).slice(0, 32)) {
    if (!projectId(id)) continue;
    const retentionHours = Number.isInteger(entry.retentionHours) && entry.retentionHours >= 1 && entry.retentionHours <= 24 ? entry.retentionHours : 24;
    const enabled = entry.enabled === true && Number.isFinite(entry.expiresAt) && entry.expiresAt > now && entry.expiresAt <= now + retentionHours * 3600000;
    projects[id] = { enabled, expiresAt: enabled ? entry.expiresAt : null, retentionHours, records: (Array.isArray(entry.records) ? entry.records : []).filter((r) => Number.isFinite(r.capturedAt) && r.capturedAt > now - retentionHours * 3600000).slice(-100) };
  }
  return { mode: "metadata_only", projects };
}
function serialized(callback) {
  if (pending >= 32) { const error = new Error("Diagnostic queue full"); error.status = 503; return Promise.reject(error); }
  pending++;
  const result = chain.then(callback);
  chain = result.catch(() => {}).finally(() => { pending--; });
  return result;
}
export async function getDiagnosticConfiguration() {
  return serialized(async () => {
    const settings = await getSettings(); const next = prune(settings[key]);
    await updateSettings({ [key]: next });
    return next;
  });
}
export async function configureProjectDiagnostics(id, input) {
  if (!projectId(id) || !input || typeof input.enabled !== "boolean" || !Number.isInteger(input.retentionHours) || input.retentionHours < 1 || input.retentionHours > 24 || Object.keys(input).some((k) => !["enabled", "retentionHours"].includes(k))) fail("Invalid project diagnostic configuration");
  return serialized(async () => {
    const settings = await getSettings(); const next = prune(settings[key]);
    if (!next.projects[id] && Object.keys(next.projects).length >= 32) fail("Diagnostic project limit reached");
    next.projects[id] = { enabled: input.enabled, expiresAt: input.enabled ? Date.now() + input.retentionHours * 3600000 : null, retentionHours: input.retentionHours, records: input.enabled ? (next.projects[id]?.records || []) : [] };
    await updateSettings({ [key]: next });
    return next.projects[id];
  });
}
export async function captureProjectDiagnostic(id, input, requestId) {
  if (!projectId(id)) fail("Invalid project");
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId))) fail("Invalid request ID");
  const record = sanitizeDiagnostic(input);
  if (requestId !== undefined) record.requestId = requestId;
  return serialized(async () => {
    const settings = await getSettings(); const next = prune(settings[key]); const project = next.projects[id];
    if (!project?.enabled) { const error = new Error("Project diagnostics are not enabled"); error.status = 403; throw error; }
    project.records.push({ ...record, capturedAt: Date.now() }); project.records = project.records.slice(-100);
    await updateSettings({ [key]: next });
    return { captured: true, mode: "metadata_only" };
  });
}
// Retention also runs while idle; disabled projects erase their diagnostic records.
if (process.env.TELE_PROXY_ENABLED === "1") {
  const timer = setInterval(() => { void getDiagnosticConfiguration().catch(() => {}); }, 60000);
  timer.unref?.();
}
