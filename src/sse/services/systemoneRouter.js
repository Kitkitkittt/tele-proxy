import { getModelInfo } from "../services/model.js";
import { getProviderCredentials } from "../services/auth.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import { executeGatewayProvider, gatewaySignal } from "@/lib/teleProxy.js";
import { isPolicyOrCancellationError } from "open-sse/services/policyEligibility.js";
import {
  DEFAULT_SYSTEMONE_ROUTER_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  extractPromptState,
  buildChoiceCriteria,
  parseSystemOneRouteAnswer,
} from "open-sse/services/systemoneRouter.js";

/**
 * Dispatch an in-process System One decision evaluation for a combo request.
 * Resolves the configured router model's provider and credentials, sends the choice
 * query with a short timeout, and returns the parsed routing decision.
 *
 * Missing credentials, router timeout, and upstream failures return null so combo
 * dispatch retains standard ordering. Required-policy failures and client cancellation terminate.
 *
 * @param {object} opts
 * @param {object} opts.body - Client request body
 * @param {string[]} opts.models - Combo model candidate array
 * @param {string} [opts.routerModel] - System One router model (defaults to oc/jev-1.13-free)
 * @param {object} [opts.log] - Logger
 * @param {number} [opts.timeoutMs=DEFAULT_SYSTEMONE_TIMEOUT_MS] - Hard ceiling for router evaluation
 * @param {AbortSignal} [opts.signal] - Client cancellation (defaults to the gateway root signal)
 * @returns {Promise<{ choice: string, confidence: number|null, probabilities: Record<string, number>|null } | null>}
 */
export async function resolveSmartChoice({
  body,
  models,
  routerModel = DEFAULT_SYSTEMONE_ROUTER_MODEL,
  log,
  timeoutMs = DEFAULT_SYSTEMONE_TIMEOUT_MS,
  signal = gatewaySignal(),
}) {
  if (!Array.isArray(models) || models.length <= 1) return null;

  const targetModel = (typeof routerModel === "string" && routerModel.trim())
    ? routerModel.trim()
    : DEFAULT_SYSTEMONE_ROUTER_MODEL;

  const state = extractPromptState(body);
  if (!state) {
    log?.debug?.("COMBO", "smart-router: empty prompt state, skipping classification");
    return null;
  }

  const criteria = buildChoiceCriteria(models);
  if (Object.keys(criteria).length === 0) return null;

  try {
    signal?.throwIfAborted();
    const modelInfo = await getModelInfo(targetModel);
    if (!modelInfo?.provider) {
      log?.warn?.("COMBO", `smart-router: unrecognized router model "${targetModel}"`);
      return null;
    }

    const { provider, model } = modelInfo;
    const credentials = await getProviderCredentials(provider, new Set(), model);
    if (!credentials || credentials.allRateLimited) {
      log?.warn?.("COMBO", `smart-router: no credentials available for router provider "${provider}"`);
      return null;
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    const systemoneBody = {
      model,
      state,
      questions: {
        route: {
          type: "choice",
          instructions: "Which of these configured models is the most appropriate for this request?",
          criteria,
        },
      },
    };

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(
      new DOMException(`System One router timed out after ${timeoutMs}ms`, "TimeoutError")
    ), timeoutMs);
    const dispatchSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    try {
      const result = await executeGatewayProvider({
        provider, model, requestedModel: model, connectionId: refreshedCredentials?.connectionId,
        format: "systemone", dispatchRole: "classifier", signal: dispatchSignal,
      }, () => handleSystemoneCore({
        body: systemoneBody,
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        signal: dispatchSignal,
        log,
        onRequestSuccess: () => {},
      }));
      if (!result?.success || !result.response) {
        log?.warn?.("COMBO", `smart-router: evaluation failed (${result?.status || "error"})`);
        return null;
      }
      const json = await result.response.json();
      const route = parseSystemOneRouteAnswer(json);
      if (!route || !route.choice) {
        log?.warn?.("COMBO", "smart-router: response missing valid route choice");
        return null;
      }
      return route;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Client request cancelled", "AbortError");
      if (!timeoutController.signal.aborted || (isPolicyOrCancellationError(error) && error?.name !== "AbortError")) throw error;
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Client request cancelled", "AbortError");
    if (isPolicyOrCancellationError(err)) throw err;
    log?.warn?.("COMBO", `smart-router: evaluation aborted (${err?.message || String(err)})`);
    return null;
  }
}
