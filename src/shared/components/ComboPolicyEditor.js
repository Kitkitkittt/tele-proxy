"use client";

import { useId, useState } from "react";
import Button from "./Button";
import { estimatePolicyTokens, policyDraft, policyMutation, requestComboPolicy } from "./comboPolicyEditorActions";

export default function ComboPolicyEditor({ comboId }) {
  const id = useId();
  const [details, setDetails] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedVersion, setSelectedVersion] = useState("");
  const unavailable = details?.featureEnabled === false;
  const policy = details?.policy;
  const fieldClass = "w-full rounded border border-border bg-surface-1 px-2 py-1.5 text-sm text-text-main focus:outline-primary";
  const change = (field, value) => { setDraft((current) => ({ ...current, [field]: value })); setNotice(""); };

  const applyDetails = (data) => {
    setDetails(data);
    setDraft(data.featureEnabled ? policyDraft(data.policy) : null);
    setSelectedVersion("");
  };

  const load = async () => {
    setBusy("load");
    setError("");
    setNotice("");
    try {
      applyDetails(await requestComboPolicy(comboId));
    } catch (err) {
      setError(err.message || "Could not load policy details.");
    } finally {
      setBusy("");
    }
  };

  const mutate = async (action) => {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const body = policyMutation(policy, draft, action === "rollback"
        ? { selectVersion: Number(selectedVersion) } : { disable: action === "disable" });
      const data = await requestComboPolicy(comboId, body);
      applyDetails(data);
      if (data.featureEnabled) setNotice(action === "rollback" ? "Selected immutable policy version restored." : action === "disable" ? "Policy disabled." : "Policy saved as an immutable version.");
    } catch (err) {
      setError(err.message || "Could not save policy. Your draft is kept.");
    } finally {
      setBusy("");
    }
  };

  const history = details?.history || [];
  const selected = history.find((entry) => entry.version === Number(selectedVersion));

  return (
    <section className="border-t border-border pt-3 flex flex-col gap-3" aria-labelledby={`${id}-heading`} aria-busy={!!busy}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${id}-heading`} className="text-sm font-medium">Combo policy</h3>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={!!busy} aria-expanded={!!details} aria-controls={`${id}-details`}>
          {busy === "load" ? "Loading policy..." : details ? "Reload policy details" : "Policy details"}
        </Button>
      </div>
      <p className="text-xs text-text-muted">Policy saves are separate from combo changes. Details load only on request; reload discards unsaved policy edits.</p>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <p role="status" aria-live="polite" className="text-xs text-text-muted">{notice || (busy && busy !== "load" ? "Saving policy..." : "")}</p>
      <div id={`${id}-details`}>
        {unavailable && <p className="text-xs text-text-muted">Policy editing is unavailable. This combo keeps its existing behavior.</p>}
        {draft && !unavailable && (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt>Version</dt><dd>{policy?.version ?? "Not configured"}</dd>
              <dt>Policy hash</dt><dd className="font-mono break-all">{policy?.hash || "None"}</dd>
              <dt>Saved estimate</dt><dd>{policy?.estimatedTokens ?? 0} tokens</dd>
              <dt>Saved token cap</dt><dd>{policy?.maxInjectedTokens ?? 600} tokens</dd>
            </dl>
            <fieldset disabled={!!busy} className="flex flex-col gap-3 disabled:opacity-60">
              <legend className="sr-only">Edit combo policy</legend>
              <label className="text-xs font-medium" htmlFor={`${id}-policy-id`}>
                Policy ID
                <input id={`${id}-policy-id`} className={`${fieldClass} mt-1 font-mono`} value={draft.policyId} readOnly={!!policy} maxLength={80}
                  onChange={(e) => change("policyId", e.target.value)} aria-describedby={`${id}-id-help`} />
              </label>
              <p id={`${id}-id-help`} className="text-xs text-text-muted">1–80 letters, numbers, dots, underscores or hyphens. Existing policy identity cannot change.</p>
              <label className="text-xs font-medium" htmlFor={`${id}-text`}>
                Policy text
                <textarea id={`${id}-text`} className={`${fieldClass} mt-1 min-h-32 font-mono`} value={draft.text} maxLength={32768} rows={6}
                  onChange={(e) => change("text", e.target.value)} aria-describedby={`${id}-text-help`} spellCheck={false} />
              </label>
              <p id={`${id}-text-help`} className="text-xs text-text-muted">Admin configuration, not request telemetry. Draft estimate: {estimatePolicyTokens(draft.text)} tokens (UTF-8 bytes / 4, rounded up). Maximum 32768 characters.</p>
              <div className="flex flex-wrap gap-4 text-xs">
                <label className="inline-flex min-h-6 items-center gap-2"><input type="checkbox" checked={draft.enabled} onChange={(e) => change("enabled", e.target.checked)} />Enabled</label>
                <label className="inline-flex min-h-6 items-center gap-2"><input type="checkbox" checked={draft.required} onChange={(e) => change("required", e.target.checked)} />Required</label>
              </div>
              <label className="text-xs font-medium" htmlFor={`${id}-merge`}>
                Merge mode
                <select id={`${id}-merge`} className={`${fieldClass} mt-1`} value={draft.mergeMode} onChange={(e) => change("mergeMode", e.target.value)}>
                  <option value="off">Off — do not inject</option>
                  <option value="append_preserve_client">Append policy, preserve client instructions</option>
                </select>
              </label>
              <label className="text-xs font-medium" htmlFor={`${id}-cap`}>
                Maximum injected tokens
                <input id={`${id}-cap`} className={`${fieldClass} mt-1`} type="number" min={1} max={8192} step={1} value={draft.maxInjectedTokens}
                  onChange={(e) => change("maxInjectedTokens", e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => mutate("save")}>{busy === "save" ? "Saving policy..." : "Save policy"}</Button>
                <Button type="button" size="sm" variant="outline" disabled={!policy?.enabled} onClick={() => mutate("disable")}>Disable saved policy</Button>
              </div>
            </fieldset>
            <div className="rounded border border-border p-2 text-xs">
              <h4 className="font-medium">Redacted saved preview</h4>
              <p className="font-mono mt-1">[policy content omitted]</p>
              <p className="mt-1 break-all">Hash: {details.preview?.hash || policy?.hash || "None"}</p>
              <p>Estimated tokens: {details.preview?.estimatedTokens ?? policy?.estimatedTokens ?? 0}</p>
            </div>
            <div className="flex flex-col gap-2 text-xs">
              <label htmlFor={`${id}-history`} className="font-medium">Immutable version history</label>
              <select id={`${id}-history`} className={fieldClass} disabled={!!busy || !history.length} value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)}>
                <option value="">Select a version to restore</option>
                {history.map((entry) => <option key={entry.version} value={entry.version}>Version {entry.version}{entry.version === policy?.version ? " (current)" : ""} — {entry.hash}</option>)}
              </select>
              {!history.length && <p className="text-text-muted">No saved versions.</p>}
              {selected && <p className="text-text-muted break-all">Version {selected.version} · Hash: {selected.hash} · Estimated tokens: {selected.estimatedTokens ?? "unknown"}. Historical text stays redacted until restored.</p>}
              <p className="text-text-muted">Restore selects an existing immutable version, including its enabled and required settings, and replaces any unsaved draft.</p>
              <Button type="button" size="sm" variant="outline" disabled={!!busy || !selected || selected.version === policy?.version} onClick={() => mutate("rollback")}>Restore selected version</Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
