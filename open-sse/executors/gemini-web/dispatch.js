import { assertNativePolicySupported, bindDispatchContext, dispatchGeneration } from "../../services/dispatchContext.js";

/**
 * Gemini's web client submits a message as a POST to its batchexecute RPC.
 * That path is the finest boundary visible without decoding the request
 * payload: quota probes, mode reads and reply streams also use batchexecute,
 * so this matches a POST to batchexecute and nothing more.
 *
 * ponytail: no rpcid discrimination — Google rotates rpcids and we have no
 * captured evidence of which value means "send user turn". Adding a filter on
 * a guessed value would silently stop counting real generations. Upgrade by
 * capturing one live turn's request and asserting request.postData() carries
 * the user prompt.
 *
 * ponytail: the route window closes when the key press resolves. A POST that
 * lands after that goes uncounted, which surfaces as
 * `accounting_completeness = incomplete` rather than a false attempt count.
 * Upgrade by waiting for the first matching request before unroute.
 */
export const GEMINI_GENERATION_PATH = /\/BardChatUi\/data\/batchexecute(?:\?|$)/;

/** Route only around the submit: bootstrap before it and polls after it bypass this. */
export async function dispatchGeminiBrowserGeneration(page, signal, submit) {
  const details = { transport: "browser-gemini", policySupported: false, ...(signal ? { signal } : {}) };
  assertNativePolicySupported(details);
  let dispatchError;
  let accounted = false;
  const handler = bindDispatchContext(async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // Only the first matching POST in this window is the user's send; a poll
    // or stream POST overlapping it must not invent a second attempt.
    if (accounted) return route.continue();
    accounted = true;
    try {
      return await dispatchGeneration(details, () => route.continue());
    } catch (error) {
      dispatchError = error;
      await route.abort("failed").catch(() => {});
    }
  });
  await page.route(GEMINI_GENERATION_PATH, handler);
  try {
    const result = await submit();
    if (dispatchError) throw dispatchError;
    return result;
  } catch (error) {
    throw dispatchError || error;
  } finally {
    await page.unroute(GEMINI_GENERATION_PATH, handler);
  }
}
