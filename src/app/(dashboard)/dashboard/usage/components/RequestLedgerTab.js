"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";

const BASES = [
  ["providerReportedChargeMicros", "Provider-reported charge"],
  ["invoiceReconciledSpendMicros", "Invoice-reconciled spend"],
  ["meteredCostEstimateMicros", "Metered API estimate"],
  ["apiEquivalentValueMicros", "API-equivalent reference value (not spend)"],
  ["subscriptionAllocationMicros", "Subscription allocation (not marginal billing)"],
  ["localInfrastructureAllocationMicros", "Local infrastructure allocation (assumption-based)"],
];
const REQUEST_FIELDS = [
  ["requestId", "Request ID"], ["traceId", "Trace ID"],
  ["receivedAt", "Received"], ["completedAt", "Completed"],
  ["environment", "Environment"], ["authenticatedKeyId", "Authenticated key ID"],
  ["approvedProjectId", "Approved project"], ["optionalSessionId", "Session ID"],
  ["contractId", "Contract ID"],
  ["clientFamily", "Client family"], ["requestedAlias", "Requested alias"],
  ["resolvedCombo", "Resolved combo"], ["reasoningEffort", "Reasoning effort"],
  ["policyId", "Policy ID"], ["policyVersion", "Policy version"],
  ["policyHash", "Policy hash"], ["policyAppliedStatus", "Policy application"],
  ["finalStatus", "Final status"], ["attemptCount", "Attempts"],
  ["totalDurationMs", "Duration (ms)"], ["accountingCompleteness", "Accounting completeness"],
];
const ATTEMPT_FIELDS = [
  ["attemptId", "Attempt ID"], ["startedAt", "Started"], ["endedAt", "Ended"],
  ["connectionPseudonym", "Connection pseudonym"], ["contractId", "Contract ID"],
  ["errorClass", "Error class"], ["fallbackReason", "Fallback reason"],
  ["cancelState", "Cancellation"], ["billingMode", "Billing mode"],
  ["currency", "Tariff and allocation currency"],
  ["providerReportedCurrency", "Provider-reported currency"], ["referenceCurrency", "Reference currency"],
  ["priceSnapshotId", "Metered price snapshot ID"],
  ["referencePriceSnapshotId", "Reference price snapshot ID"],
  ["chargeEvidenceSource", "Charge evidence"], ["invoiceEvidenceSource", "Invoice evidence"],
  ["subscriptionEvidenceSource", "Subscription allocation evidence"],
  ["localEvidenceSource", "Local infrastructure allocation evidence"],
  ["upstreamFirstContentMs", "Upstream first content (ms)"],
  ["downstreamFirstContentMs", "Client first content (ms)"],
];
const inputClass = "h-9 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20";

function valueText(value) {
  return value === null || value === undefined || value === "" ? "Unknown" : String(value);
}

function money(micros, currency) {
  if (micros === null || micros === undefined) return "Unknown";
  return `${(micros / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${currency || "(currency unknown)"}`;
}

function timestamp(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

async function fetchLedger(params, signal) {
  const response = await fetch(`/api/usage/ledger?${params}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Ledger request failed (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid ledger response.");
  return data;
}

function LedgerTable({ caption, headings, children }) {
  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:py-3 [&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_tbody_tr]:border-t [&_tbody_tr]:border-border">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-2 text-text-muted">
          <tr>{headings.map((heading) => <th key={heading} scope="col">{heading}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Metadata({ record, fields }) {
  return (
    <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {fields.map(([key, label]) => (
        <div key={key} className="min-w-0">
          <dt className="text-text-muted">{label}</dt>
          <dd className="break-words text-text-main">{key.endsWith("At") ? timestamp(record[key]) : valueText(record[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function RequestAttempts({ request, refresh }) {
  const [state, setState] = useState({ loading: true, error: "", attempts: [] });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", attempts: [] });
    fetchLedger(new URLSearchParams({ requestId: request.requestId }), controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.enabled === false) throw new Error("The request ledger is disabled. Refresh the ledger view.");
        if (!Array.isArray(data.attempts)) throw new Error("Invalid attempt response.");
        setState({ loading: false, error: "", attempts: data.attempts });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ loading: false, error: error.message || "Unable to load attempts.", attempts: [] });
      });
    return () => controller.abort();
  }, [request.requestId, refresh]);

  return (
    <section id="ledger-request-detail" aria-labelledby="ledger-request-heading" className="flex min-w-0 flex-col gap-4">
      <h3 id="ledger-request-heading" className="font-semibold text-text-main">Selected request and upstream attempts</h3>
      <Metadata record={request} fields={REQUEST_FIELDS} />
      {state.loading && <p role="status" className="text-sm text-text-muted">Loading attempts…</p>}
      {state.error && <p role="alert" className="text-sm text-red-500">{state.error} Use Refresh to retry.</p>}
      {!state.loading && !state.error && state.attempts.length === 0 && <p className="text-sm text-text-muted">No upstream attempts recorded for this request.</p>}
      {state.attempts.length > 0 && (
        <LedgerTable caption="Upstream attempts for the selected logical request" headings={["Sequence / status", "Provider / models", "Usage provenance", "Input / output tokens", "Cache / reasoning tokens", "Cost coverage / evidence"]}>
          {state.attempts.map((attempt) => (
            <tr key={attempt.attemptId}>
              <th scope="row">{attempt.sequence}<br /><span className="font-normal">{valueText(attempt.status)}</span></th>
              <td>{valueText(attempt.provider)}<div className="break-all text-xs text-text-muted">Requested: {valueText(attempt.requestedModel)}<br />Returned: {valueText(attempt.responseModel)}</div></td>
              <td>{valueText(attempt.usageSource)}</td>
              <td className="whitespace-nowrap">Input: {valueText(attempt.inputTokens)}<br />Output: {valueText(attempt.outputTokens)}</td>
              <td className="whitespace-nowrap">Cached input: {valueText(attempt.cachedInputTokens)}<br />Cache write: {valueText(attempt.cacheWriteTokens)}<br />Reasoning: {valueText(attempt.reasoningTokens)}</td>
              <td className="min-w-72">
                <p>{valueText(attempt.costStatus)}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer py-1 text-primary">Attempt details and cost bases</summary>
                  <div className="mt-3 flex flex-col gap-4">
                    <Metadata record={attempt} fields={ATTEMPT_FIELDS} />
                    <dl className="space-y-2">
                      {BASES.map(([key, label]) => <div key={key}><dt className="text-text-muted">{label}</dt><dd>{money(attempt[key], key === "providerReportedChargeMicros" ? attempt.providerReportedCurrency : key === "apiEquivalentValueMicros" ? attempt.referenceCurrency : attempt.currency)}</dd></div>)}
                    </dl>
                    <details><summary className="cursor-pointer py-1">Allowlisted numeric usage evidence</summary><pre className="mt-2 max-w-lg overflow-auto rounded bg-surface-2 p-3 text-xs">{JSON.stringify(attempt.allowlistedRawUsage ?? {}, null, 2)}</pre></details>
                  </div>
                </details>
              </td>
            </tr>
          ))}
        </LedgerTable>
      )}
    </section>
  );
}

export default function RequestLedgerTab() {
  const [range, setRange] = useState({ from: "", to: "" });
  const [query, setQuery] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [state, setState] = useState({ loading: true, error: "", data: null });

  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, error: "", data: null });
    fetchLedger(query, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (typeof data.enabled !== "boolean" || (data.enabled && (!data.coverage || !Array.isArray(data.recentRequests) || !Array.isArray(data.totals) || !Array.isArray(data.fixedFees) || !Array.isArray(data.priceSnapshots)))) {
          throw new Error("Invalid ledger summary response.");
        }
        setState({ loading: false, error: "", data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ loading: false, error: error.message || "Unable to load the request ledger.", data: null });
      });
    return () => controller.abort();
  }, [query, refresh]);

  function applyRange(event) {
    event.preventDefault();
    const from = range.from ? new Date(range.from) : null;
    const to = range.to ? new Date(range.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to)) {
      setRangeError("Enter valid dates with From no later than To.");
      return;
    }
    const params = new URLSearchParams();
    if (from) params.set("from", from.toISOString());
    if (to) params.set("to", to.toISOString());
    setRangeError("");
    setSelectedId(null);
    setQuery(params.toString());
    setRefresh((value) => value + 1);
  }

  const data = state.data;
  const selectedRequest = data?.recentRequests?.find((request) => request.requestId === selectedId);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card padding="md">
        <h2 className="font-semibold text-text-main">Authoritative request ledger</h2>
        <p className="mt-1 text-sm text-text-muted">Logical client requests and every upstream dispatch are counted separately. Missing usage or pricing evidence is unknown, never free.</p>
        <form onSubmit={applyRange} className="mt-4 flex flex-col gap-4" aria-describedby="ledger-range-help">
          <div className="grid gap-4 sm:grid-cols-2">
            {["from", "to"].map((key) => (
              <div key={key}>
                <label htmlFor={`ledger-${key}`} className="mb-2 block text-sm font-medium text-text-main">{key === "from" ? "From" : "To"} (local time)</label>
                <input id={`ledger-${key}`} type="datetime-local" step="1" value={range[key]} onChange={(event) => setRange({ ...range, [key]: event.target.value })} className={inputClass} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? "ledger-range-error" : "ledger-range-help"} />
              </div>
            ))}
          </div>
          <p id="ledger-range-help" className="text-xs text-text-muted">Blank dates include all available history through now. Apply range updates the view; Refresh reloads the applied range. Requests use received time, attempts use dispatch time, and fixed fees use overlapping billing periods.</p>
          {rangeError && <p id="ledger-range-error" role="alert" className="text-sm text-red-500">{rangeError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={state.loading}>Apply range</Button>
            <Button type="button" variant="secondary" disabled={state.loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
          </div>
        </form>
      </Card>
      {state.loading && <p role="status" className="text-sm text-text-muted">Loading request ledger…</p>}
      {state.error && <Card padding="md"><p role="alert" className="text-sm text-red-500">{state.error} Use Refresh to retry.</p></Card>}
      {data?.enabled === false && <Card padding="md"><p role="status" className="text-sm text-text-muted">Request accounting is disabled. An administrator must enable TELE_PROXY_ENABLED=1 on the server to collect and view the ledger. Historical reference estimates are not imported as actual charges.</p></Card>}
      {data?.enabled && (
        <>
          <Card padding="md">
            <h2 className="mb-4 font-semibold text-text-main">Counts and accounting coverage</h2>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Logical requests", data.requests], ["Upstream attempts", data.attempts],
                ["Usage-known attempts", data.coverage.usageKnownAttempts], ["Usage-unknown attempts", data.coverage.usageUnknownAttempts],
                ["Cost-known attempts", data.coverage.costKnownAttempts], ["Cost-unknown attempts", data.coverage.costUnknownAttempts],
                ["Complete requests", data.coverage.requestComplete], ["Incomplete requests", data.coverage.requestIncomplete],
              ].map(([label, value]) => <div key={label}><dt className="text-sm text-text-muted">{label}</dt><dd className="text-xl font-semibold text-text-main">{valueText(value)}</dd></div>)}
            </dl>
            {data.requests === 0 && data.attempts === 0 && <p className="mt-4 text-sm text-text-muted">No request or attempt records in this range.</p>}
          </Card>
          <Card padding="md">
            <h2 className="font-semibold text-text-main">Independent monetary bases</h2>
            <p className="mb-4 mt-1 text-sm text-text-muted">Each amount sums recorded values only, not unknowns. Bases and currencies are never added together. API-equivalent value is not cash spend or guaranteed savings; allocations are not additional provider charges. Amounts retain micro-unit precision.</p>
            {data.totals.length === 0 ? <p className="text-sm text-text-muted">No monetary records in this range.</p> : (
              <LedgerTable caption="Recorded monetary totals by currency and independent basis" headings={["Currency", ...BASES.map(([, label]) => label)]}>
                {data.totals.map((total) => <tr key={total.currency ?? "unknown"}><th scope="row">{total.currency || "Unknown"}</th>{BASES.map(([key]) => <td key={key} className="whitespace-nowrap">{money(total[key], total.currency)}</td>)}</tr>)}
              </LedgerTable>
            )}
          </Card>
          <Card padding="md">
            <h2 className="mb-2 font-semibold text-text-main">Fixed billing-period fees</h2>
            <p className="mb-4 text-sm text-text-muted">Full fees for overlapping periods, not prorated or multiplied by request count. Shown separately from attempt estimates and allocations.</p>
            {data.fixedFees.length === 0 ? <p className="text-sm text-text-muted">No fixed fees recorded for this range.</p> : (
              <LedgerTable caption="Fixed fees and billing evidence" headings={["Billing mode", "Amount", "Period start", "Period end", "Evidence source"]}>
                {data.fixedFees.map((fee, index) => <tr key={fee.id ?? index}><th scope="row">{valueText(fee.billingMode)}</th><td className="whitespace-nowrap">{money(fee.amountMicros, fee.currency)}</td><td>{timestamp(fee.periodStart)}</td><td>{timestamp(fee.periodEnd)}</td><td className="break-words">{valueText(fee.evidenceSource)}</td></tr>)}
              </LedgerTable>
            )}
          </Card>
          <Card padding="md">
            <h2 className="mb-4 font-semibold text-text-main">Recent logical requests</h2>
            <p className="mb-4 text-sm text-text-muted">Newest records returned for the applied range. Select a request to inspect all its attempts, including attempts outside this range. Token cache and reasoning details may be subsets of inclusive input/output counts; do not add them again.</p>
            {data.recentRequests.length === 0 ? <p className="text-sm text-text-muted">No logical requests in this range.</p> : (
              <LedgerTable caption="Recent logical requests; select a request for upstream attempts" headings={["Request ID", "Received", "Alias / combo", "Project", "Status", "Attempts", "Accounting", "Inspect"]}>
                {data.recentRequests.map((request) => (
                  <tr key={request.requestId} className={request.requestId === selectedId ? "bg-surface-2" : ""}>
                    <th scope="row" className="max-w-56 break-all font-mono text-xs">{request.requestId}</th>
                    <td>{timestamp(request.receivedAt)}</td><td>{valueText(request.requestedAlias)}<br /><span className="text-text-muted">{valueText(request.resolvedCombo)}</span></td>
                    <td>{valueText(request.approvedProjectId)}</td><td>{valueText(request.finalStatus)}</td><td>{valueText(request.attemptCount)}</td><td>{valueText(request.accountingCompleteness)}</td>
                    <td><Button type="button" variant="secondary" size="sm" aria-label={`View attempts for request ${request.requestId}`} aria-expanded={request.requestId === selectedId} aria-controls="ledger-request-detail" onClick={() => setSelectedId(request.requestId === selectedId ? null : request.requestId)}>{request.requestId === selectedId ? "Close" : "View attempts"}</Button></td>
                  </tr>
                ))}
              </LedgerTable>
            )}
            {selectedRequest && <div className="mt-6 border-t border-border pt-6"><RequestAttempts key={selectedId} request={selectedRequest} refresh={refresh} /></div>}
          </Card>
          <Card padding="md">
            <h2 className="mb-2 font-semibold text-text-main">Price snapshots and evidence</h2>
            <p className="mb-4 text-sm text-text-muted">Latest configured immutable snapshots, independent of the selected date range. Match snapshot IDs from attempt details; missing evidence is not a zero tariff. Rates in snapshots are integer micro-units per million tokens.</p>
            {data.priceSnapshots.length === 0 ? <p className="text-sm text-text-muted">No price snapshots configured.</p> : (
              <LedgerTable caption="Configured price snapshots and source evidence" headings={["Snapshot ID", "Provider / model", "Contract", "Basis / currency", "Effective period", "Evidence / tariff"]}>
                {data.priceSnapshots.map((price) => (
                  <tr key={price.id}>
                    <th scope="row" className="max-w-56 break-all font-mono text-xs">{price.id}</th><td>{valueText(price.provider)}<br />{valueText(price.model)}</td><td className="break-all">{valueText(price.contractId)}</td><td>{valueText(price.basis)}<br />{valueText(price.currency)}</td>
                    <td>{timestamp(price.effectiveFrom)}<br />{price.effectiveTo ? timestamp(price.effectiveTo) : "No end date"}</td>
                    <td className="min-w-64 break-words">{valueText(price.evidenceSource)}<details className="mt-2"><summary className="cursor-pointer py-1 text-primary">View immutable tariff</summary><pre className="mt-2 max-w-lg overflow-auto rounded bg-surface-2 p-3 text-xs">{JSON.stringify(price.snapshot, null, 2)}</pre></details></td>
                  </tr>
                ))}
              </LedgerTable>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
