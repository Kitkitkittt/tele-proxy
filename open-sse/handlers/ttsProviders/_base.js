// Shared TTS helpers
import { Buffer } from "node:buffer";
import { getDispatchContext, withGenerationDispatch } from "../../services/dispatchContext.js";

// Only synthesis calls use this hook; token, voice, model-list and download fetches do not.
export async function ttsFetch(url, options, wireModel) {
  const context = getDispatchContext();
  if (!context) return fetch(url, options);
  const signal = options?.signal ?? context.signal;
  let model = wireModel;
  if (!model && typeof options?.body === "string" && options.body.startsWith("{")) {
    try {
      const payload = JSON.parse(options.body);
      model = payload.model ?? payload.model_id ?? payload.modelId ?? payload.voice_engine;
    } catch { }
  }
  const { proxyAwareFetch } = await import("../../utils/proxyFetch.js");
  return withGenerationDispatch({ ...(typeof model === "string" ? { requestedModel: model } : {}), signal, policySupported: false, transport: "tts-http" }, () => proxyAwareFetch(url, { ...options, signal }));
}

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Convert upstream Response (binary audio) to { base64, format }
export async function responseToBase64(res, defaultFormat = "mp3") {
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 100) throw new Error("Upstream returned empty audio");
  const ctype = res.headers.get("content-type") || "";
  let format = defaultFormat;
  if (ctype.includes("wav")) format = "wav";
  else if (ctype.includes("mpeg") || ctype.includes("mp3")) format = "mp3";
  else if (ctype.includes("ogg")) format = "ogg";
  else if (ctype.includes("pcm")) format = "pcm";
  return { base64: Buffer.from(buf).toString("base64"), format };
}

export async function throwUpstreamError(res) {
  const text = await res.text().catch(() => "");
  let msg = `Upstream error (${res.status})`;
  try {
    const parsed = JSON.parse(text);
    msg = parsed?.error?.message || parsed?.message || parsed?.detail?.message || (typeof parsed?.detail === "string" ? parsed.detail : null) || text || msg;
  } catch { msg = text || msg; }
  throw new Error(msg);
}

// Parse `model` string as "modelId/voiceId" — match against known model list (longest prefix wins)
export function parseModelVoice(model, defaultModel = "", defaultVoice = "", knownModels = []) {
  if (!model) return { modelId: defaultModel, voiceId: defaultVoice };
  const known = knownModels.map((m) => m.id || m).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of known) {
    if (model === id) return { modelId: id, voiceId: defaultVoice };
    if (model.startsWith(`${id}/`)) return { modelId: id, voiceId: model.slice(id.length + 1) };
  }
  const idx = model.lastIndexOf("/");
  if (idx > 0) return { modelId: model.slice(0, idx), voiceId: model.slice(idx + 1) };
  return { modelId: defaultModel || model, voiceId: defaultVoice || model };
}
