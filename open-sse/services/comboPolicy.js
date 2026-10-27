import { createHash } from "node:crypto";
import { FORMATS } from "../translator/formats.js";
import { CLAUDE_BLOCK, ROLE } from "../translator/schema/index.js";

export const MAX_POLICY_TEXT_LENGTH = 32768;
export const MAX_POLICY_TOKENS = 8192;
export const DEFAULT_MAX_POLICY_TOKENS = 600;
export const COMBO_POLICY_MERGE_MODES = Object.freeze({
  OFF: "off",
  APPEND: "append_preserve_client",
});

export class ComboPolicyError extends Error {
  constructor(message, code = "COMBO_POLICY_INVALID") {
    super(message);
    this.name = "ComboPolicyError";
    this.code = code;
    this.status = 400;
  }
}

/** Byte-based estimate, not a tokenizer count or provider-reported usage. */
export function estimatePolicyTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function fail(snapshot, message, code = "COMBO_POLICY_INVALID") {
  throw new ComboPolicyError(message, snapshot?.required === true ? "COMBO_POLICY_REQUIRED" : code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate persisted snapshots, including disabled policies; never normalize text. */
export function validatePolicySnapshot(snapshot) {
  if (!isRecord(snapshot)) fail(snapshot, "Combo policy snapshot must be an object");
  if (typeof snapshot.enabled !== "boolean" || typeof snapshot.required !== "boolean") {
    fail(snapshot, "Combo policy enabled and required must be booleans");
  }
  if (!Object.values(COMBO_POLICY_MERGE_MODES).includes(snapshot.mergeMode)) {
    fail(snapshot, "Unsupported combo policy merge mode");
  }
  if (typeof snapshot.policyId !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(snapshot.policyId)) {
    fail(snapshot, "Invalid combo policy ID");
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    fail(snapshot, "Combo policy version must be a positive safe integer");
  }
  const active = snapshot.enabled && snapshot.mergeMode !== COMBO_POLICY_MERGE_MODES.OFF;
  if (typeof snapshot.text !== "string" || snapshot.text.length > MAX_POLICY_TEXT_LENGTH
    || snapshot.text.includes("\0") || (active && !snapshot.text.trim())) {
    fail(snapshot, "Combo policy text is empty, contains NUL, or exceeds its length limit");
  }
  if (!Number.isSafeInteger(snapshot.maxInjectedTokens) || snapshot.maxInjectedTokens < 1
    || snapshot.maxInjectedTokens > MAX_POLICY_TOKENS) {
    fail(snapshot, "Invalid combo policy injected-token limit");
  }
  const estimatedTokens = estimatePolicyTokens(snapshot.text);
  if (snapshot.estimatedTokens !== estimatedTokens || estimatedTokens > snapshot.maxInjectedTokens) {
    fail(snapshot, "Combo policy token estimate is inconsistent or exceeds its limit");
  }
  const hash = createHash("sha256").update(snapshot.text, "utf8").digest("hex");
  if (snapshot.hash !== hash) fail(snapshot, "Combo policy text hash does not match snapshot");
  return snapshot;
}

function requireShape(condition, snapshot, message) {
  if (!condition) fail(snapshot, message, "COMBO_POLICY_UNSUPPORTED");
}

function requireMessages(messages, snapshot, allowToolCalls = false) {
  requireShape(Array.isArray(messages) && messages.every(message => isRecord(message)
    && typeof message.role === "string"
    && (typeof message.content === "string"
      || (Array.isArray(message.content) && message.content.every(isRecord))
      || (allowToolCalls && message.role === ROLE.ASSISTANT && message.content == null
        && Array.isArray(message.tool_calls)))), snapshot, "Combo policy requires native messages");
}

function appendText(existing, text) {
  return existing ? `${existing}\n\n${text}` : text;
}

/**
 * Apply one immutable ingress snapshot to one original translated attempt body.
 * Callers must start each retry from the original: client text/markers cannot prove injection.
 */
export function applyComboPolicy(body, format, snapshot) {
  const active = snapshot != null && snapshot.enabled !== false
    && snapshot.mergeMode !== COMBO_POLICY_MERGE_MODES.OFF;
  if (active) validatePolicySnapshot(snapshot);
  let result;
  try {
    result = structuredClone(body);
  } catch {
    fail(snapshot, "Combo policy request body cannot be cloned", "COMBO_POLICY_UNSUPPORTED");
  }
  if (!active) return result;
  requireShape(isRecord(result), snapshot, "Combo policy requires a native request object");

  switch (format) {
    case FORMATS.OPENAI:
      requireMessages(result.messages, snapshot, true);
      result.messages.push({ role: ROLE.SYSTEM, content: snapshot.text });
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
      requireShape(typeof result.input === "string" || (Array.isArray(result.input)
        && result.input.every(item => isRecord(item)
          && (typeof item.type === "string" || typeof item.role === "string"))),
      snapshot, "Combo policy requires native Responses input");
      requireShape(result.instructions === undefined || typeof result.instructions === "string",
        snapshot, "Combo policy requires string Responses instructions");
      result.instructions = appendText(result.instructions, snapshot.text);
      break;
    case FORMATS.CLAUDE:
      requireMessages(result.messages, snapshot);
      if (result.system === undefined || typeof result.system === "string") {
        result.system = appendText(result.system, snapshot.text);
      } else {
        requireShape(Array.isArray(result.system) && result.system.every(block => isRecord(block)
          && block.type === CLAUDE_BLOCK.TEXT && typeof block.text === "string"),
        snapshot, "Combo policy requires text Anthropic system blocks");
        result.system.push({ type: CLAUDE_BLOCK.TEXT, text: snapshot.text });
      }
      break;
    case FORMATS.GEMINI:
      requireShape(Array.isArray(result.contents) && result.contents.every(content => isRecord(content)
        && Array.isArray(content.parts) && content.parts.every(isRecord)),
      snapshot, "Combo policy requires native Gemini contents");
      if (result.systemInstruction === undefined) {
        result.systemInstruction = { parts: [{ text: snapshot.text }] };
      } else {
        requireShape(isRecord(result.systemInstruction)
          && Array.isArray(result.systemInstruction.parts)
          && result.systemInstruction.parts.every(part => isRecord(part) && typeof part.text === "string"),
        snapshot, "Combo policy requires text Gemini systemInstruction parts");
        result.systemInstruction.parts.push({ text: snapshot.text });
      }
      break;
    default:
      fail(snapshot, `Combo policy does not support native format: ${String(format)}`, "COMBO_POLICY_UNSUPPORTED");
  }
  return result;
}
