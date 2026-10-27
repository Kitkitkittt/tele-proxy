import { describe, expect, it } from "vitest";
import { estimatePolicyTokens, policyDraft, policyMutation } from "../../src/shared/components/comboPolicyEditorActions.js";

const current = {
  policyId: "combo-policy", version: 4, text: "Saved instructions", hash: "saved-hash",
  enabled: true, required: false, mergeMode: "append_preserve_client", maxInjectedTokens: 600, estimatedTokens: 5,
};

describe("combo policy editor actions", () => {

  it("uses optimistic concurrency for first save and the currently selected version after rollback", () => {
    const firstDraft = { ...policyDraft(current), policyId: "new-policy" };
    expect(policyMutation(null, firstDraft).expectedVersion).toBeNull();
    expect(policyMutation(current, policyDraft(current)).expectedVersion).toBe(current.version);

    // Selecting history must never publish an unsaved draft or copy policy text into a rollback operation.
    const draft = { ...policyDraft(current), text: "Unsaved local draft" };
    expect(policyMutation(current, draft, { selectVersion: 2 })).toEqual({ selectVersion: 2, expectedVersion: 4 });
    const selected = { ...current, version: 2 };
    expect(policyMutation(selected, draft).expectedVersion).toBe(2);
    expect(current.version).toBe(4);
    expect(draft.text).toBe("Unsaved local draft");
  });

  it("disables saved policy without accidentally saving the unsaved draft", () => {
    const body = policyMutation(current, { ...policyDraft(current), text: "Do not save this" }, { disable: true });
    expect(body).toEqual({ ...policyDraft(current), enabled: false, expectedVersion: 4 });
    expect(current.enabled).toBe(true);
  });

  it("rejects invalid local input before mutation", () => {
    const draft = policyDraft(current);
    for (const patch of [
      { policyId: "bad id" }, { policyId: "x".repeat(81) }, { text: "\0" }, { text: "x".repeat(32769) },
      { maxInjectedTokens: 0 }, { maxInjectedTokens: 8193 }, { maxInjectedTokens: 2.5 },
      { mergeMode: "replace_client" }, { text: " " }, { text: "12345", maxInjectedTokens: 1 },
    ]) expect(() => policyMutation(current, { ...draft, ...patch })).toThrow();
    expect(() => policyMutation(current, draft, { selectVersion: 0 })).toThrow();
    expect(estimatePolicyTokens("ééé")).toBe(2);
    expect(() => policyMutation(current, { ...draft, enabled: false, text: "", mergeMode: "off" })).not.toThrow();
  });

});
