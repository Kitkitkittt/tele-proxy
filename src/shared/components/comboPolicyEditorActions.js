const POLICY_ID = /^[a-zA-Z0-9._-]{1,80}$/;

export function policyDraft(policy) {
  return {
    policyId: policy?.policyId || "",
    text: policy?.text || "",
    enabled: policy?.enabled ?? false,
    required: policy?.required ?? false,
    mergeMode: policy?.mergeMode || "append_preserve_client",
    maxInjectedTokens: policy?.maxInjectedTokens ?? 600,
  };
}

export function estimatePolicyTokens(text) {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

// Both saves and history selection compare against the currently selected version.
export function policyMutation(policy, draft, { selectVersion, disable = false } = {}) {
  const expectedVersion = policy?.version ?? null;
  if (selectVersion !== undefined) {
    if (!Number.isInteger(selectVersion) || selectVersion < 1) throw new Error("Select a valid policy version.");
    return { selectVersion, expectedVersion };
  }
  const values = disable ? { ...policyDraft(policy), enabled: false } : draft;
  if (!POLICY_ID.test(values.policyId)) throw new Error("Policy ID must be 1–80 letters, numbers, dots, underscores or hyphens.");
  if (values.text.length > 32768 || values.text.includes("\0")) throw new Error("Policy text must be at most 32768 characters and contain no NUL characters.");
  const maxInjectedTokens = Number(values.maxInjectedTokens);
  if (!Number.isInteger(maxInjectedTokens) || maxInjectedTokens < 1 || maxInjectedTokens > 8192) throw new Error("Token cap must be a whole number from 1 to 8192.");
  if (!["off", "append_preserve_client"].includes(values.mergeMode)) throw new Error("Select a valid merge mode.");
  if (values.enabled && !values.text.trim()) throw new Error("An enabled policy needs text.");
  if (values.enabled && estimatePolicyTokens(values.text) > maxInjectedTokens) throw new Error("Policy text exceeds the token cap. Shorten it or raise the cap before enabling.");
  return { ...values, maxInjectedTokens, expectedVersion };
}

export async function requestComboPolicy(comboId, body, fetcher = fetch) {
  const response = await fetcher(`/api/combos/${encodeURIComponent(comboId)}/policy`, {
    method: body === undefined ? "GET" : "PUT",
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 404) return { featureEnabled: false };
  if (!response.ok) {
    // Never echo server text: it may contain submitted policy content.
    if (response.status === 409) throw new Error("Policy changed elsewhere. Reload details before saving; your draft is kept until reload.");
    if (response.status === 401 || response.status === 403) throw new Error("Your session cannot edit policies. Sign in again and retry.");
    throw new Error(`Policy request failed (${response.status}). Retry without closing the editor.`);
  }
  const data = await response.json();
  if (data.featureEnabled !== true || !("policy" in data)) throw new Error("The server returned invalid policy details. Retry loading.");
  return data;
}
