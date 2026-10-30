import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { getModelStrip, getModelSupportedFormats, getModelType, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { FORMATS } from "../translator/formats.js";
import { getDispatchContext } from "./dispatchContext.js";

const POLICY_CODES = new Set([
  "COMBO_POLICY_REQUIRED", "COMBO_POLICY_INVALID", "COMBO_POLICY_UNSUPPORTED",
  "REQUIRED_POLICY_UNSUPPORTED", "REQUIRED_POLICY_ELIGIBILITY_UNKNOWN",
]);

/** These errors terminate a logical request; trying another model cannot repair application failure. */
export function isPolicyOrCancellationError(error) {
  return POLICY_CODES.has(error?.code) || error?.name === "RequiredPolicyError" ||
    error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.code === "ERR_CANCELED";
}

export function requiredPolicyUnsupported(capability, unknown = false) {
  const error = new Error(`Required policy cannot preserve request ${capability}`);
  error.name = "RequiredPolicyError";
  error.code = "COMBO_POLICY_REQUIRED";
  error.reason = unknown ? "REQUIRED_POLICY_ELIGIBILITY_UNKNOWN" : "REQUIRED_POLICY_UNSUPPORTED";
  error.status = 422;
  return error;
}

/** Scan the complete conversation, including nested tool results and older media, without mutation. */
export function policyRequestRequirements(body) {
  const required = new Set();
  const mime = (value) => {
    if (typeof value !== "string") return;
    if (value.startsWith("image/")) required.add("vision");
    else if (value === "application/pdf") required.add("pdf");
    else if (value.startsWith("audio/")) required.add("audioInput");
    else if (value.startsWith("video/")) required.add("videoInput");
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const type = value.type;
    if (["image", "image_url", "input_image"].includes(type) || value.image_url || value.image || value.images?.length) required.add("vision");
    if (["audio", "audio_url", "input_audio"].includes(type) || value.audio_url || value.audio) required.add("audioInput");
    if (["video", "video_url", "input_video"].includes(type)) required.add("videoInput");
    if (["file", "document", "input_file"].includes(type)) required.add("pdf");
    if (["tool_use", "tool_result", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(type) ||
        value.role === "tool" || value.role === "function" || value.tool_calls?.length || value.function_call || value.functionCall || value.functionResponse ||
        value.tools?.length || value.functions?.length || value.functionDeclarations?.length || value.tool_choice) required.add("tools");
    mime(value.mimeType || value.mime_type || value.media_type || value.contentType || value.mediaType);
    for (const [key, child] of Object.entries(value)) {
      // Tool schemas and arguments are data, not conversation modality declarations.
      if (["parameters", "input_schema", "arguments", "tools", "functions", "functionDeclarations"].includes(key)) continue;
      if (key === "input" && !Array.isArray(child)) continue;
      visit(child);
    }
  };
  visit(body);
  return required;
}

const CORE_FORMATS = new Set([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSE, FORMATS.CLAUDE, FORMATS.GEMINI]);

/**
 * Preflight only for required policies. Caller must run before stripping, translation or compression.
 * Unknown custom text/tool routes retain the existing capability floor; false media caps cannot pass
 * because the existing modality adapter would delete those blocks. Context is a conservative UTF-8
 * byte/token estimate (not a tokenizer count), including schemas/history and the policy reserve.
 */
export function assertPolicyEligibility(body, provider, model, sourceFormat, targetFormat) {
  const context = getDispatchContext();
  if (context?.requiredPolicy !== true) return;
  const required = policyRequestRequirements(body);
  const caps = getCapabilitiesForModel(provider, model);
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const strip = getModelStrip(alias, model) || [];
  for (const capability of required) {
    if (caps[capability] !== true ||
        (capability === "vision" && strip.includes("image")) ||
        (capability === "audioInput" && strip.includes("audio")) ||
        (capability === "tools" && getModelType(alias, model) === "tts")) {
      throw requiredPolicyUnsupported(capability);
    }
  }
  const choice = body?.tool_choice;
  if (caps.forcedToolChoice === false && choice && choice !== "auto" && choice !== "none" && choice?.type !== "auto" && choice?.type !== "none") {
    throw requiredPolicyUnsupported("tool choice");
  }
  const formats = getModelSupportedFormats(alias, model);
  if (formats?.length && !formats.includes(targetFormat)) throw requiredPolicyUnsupported("protocol");
  if (sourceFormat !== targetFormat) {
    if (!CORE_FORMATS.has(sourceFormat) || !CORE_FORMATS.has(targetFormat)) {
      throw requiredPolicyUnsupported("protocol", true);
    }
    if (body?.response_format || body?.text?.format || body?.generationConfig?.responseSchema
      || body?.generationConfig?.responseJsonSchema || body?.generationConfig?.responseMimeType) {
      throw requiredPolicyUnsupported("response schema protocol");
    }
    if (sourceFormat === FORMATS.GEMINI) {
      // The Gemini-to-OpenAI bridge cannot carry these native controls/continuity fields.
      if (body.toolConfig || body.safetySettings || body.sessionId
        || Object.keys(body.generationConfig || {}).some(key => !["maxOutputTokens", "temperature", "topP"].includes(key))) {
        throw requiredPolicyUnsupported("Gemini controls protocol");
      }
      if (body.contents?.some(content => content.parts?.some(part => part.thought === true || part.thoughtSignature || part.thought_signature))) {
        throw requiredPolicyUnsupported("Gemini reasoning continuity");
      }
      if (body.contents?.some(content => content.parts?.some(part => part.functionResponse)
        && (content.parts.length !== 1 || Object.hasOwn(content.parts[0].functionResponse, "parts")
          || Object.hasOwn(content.parts[0].functionResponse?.response || {}, "result")))) {
        throw requiredPolicyUnsupported("Gemini tool result protocol");
      }
      if (body.contents?.some(content => content.parts?.some(part => part.fileData
        || (part.inlineData && !part.inlineData.mimeType?.startsWith("image/")))
        || (content.parts?.some(part => part.functionCall) && content.parts.some(part => part.inlineData)))) {
        throw requiredPolicyUnsupported("Gemini multipart protocol");
      }
      if (body.tools?.some(tool => Object.keys(tool).some(key => key !== "functionDeclarations")
        || tool.functionDeclarations?.some(declaration => Object.keys(declaration)
          .some(key => !["name", "description", "parameters"].includes(key))))) {
        throw requiredPolicyUnsupported("Gemini tool declaration protocol");
      }
    }
    const hasCacheMarker = (value) => value && typeof value === "object" &&
      (Object.hasOwn(value, "cache_control") || Object.hasOwn(value, "cachedContent") || Object.hasOwn(value, "cacheControl") ||
        Object.values(value).some(hasCacheMarker));
    if (hasCacheMarker(body)) throw requiredPolicyUnsupported("cache protocol");
    // These continuity fields have no representation outside Responses. Never silently discard them.
    if (body?.previous_response_id || body?.conversation ||
        (Array.isArray(body?.input) && body.input.some((item) => item?.encrypted_content))) {
      throw requiredPolicyUnsupported("protocol continuity");
    }
    const tools = body?.tools || body?.request?.tools || [];
    if (Array.isArray(tools) && tools.some((tool) => tool?.type && tool.type !== "function" && tool.type !== "custom")) {
      throw requiredPolicyUnsupported("built-in tool protocol");
    }
    if (Array.isArray(tools) && tools.some((tool) => tool?.type === "custom" && tool.format)) {
      throw requiredPolicyUnsupported("custom tool protocol");
    }
  }
  let bytes;
  try { bytes = new TextEncoder().encode(JSON.stringify(body)).length; }
  catch { throw requiredPolicyUnsupported("context estimate", true); }
  const policyTokens = context.policyTokenEstimate;
  if (!Number.isFinite(policyTokens) || policyTokens < 0 || !Number.isFinite(caps.contextWindow) || caps.contextWindow <= 0) {
    throw requiredPolicyUnsupported("context estimate", true);
  }
  // One token per serialized UTF-8 byte intentionally overestimates normal text; never shorten history.
  if (bytes + Math.ceil(policyTokens) > caps.contextWindow) throw requiredPolicyUnsupported("context estimate");
}

// A transport may add metadata, but it must not change or remove any client-bearing
// fields. Compare the translated request immediately before and after its executor
// transform; this also covers provider-specific rules without copying their tables.
export function assertPolicyPayloadPreserved(before, after) {
  if (getDispatchContext()?.requiredPolicy !== true) return;
  const preserved = (expected, actual) => {
    if (expected === actual) return true;
    if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") return false;
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => preserved(value, actual[index]));
    }
    if (Array.isArray(actual)) return false;
    return Object.keys(expected).every((key) => Object.hasOwn(actual, key) && preserved(expected[key], actual[key]));
  };
  const fields = ["messages", "input", "contents", "system", "systemInstruction", "instructions", "tools", "functions",
    "tool_choice", "function_call", "toolConfig", "response_format", "text", "reasoning", "reasoning_effort",
    "thinking", "generationConfig", "prompt_cache_key", "cachedContent", "previous_response_id", "conversation"];
  for (const field of fields) {
    if (Object.hasOwn(before || {}, field) && !preserved(before[field], after?.[field])) {
      throw requiredPolicyUnsupported("executor transformation");
    }
  }
}
